import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadConfigFromEnvFile, type PumpEvent } from '@memebot/core';
import { medianLamports } from '@memebot/execution';
import { DatasetBuilder } from '../ml/dataset.ts';
import { ClickHouseReplaySource, loadCostSamples, loadGaps, loadProtocolRows, loadSkeletons, type QueryFn } from '../replay/clickhouse.ts';
import { tokenAffectedByGap } from '../replay/gaps.ts';
import { createReplayClient } from '../replay/load.ts';
import { ProtocolSchedule } from '../replay/schedules.ts';

const C = Date.parse('2026-10-05T18:37:07Z');
const DAY = 86_400_000;
const MARGIN = 27 * 60_000;
const ROOT = 'data/reports/ml-v2-2026-10-07';
const auth = z.object({ test_end_utc: z.string().datetime(), protocol_commit: z.string() }).parse(JSON.parse(readFileSync('data/reports/ml-v2-authorization-2026-10-07.json', 'utf8')));
const T = Date.parse(auth.test_end_utc);
const phase = process.argv[2];
if (phase !== 'development' && phase !== 'test') throw new Error('Expected development or test');
if (phase === 'test' && !existsSync(`${ROOT}/frozen.json`)) throw new Error('Models must be frozen before test access');
const end = phase === 'development' ? C : T;
mkdirSync(ROOT, { recursive: true });
const outPath = `${ROOT}/${phase}.csv`;
if (existsSync(outPath)) throw new Error('Refusing to overwrite an extraction');
const client = createReplayClient(loadConfigFromEnvFile());
const query: QueryFn = async (sql, params) => {
  for (const k of ['to', 'liveTo']) if (typeof params[k] === 'number' && params[k] > end) throw new Error('Query beyond frozen boundary');
  return (await client.query({ query: sql, query_params: params, format: 'JSONEachRow', clickhouse_settings: { readonly: '1', max_threads: 1, max_memory_usage: '500000000', max_bytes_before_external_group_by: '64000000', max_bytes_before_external_sort: '64000000' } })).json<unknown>();
};
const num = z.union([z.number(), z.string()]).transform(Number).pipe(z.number().finite());
const planSchema = z.object({ from: z.number(), validation: z.number(), eligible_mints: z.array(z.string()), train_mints: z.array(z.string()), validation_mints: z.array(z.string()) });

