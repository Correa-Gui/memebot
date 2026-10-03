import { readFileSync } from 'node:fs';
import { ClickHouseLogLevel, createClient, type ClickHouseClient } from '@clickhouse/client';
import { basename } from 'node:path';
import type { AppConfig } from '@memebot/core';
import { OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS } from '@memebot/ingest';
import { Recorder } from '@memebot/recorder';
import type { Logger } from '@memebot/core';
import { loadStrategyConfig } from '@memebot/strategy';
import { gitCommit, idlHash } from '../run-info.ts';
import { ClickHouseReplaySource, loadCostSamples, loadGaps, loadProtocolRows, loadSkeletons, type QueryFn } from './clickhouse.ts';
import type { Interval } from './gaps.ts';
import { executeReplay, type ReplayParams, type ReplayResult, type ReplayVariant } from './run.ts';

/** Cliente do ClickHouse para leituras longas do replay (sem avisos de socket ocioso no stdout). */
export function createReplayClient(cfg: AppConfig): ClickHouseClient {
  return createClient({
    url: cfg.CLICKHOUSE_URL, username: cfg.CLICKHOUSE_USER, password: cfg.CLICKHOUSE_PASSWORD, database: cfg.CLICKHOUSE_DB,
    request_timeout: 120_000, keep_alive: { eagerly_destroy_stale_sockets: true }, log: { level: ClickHouseLogLevel.ERROR },
  });
}

/** Pré-carga de `token_created` (mesma janela do paper ao vivo, `CREATOR_LOOKBACK_HOURS` em run-paper.ts). */
export const CREATOR_LOOKBACK_MS = 24 * 3_600_000;

export function loadVariant(path: string, label?: string): ReplayVariant {
  return { label: label ?? basename(path).replace(/\.ya?ml$/, '').replace(/^strategy\./, ''), config: loadStrategyConfig(path), configText: readFileSync(path, 'utf8') };
}

/** Parâmetros do replay com os mesmos valores do paper (`.env` via `AppConfig`), sobrescrevíveis. */
export function paramsFromConfig(cfg: AppConfig, p: Pick<ReplayParams, 'fromMs' | 'entriesUntilMs' | 'drainMs' | 'seed' | 'killSwitchEnabled' | 'excludeGapTokens'> & Partial<ReplayParams>): ReplayParams {
  return {
    latencyMs: cfg.PAPER_LATENCY_MS,
    failRate: cfg.PAPER_FAIL_RATE,
    // rent: o valor observado em tx real gravada (= o que o RPC devolveu no paper de 02/10: 1.513.840 no log do run)
    rentLamports: OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS,
    costParams: { minSamples: cfg.PAPER_COST_MIN_SAMPLES, fallbackPriorityFeeLamports: cfg.PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS, fallbackJitoTipLamports: cfg.PAPER_FALLBACK_JITO_TIP_LAMPORTS },
    costLookbackMs: cfg.PAPER_COST_LOOKBACK_HOURS * 3_600_000,
    costReloadMs: cfg.PAPER_COST_RELOAD_MS,
    ...p,
  };
}

export interface PeriodRun {
  result: ReplayResult;
  gaps: Interval[];
  source: ClickHouseReplaySource;
  loadMs: number;
  runMs: number;
}

/** Carrega as entradas de um período no ClickHouse e roda todas as variantes numa passada. */
export async function runPeriod(query: QueryFn, variants: readonly ReplayVariant[], params: ReplayParams, log: Logger): Promise<PeriodRun> {
  const t0 = Date.now();
  const endMs = params.entriesUntilMs + params.drainMs;
  const maxAgeMs = Math.max(...variants.map((v) => v.config.entry.maxAgeSec)) * 1000;
  const [skeletons, costSamples, protocolRows, gaps] = await Promise.all([
    loadSkeletons(query, params.fromMs - (params.creatorPreloadMs ?? CREATOR_LOOKBACK_MS), params.fromMs),
    loadCostSamples(query, params.fromMs - params.costLookbackMs, endMs),
    loadProtocolRows(query, endMs),
    loadGaps(query, params.fromMs, params.entriesUntilMs + maxAgeMs),
  ]);
  const source = new ClickHouseReplaySource(query, { fromMs: params.fromMs, toMs: endMs, liveCreatedFromMs: params.fromMs, liveCreatedToMs: params.entriesUntilMs });
  const t1 = Date.now();
  log.info({ skeletons: skeletons.length, costSamples: costSamples.length, protocolRows: protocolRows.length, gaps: gaps.length, variants: variants.map((v) => v.label) }, 'replay: entradas carregadas');
  const result = await executeReplay({ source, skeletons, costSamples, protocolRows, gaps }, variants, params);
  return { result, gaps, source, loadMs: t1 - t0, runMs: Date.now() - t1 };
}

/**
 * Grava um run de replay em `runs` (mode `replay`, `config_hash`, `git_commit`) + `decisions`/`fills` com o
 * run id próprio — `pnpm report --run=<id>` funciona igual ao paper. Não regrava um run id existente.
 */
export async function writeReplayRun(
  cfg: AppConfig,
  query: QueryFn,
  run: ReplayResult['variants'][number],
  startedAtMs: number,
  log: Logger,
): Promise<'written' | 'exists'> {
  const exists = await query('SELECT count() AS c FROM runs WHERE run_id = {runId:String}', { runId: run.runId });
  if (Number((exists[0] as { c?: unknown } | undefined)?.c ?? 0) > 0) return 'exists';
  const recorder = new Recorder({ url: cfg.CLICKHOUSE_URL, username: cfg.CLICKHOUSE_USER, password: cfg.CLICKHOUSE_PASSWORD, database: cfg.CLICKHOUSE_DB, runId: run.runId, logger: log, now: () => startedAtMs });
  await recorder.start();
  try {
    await recorder.recordRun({ mode: 'replay', configHash: run.configHash, gitCommit: gitCommit(), idlHash: idlHash(), quality: 'production' });
    for (const d of run.decisions) recorder.recordDecision(d);
    for (const f of run.fills) recorder.recordFill(f);
  } finally {
    await recorder.stop();
  }
  return 'written';
}
