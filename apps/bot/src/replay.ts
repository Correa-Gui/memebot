import { parseArgs } from 'node:util';
import { createLogger, loadConfigFromEnvFile } from '@memebot/core';
import { seedFromString } from '@memebot/execution';
import { compareEntries } from './replay/compare.ts';
import type { QueryFn } from './replay/clickhouse.ts';
import { createReplayClient, loadVariant, paramsFromConfig, runPeriod, writeReplayRun } from './replay/load.ts';
import { formatSummaryLine, summarizeVariant, toReportDecision, toReportFill } from './replay/summary.ts';
import { parseDecisionRows, parseFillRows } from './report/rows.ts';

/**
 * `pnpm replay --from=<ISO> --to=<ISO> [--config=<yaml> ...] [opções]` — replay determinístico (Fase 4) de
 * eventos gravados no ClickHouse com o MESMO `PaperEngine` do paper ao vivo (sem Telegram, sinks em
 * memória). Imprime o resumo de cada config; `--write` grava runs/decisions/fills (mode `replay`) para
 * `pnpm report --run=<id>`; `--compare-run=<paper run id>` compara as entradas com o paper real.
 *
 * Opções: --seed=<n> | --seed-from-run=<run id> (padrão 1) · --kill-switch=on|off (padrão on) ·
 * --exclude-gaps=on|off (padrão off) · --drain-min=<n> (padrão 30) · --latency-ms / --fail-rate (padrão: .env) ·
 * --clock=event|paper-wall (padrão event; paper-wall emula o PaperClock com o received_at gravado).
 */

