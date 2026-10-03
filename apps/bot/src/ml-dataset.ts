import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createLogger, loadConfigFromEnvFile } from '@memebot/core';
import { medianLamports } from '@memebot/execution';
import { LAMPORTS_PER_SIGNATURE, OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS } from '@memebot/ingest';
import { ClickHouseReplaySource, loadCostSamples, loadGaps, loadProtocolRows, loadSkeletons, type QueryFn } from './replay/clickhouse.ts';
import { tokenAffectedByGap } from './replay/gaps.ts';
import { createReplayClient } from './replay/load.ts';
import { ProtocolSchedule, type TimedCostSample } from './replay/schedules.ts';
import { DatasetBuilder, type DatasetRow } from './ml/dataset.ts';

/**
 * `pnpm ml:dataset` — gera o dataset de ML (Fase 5) a partir do ClickHouse (ver `ml/dataset.ts`).
 * Blocos contínuos de gravação (`--blocks=from,to;from,to`, ISO UTC); para cada bloco: pré-carga de 24 h de
 * `token_created` (filtro de criador), `protocol_config` vigente, custos = mediana real de `tx_costs` nas
 * `PAPER_COST_LOOKBACK_HOURS` anteriores, lacunas de gravação (tokens afetados na vida + horizonte são
 * excluídos) e só tokens criados até `to − (15 min + 10 min + 2 min)` (horizonte completo dentro do bloco).
 * Saída: CSV (`--out`, padrão data/ml/dataset.csv) com mint, created_at_ms, t_ms, features, rótulos.
 */
const DEFAULT_BLOCKS = '2026-10-01T22:16:24Z,2026-10-02T11:53:08Z';
const SIZE = 50_000_000n;
const MAX_AGE_MS = 15 * 60_000;
const HORIZON_MS = 10 * 60_000;

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { blocks: { type: 'string' }, out: { type: 'string' } }, strict: true });
  const blocks = (values.blocks ?? DEFAULT_BLOCKS).split(';').map((b) => b.split(',').map((x) => Date.parse(x.trim())) as [number, number]);
  const outPath = values.out ?? 'data/ml/dataset.csv';
  const cfg = loadConfigFromEnvFile();
  const log = createLogger({ name: 'ml-dataset' });
  const client = createReplayClient(cfg);
  const query: QueryFn = async (q, params) => (await client.query({ query: q, query_params: params, format: 'JSONEachRow' })).json<unknown>();
  mkdirSync(dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath);
  let header: string[] | null = null;
  const write = (block: number, r: DatasetRow): void => {
    if (!header) {
      header = Object.keys(r.features);
      out.write(['block', 'mint', 'created_at_ms', 't_ms', ...header, 'hit_tp', 'net_return', 'exit_reason', 'hold_sec'].join(',') + '\n');
    }
    const cells = header.map((k) => {
      const v = r.features[k];
      return v === undefined || !Number.isFinite(v) ? '' : String(v);
    });
    out.write([String(block), r.mint, String(r.createdAtMs), String(r.t), ...cells, String(r.hitTp), String(r.netReturn), r.exitReason, String(r.holdSec)].join(',') + '\n');
  };
  try {
    for (const [i, [fromMs, toMs]] of blocks.entries()) {
      const t0 = Date.now();
      const lookbackMs = cfg.PAPER_COST_LOOKBACK_HOURS * 3_600_000;
      const [skeletons, costRows, protocolRows, gaps] = await Promise.all([
        loadSkeletons(query, fromMs - 24 * 3_600_000, fromMs),
        loadCostSamples(query, fromMs - lookbackMs, toMs),
        loadProtocolRows(query, toMs),
        loadGaps(query, fromMs, toMs),
      ]);
      const costs = [...costRows].sort((a, b) => a.sampledAtMs - b.sampledAtMs);
      const cache = new Map<number, { priority: bigint; tip: bigint }>();
      const costsAt = (t: number): { priority: bigint; tip: bigint } => {
        const minute = Math.floor(t / 60_000);
        const hit = cache.get(minute);
        if (hit) return hit;
        const win = costs.filter((c: TimedCostSample) => c.sampledAtMs <= t && c.sampledAtMs >= t - lookbackMs);
        const tips = win.flatMap((c) => (c.jitoTip !== null && c.jitoTip > 0n ? [c.jitoTip] : []));
        const v = {
          priority: win.length > 0 ? medianLamports(win.map((c) => c.priorityFee)) : cfg.PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS,
          tip: tips.length > 0 ? medianLamports(tips) : cfg.PAPER_FALLBACK_JITO_TIP_LAMPORTS,
        };
        cache.set(minute, v);
        return v;
      };
      const protocol = new ProtocolSchedule(protocolRows);
      const initial = protocol.initial(fromMs);
      const lastCreated = toMs - (MAX_AGE_MS + HORIZON_MS + 120_000);
      const builder = new DatasetBuilder({
        curveParams: initial.curveParams, fees: initial.fees, costsAt, rentLamports: OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS,
        baseFeeLamports: LAMPORTS_PER_SIGNATURE, sizeLamports: SIZE, latencyMs: cfg.PAPER_LATENCY_MS, tpPct: 0.4, slPct: 0.2,
        horizonMs: HORIZON_MS, sampleEveryMs: 15_000, minAgeMs: 30_000, maxAgeMs: MAX_AGE_MS,
        eligible: (_m, createdAtMs) => createdAtMs <= lastCreated && !tokenAffectedByGap(gaps, createdAtMs, (MAX_AGE_MS + HORIZON_MS + 60_000) / 1000),
        onRow: (r) => {
          write(i, r);
        },
      });
      builder.seedSkeletons(skeletons);
      const source = new ClickHouseReplaySource(query, { fromMs, toMs, liveCreatedFromMs: fromMs, liveCreatedToMs: toMs });
      await source.start((e) => {
        if (e.kind === 'social_post' || e.kind === 'tx_cost') return;
        const p = protocol.due(e.ts);
        if (p?.fees) builder.setFees(p.fees);
        if (p?.curveParams) builder.setCurveParams(p.curveParams);
        builder.onEvent(e);
      });
      builder.finish(toMs);
      log.info({ block: i, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), gaps: gaps.length, ...builder.stats, sec: Math.round((Date.now() - t0) / 1000) }, 'bloco concluído');
    }
  } finally {
    await new Promise<void>((r) => out.end(r));
    await client.close();
  }
  console.log(`dataset: ${outPath}`);
}

main().then(() => process.exit(0), (e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
