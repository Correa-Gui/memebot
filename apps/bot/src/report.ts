import { parseArgs } from 'node:util';
import { createClient } from '@clickhouse/client';
import { loadConfigFromEnvFile } from '@memebot/core';
import type { CurveFeeBps } from '@memebot/curve-math';
import { HARD_LIMITS, buildEffectiveRiskLimits, solToLamports } from '@memebot/risk';
import { loadStrategyConfig } from '@memebot/strategy';
import { computeReport, realMedianCostsFrom, runEndMs } from './report/compute.ts';
import { formatReportJson, formatReportText } from './report/format.ts';
import { parseCostRows, parseDecisionRows, parseFillRows, parseGapRows, parseRunHealthRow, parseRunRow } from './report/rows.ts';

/**
 * `pnpm report --run=<id> [--json] [--config=config/strategy.v0.yaml]`
 * Lê `runs`/`decisions`/`fills` do ClickHouse e imprime o relatório (cálculo puro em report/compute.ts).
 * Taxas da curva para a sensibilidade: as gravadas no snapshot de features do primeiro `enter` do run
 * (`protocolFeeBps`/`creatorFeeBps`); sem enter, não há operação a recalcular.
 * Capital alocado (drawdown %) = maxOpenPositions × sizing.sizeSol da config passada (padrão: a atual).
 */

export const SENSITIVITY_SIZES_SOL = [0.05, 0.1, 0.25, 0.5];

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { run: { type: 'string' }, json: { type: 'boolean' }, config: { type: 'string' } },
    strict: true,
  });
  const runId = values.run;
  if (!runId) throw new Error('uso: pnpm report --run=<run_id> [--json] [--config=config/strategy.v0.yaml]');
  const cfg = loadConfigFromEnvFile();
  const strategy = loadStrategyConfig(values.config ?? 'config/strategy.v0.yaml');
  const limits = buildEffectiveRiskLimits(strategy);

  const client = createClient({ url: cfg.CLICKHOUSE_URL, username: cfg.CLICKHOUSE_USER, password: cfg.CLICKHOUSE_PASSWORD, database: cfg.CLICKHOUSE_DB, request_timeout: 60_000 });
  try {
    const q = async (query: string, extra: Record<string, unknown> = {}): Promise<unknown[]> => {
      const rs = await client.query({ query, query_params: { runId, ...extra }, format: 'JSONEachRow' });
      return rs.json<unknown>();
    };
    const runRows = await q('SELECT run_id, mode, toUnixTimestamp64Milli(started_at) AS started_ms FROM runs WHERE run_id = {runId:String} LIMIT 1');
    const run = runRows.length > 0 ? parseRunRow(runRows[0]) : null;
    if (!run) throw new Error(`run ${runId} não encontrado em runs`);
    const decisions = parseDecisionRows(
      await q('SELECT toUnixTimestamp64Milli(ts) AS ts_ms, decision_id, mint, type, reason, features_json FROM decisions WHERE run_id = {runId:String} ORDER BY ts'),
    );
    const fills = parseFillRows(
      await q(
        'SELECT toUnixTimestamp64Milli(ts) AS ts_ms, decision_id, mint, side, status, sol_in, sol_out, token_delta, protocol_fee, creator_fee, ' +
          'priority_fee, jito_tip, base_fee, rent, rent_refund, expected_price_lamports_per_unit, realized_price_lamports_per_unit, ' +
          'venue_unverified, cost_estimate_source, priority_fee_source, jito_tip_source, virtual_quote_before, virtual_token_before ' +
          'FROM fills WHERE run_id = {runId:String} ORDER BY ts',
      ),
    );
    const endMs = runEndMs({ decisions: decisions.decisions, fills, startedAtMs: run.startedMs });
    const gaps = parseGapRows(
      await q("SELECT toUnixTimestamp64Milli(detected_at) AS detected_ms, duration_ms, detail FROM ingest_gaps WHERE run_id = {runId:String} AND kind = 'reconnect' ORDER BY detected_at"),
    );
    const healthRows = await q('SELECT uptime_ms, stream_gap_ms FROM v_run_quality WHERE run_id = {runId:String}');
    const runHealth = healthRows.length > 0 ? parseRunHealthRow(healthRows[0]) : null;
    // mediana real: todas as amostras de tx_costs gravadas até o fim do run
    const costSamples = parseCostRows(
      await q('SELECT priority_fee, jito_tip FROM tx_costs WHERE sampled_at <= fromUnixTimestamp64Milli({endMs:Int64})', { endMs }),
    );
    const realMedianCosts = realMedianCostsFrom(costSamples, limits);
    const firstEnter = decisions.decisions.find((d) => d.type === 'enter');
    const feeFeatures = firstEnter ? decisions.features.get(firstEnter.decisionId) : undefined;
    const fees: CurveFeeBps = {
      protocolFeeBps: BigInt(Math.round(Number(feeFeatures?.['protocolFeeBps'] ?? 0))),
      creatorFeeBps: BigInt(Math.round(Number(feeFeatures?.['creatorFeeBps'] ?? 0))),
    };
    const result = computeReport({
      runId,
      mode: run.mode,
      startedAtMs: run.startedMs,
      decisions: decisions.decisions,
      fills,
      fees,
      sizeLamports: limits.sizeLamports,
      maxOpenPositions: limits.maxOpenPositions,
      hardLimitPositionLamports: HARD_LIMITS.maxPositionLamports,
      sensitivitySizesLamports: SENSITIVITY_SIZES_SOL.map((s) => solToLamports(s, 'sensitivity')),
      stopLossPct: strategy.exits.stopLossPct,
      gaps,
      runHealth,
      realMedianCosts,
    });
    console.log(values.json ? formatReportJson(result) : formatReportText(result));
  } finally {
    await client.close();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