async function run(): Promise<void> {
  let from: number;
  let validation = C;
  let allowed: Set<string>;
  if (phase === 'development') {
    const bounds = z.object({ lo: num }).parse((await query('SELECT toUnixTimestamp64Milli(min(ts)) AS lo FROM events_trade WHERE ts < fromUnixTimestamp64Milli({to:Int64})', { to: C }))[0]);
    from = bounds.lo + DAY; // Fixed full 24h warm-up from the first recorded event.
    const tokens = await loadSkeletons(query, from, C);
    const gaps = await loadGaps(query, from, C);
    const eligible = tokens.filter(t => t.createdAtMs <= C - MARGIN && !tokenAffectedByGap(gaps, t.createdAtMs, 1560));
    const unique = [...new Map(eligible.map(t => [t.mint, t])).values()].sort((a,b) => a.createdAtMs - b.createdAtMs || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    const pivot = unique[Math.floor(.8 * unique.length)];
    if (!pivot) throw new Error('No eligible development tokens');
    validation = pivot.createdAtMs;
    const train = unique.filter(t => t.createdAtMs < validation && t.createdAtMs <= validation - MARGIN);
    const val = unique.filter(t => t.createdAtMs >= validation);
    allowed = new Set([...train, ...val].map(t => t.mint));
    writeFileSync(`${ROOT}/plan.json`, JSON.stringify({ from, validation, end: C, warmup_from: bounds.lo, eligible_mints: unique.map(t => t.mint), train_mints: train.map(t => t.mint), validation_mints: val.map(t => t.mint), gaps, margin_ms: MARGIN, warmup_rule: 'first recorded event + 24h', n_before_partition_purge: unique.length }, null, 2));
  } else {
    from = C;
    const plan = planSchema.parse(JSON.parse(readFileSync(`${ROOT}/plan.json`, 'utf8')));
    const old = new Set(plan.eligible_mints);
    const tokens = await loadSkeletons(query, C, T);
    const gaps = await loadGaps(query, C, T);
    allowed = new Set(tokens.filter(t => t.createdAtMs > C + 729 && t.createdAtMs <= T - MARGIN && !old.has(t.mint) && !tokenAffectedByGap(gaps, t.createdAtMs, 1560)).map(t => t.mint));
    writeFileSync(`${ROOT}/test-access.json`, JSON.stringify({ accessed_at_utc: new Date().toISOString(), end: T, eligible_mints: [...allowed], gaps }, null, 2));
  }
  const protocolRows = await loadProtocolRows(query, end - 1);
  const protocol = new ProtocolSchedule(protocolRows);
  const initial = protocol.initial(from);
  const updates = [...new Set(protocolRows.filter(p => p.tsMs > from).map(p => p.tsMs))].sort((a,b) => a-b);
  let updateIdx = 0;
  const costs = (await loadCostSamples(query, from - DAY, end - 1)).sort((a,b) => a.sampledAtMs-b.sampledAtMs);
  let costLo = 0, costHi = 0;
  let lastCostTime = -Infinity;
  let cached = { priority: 0n, tip: 0n };
  const fallback = { calls: 0, priority: 0, tip: 0 };
  let cachePriorityFallback = false, cacheTipFallback = false;
  const costsAt = (t: number) => {
    if (t < lastCostTime) throw new Error('Nonchronological costs');
    if (t !== lastCostTime) {
      while (costHi < costs.length && (costs[costHi]?.sampledAtMs ?? Infinity) <= t) costHi++;
      while (costLo < costHi && (costs[costLo]?.sampledAtMs ?? Infinity) < t-DAY) costLo++;
      const win = costs.slice(costLo, costHi);
      const tips = win.flatMap(c => c.jitoTip !== null && c.jitoTip > 0n ? [c.jitoTip] : []);
      cachePriorityFallback = win.length === 0; cacheTipFallback = tips.length === 0;
      cached = { priority: win.length ? medianLamports(win.map(c => c.priorityFee)) : 500_000n, tip: tips.length ? medianLamports(tips) : 500_000n };
      lastCostTime = t;
    }
    fallback.calls++; if (cachePriorityFallback) fallback.priority++; if (cacheTipFallback) fallback.tip++;
    return cached;
  };
  const fd = openSync(outPath, 'wx');
  const sha = createHash('sha256');
  let buffer = '', rows = 0, purged = 0;
  let header: string[] | undefined;
  const flush = () => { if (buffer) { writeSync(fd, buffer); sha.update(buffer); buffer = ''; } };
  const builder = new DatasetBuilder({
    curveParams: initial.curveParams, fees: initial.fees, costsAt,
    rentLamports: 1_513_840n, baseFeeLamports: 5_000n, sizeLamports: 50_000_000n, latencyMs: 800,
    tpPct: .4, slPct: .2, horizonMs: 600_000, sampleEveryMs: 15_000, minAgeMs: 30_000, maxAgeMs: 900_000,
    eligible: mint => allowed.has(mint),
    onRow: r => {
      const boundary = phase === 'development' && r.createdAtMs < validation ? validation : end;
      if (r.t + 601_600 >= boundary || r.exitTs >= boundary) { purged++; return; }
      if (!header) {
        header = Object.keys(r.features);
        if (header.length !== 77) throw new Error('Expected 77 features');
        buffer += ['mint','created_at_ms','t_ms',...header,'hit_tp','net_return','exit_reason','hold_sec','entry_cost_lamports','net_pnl_lamports','exit_ts'].join(',')+'\n';
      }
      buffer += [r.mint,r.createdAtMs,r.t,...header.map(k => Number.isFinite(r.features[k]) ? r.features[k] : ''),r.hitTp,r.netReturn,r.exitReason,r.holdSec,r.entryCostLamports,r.netPnlLamports,r.exitTs].join(',')+'\n';
      rows++;
      if (buffer.length > 65536) flush();
    },
  });
  builder.seedSkeletons(await loadSkeletons(query, from-DAY, from));
  let lastTs = -Infinity;
  let reportTs = Date.now();
  const progress = (e: PumpEvent) => {
    if (e.ts < lastTs) throw new Error('Replay timestamps regressed across chunks');
    lastTs = e.ts;
    if (Date.now()-reportTs > 30_000) { console.log(JSON.stringify({ phase, event_utc: new Date(e.ts).toISOString(), rows, rss_mb: Math.round(process.memoryUsage().rss/1048576) })); reportTs = Date.now(); }
  };
  try {
    const warmup = new ClickHouseReplaySource(query, { fromMs: from-DAY, toMs: from, liveCreatedFromMs: from-DAY, liveCreatedToMs: from, allWalletTrades: true });
    await warmup.start(e => { if (e.kind !== 'social_post' && e.kind !== 'tx_cost') { progress(e); builder.seedSmartMoneyEvent(e); } });
    const advance = (t: number) => {
      while (updateIdx < updates.length && (updates[updateIdx] ?? Infinity) <= t) {
        const at = updates[updateIdx]; if (at === undefined) break;
        builder.finish(at-1);
        const p = protocol.due(at);
        if (p?.fees) builder.setFees(p.fees);
        if (p?.curveParams) builder.setCurveParams(p.curveParams);
        updateIdx++;
      }
      builder.finish(t-1);
    };
    const source = new ClickHouseReplaySource(query, { fromMs: from, toMs: end, liveCreatedFromMs: from, liveCreatedToMs: end, allWalletTrades: true });
    await source.start(e => { if (e.kind === 'social_post' || e.kind === 'tx_cost') return; progress(e); advance(e.ts); builder.onEvent(e); }, e => { progress(e); advance(e.ts); builder.seedSmartMoneyEvent(e); });
    advance(end); flush();
    writeFileSync(`${ROOT}/${phase}-manifest.json`, JSON.stringify({ phase, from, end, validation, rows, purged, features: header, sha256: sha.digest('hex'), fallback, initial_global: initial.globalTsMs, initial_fee: initial.feeTsMs, source: source.stats, warmup: warmup.stats, stats: builder.stats }, null, 2));
    console.log(JSON.stringify({ phase, rows, purged, complete: true }));
  } finally { flush(); closeSync(fd); }
}
run().finally(() => client.close()).catch((err: unknown) => { console.error(err); process.exitCode = 1; });