const brt = (ms: number): string => `${new Date(ms - 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')} BRT (${new Date(ms).toISOString().slice(11, 19)} UTC)`;
const sol = (v: bigint | number | null): string => (v === null ? 'n/d' : (Number(v) / 1e9).toFixed(6));

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      from: { type: 'string' }, to: { type: 'string' }, config: { type: 'string', multiple: true }, seed: { type: 'string' }, 'seed-from-run': { type: 'string' },
      'kill-switch': { type: 'string' }, 'exclude-gaps': { type: 'string' }, 'drain-min': { type: 'string' }, 'latency-ms': { type: 'string' },
      'fail-rate': { type: 'string' }, write: { type: 'boolean' }, 'compare-run': { type: 'string' }, 'compare-tolerance-s': { type: 'string' }, clock: { type: 'string' },
    },
    strict: true,
  });
  if (!values.from || !values.to) throw new Error('uso: pnpm replay --from=<ISO> --to=<ISO> [--config=config/strategy.v0.yaml] [--seed-from-run=<id>] [--kill-switch=on|off] [--write] [--compare-run=<id>]');
  const fromMs = Date.parse(values.from);
  const toMs = Date.parse(values.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error('--from/--to inválidos');
  const onOff = (v: string | undefined, dflt: boolean): boolean => (v === undefined ? dflt : v === 'on');
  const seed = values['seed-from-run'] ? seedFromString(values['seed-from-run']) : Number(values.seed ?? '1');

  const cfg = loadConfigFromEnvFile();
  const log = createLogger({ name: 'replay' });
  const client = createReplayClient(cfg);
  const query: QueryFn = async (q, params) => (await client.query({ query: q, query_params: params, format: 'JSONEachRow' })).json<unknown>();
  try {
    const variants = (values.config ?? ['config/strategy.v0.yaml']).map((p) => loadVariant(p));
    const params = paramsFromConfig(cfg, {
      fromMs, entriesUntilMs: toMs, drainMs: Number(values['drain-min'] ?? '30') * 60_000, seed,
      killSwitchEnabled: onOff(values['kill-switch'], true), excludeGapTokens: onOff(values['exclude-gaps'], false),
      ...(values['latency-ms'] ? { latencyMs: Number(values['latency-ms']) } : {}),
      ...(values['fail-rate'] ? { failRate: Number(values['fail-rate']) } : {}),
      ...(values.clock === 'paper-wall' ? { clockMode: 'paper_wall' as const } : {}),
    });
    const period = await runPeriod(query, variants, params, log);
    const r = period.result;
    console.log(`Replay ${brt(fromMs)} → ${brt(toMs)} (entradas); eventos até ${brt(r.endMs)}`);
    console.log(`seed ${String(seed)} · latência ${String(params.latencyMs)} ms · falha ${String(params.failRate)} · kill switch ${params.killSwitchEnabled ? 'ligado' : 'DESLIGADO'} · tokens com lacuna ${params.excludeGapTokens ? 'excluídos' : 'incluídos'} · relógio ${params.clockMode ?? 'event'}`);
    console.log(`eventos ${String(r.driver.events)} (${JSON.stringify(period.source.stats.byKind)}; duplicatas removidas ${String(period.source.stats.duplicates)}) · ticks ${String(r.driver.ticks)} · esqueletos pré-carregados ${String(r.seededSkeletons)} · tokens excluídos por lacuna ${String(r.driver.excludedTokens)}`);
    console.log(`lacunas detectadas: ${period.gaps.map((g) => `${brt(g.fromMs)}–${new Date(g.toMs).toISOString().slice(11, 19)} UTC`).join('; ') || 'nenhuma'}`);
    console.log(`protocol_config: Global de ${new Date(r.protocol.globalTsMs).toISOString()}, FeeConfig de ${new Date(r.protocol.feeTsMs).toISOString()} · carga ${String(period.loadMs)} ms · execução ${String(period.runMs)} ms`);
    for (const v of r.variants) {
      const s = summarizeVariant(v, period.gaps);
      console.log(`\n[${v.label}] run ${v.runId}\n  ${formatSummaryLine(s)}\n  enters ${String(s.enters)} · saídas ${s.exitReasons.map((x) => `${x.reason}=${String(x.count)}`).join(' ')} · erros do engine ${String(v.engineErrors)} · abertas no fim ${String(v.openPositionsAtEnd)}`);
      if (values.write) console.log(`  gravação: ${await writeReplayRun(cfg, query, v, fromMs, log)}`);
    }

    const compareRun = values['compare-run'];
    const first = r.variants[0];
    if (compareRun && first) {
      const decisions = parseDecisionRows(await query('SELECT toUnixTimestamp64Milli(ts) AS ts_ms, decision_id, mint, type, reason, features_json FROM decisions WHERE run_id = {runId:String} ORDER BY ts', { runId: compareRun }));
      const fills = parseFillRows(await query(
        'SELECT toUnixTimestamp64Milli(ts) AS ts_ms, decision_id, mint, side, status, sol_in, sol_out, token_delta, protocol_fee, creator_fee, priority_fee, jito_tip, base_fee, rent, rent_refund, ' +
          'expected_price_lamports_per_unit, realized_price_lamports_per_unit, venue_unverified, cost_estimate_source, priority_fee_source, jito_tip_source, virtual_quote_before, virtual_token_before ' +
          'FROM fills WHERE run_id = {runId:String} ORDER BY ts',
        { runId: compareRun },
      ));
      const cmp = compareEntries({ decisions: decisions.decisions, fills }, { decisions: first.decisions.map(toReportDecision), fills: first.fills.map(toReportFill) }, Number(values['compare-tolerance-s'] ?? '10') * 1000);
      const sum = (xs: (bigint | null)[]): bigint => xs.reduce<bigint>((a, b) => a + (b ?? 0n), 0n);
      console.log(`\n== Replay [${first.label}] × paper ${compareRun} (tolerância ${String(cmp.toleranceMs / 1000)} s) ==`);
      console.log(`entradas: paper ${String(cmp.paperEnters)} · replay ${String(cmp.replayEnters)} · em comum ${String(cmp.matched.length)} · só no paper ${String(cmp.onlyPaper.length)} · só no replay ${String(cmp.onlyReplay.length)}`);
      console.log(`PnL líquido das operações em comum: paper ${sol(sum(cmp.matched.map((m) => m.paperNetLamports)))} · replay ${sol(sum(cmp.matched.map((m) => m.replayNetLamports)))} SOL`);
      console.log(`PnL líquido das só no paper: ${sol(sum(cmp.onlyPaper.map((m) => m.netLamports)))} · só no replay: ${sol(sum(cmp.onlyReplay.map((m) => m.netLamports)))} SOL`);
      const both = cmp.matched.filter((m) => m.paperNetLamports !== null && m.replayNetLamports !== null);
      const identical = both.filter((m) => m.paperNetLamports === m.replayNetLamports).length;
      const near = both.filter((m) => {
        const d = (m.paperNetLamports ?? 0n) - (m.replayNetLamports ?? 0n);
        return (d < 0n ? -d : d) <= 1_000_000n;
      }).length;
      console.log(`em comum com as DUAS operações fechadas: ${String(both.length)} · PnL paper ${sol(sum(both.map((m) => m.paperNetLamports)))} · replay ${sol(sum(both.map((m) => m.replayNetLamports)))} SOL · idênticas ao lamport ${String(identical)} · |Δ| ≤ 0,001 SOL ${String(near)}`);
      console.log(`em comum com só um lado executado (o outro: entrada falhou/expirou): ${String(cmp.matched.length - both.length)}`);
      const firstKill = (ds: readonly { ts: number; reason: string }[]): string => {
        const k = ds.find((d) => d.reason.startsWith('kill_switch'));
        return k ? `${brt(k.ts)} (${k.reason})` : 'nunca';
      };
      console.log(`kill switch: paper ${firstKill(decisions.decisions)} · replay ${firstKill(first.decisions)}`);
      const sameExit = cmp.matched.filter((m) => m.paperExit === m.replayExit).length;
      const dts = cmp.matched.map((m) => (m.replayTs - m.paperTs) / 1000).sort((a, b) => a - b);
      console.log(`em comum com o mesmo motivo de saída: ${String(sameExit)} de ${String(cmp.matched.length)} · Δt replay − paper (s): mín ${String(dts[0] ?? 'n/d')} mediana ${String(dts[Math.floor(dts.length / 2)] ?? 'n/d')} máx ${String(dts.at(-1) ?? 'n/d')}`);
      console.log('só no paper — o que o replay fez com o mint:');
      for (const w of cmp.onlyPaperWhy) console.log(`  ${String(w.count).padStart(4)}  ${w.why}`);
      console.log('só no replay — o que o paper fez com o mint:');
      for (const w of cmp.onlyReplayWhy) console.log(`  ${String(w.count).padStart(4)}  ${w.why}`);
      console.log('\nmint                                          paper (BRT)          replay Δs  saída paper / replay            PnL paper / replay (SOL)');
      for (const m of cmp.matched) {
        console.log(`${m.mint.padEnd(46)}${brt(m.paperTs).slice(11, 19)}  ${String(Math.round((m.replayTs - m.paperTs) / 1000)).padStart(9)}  ${`${m.paperExit ?? '-'} / ${m.replayExit ?? '-'}`.padEnd(32)}${sol(m.paperNetLamports)} / ${sol(m.replayNetLamports)}`);
      }
    }
  } finally {
    await client.close();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
