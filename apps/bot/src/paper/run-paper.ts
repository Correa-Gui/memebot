import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppConfig, Logger } from '@memebot/core';
import { parseCurveInitialParams, parseFeeConfigAccount, worstCaseCurveFees } from '@memebot/curve-math';
import type { CurveFeeBps, CurveInitialParams } from '@memebot/curve-math';
import { estimateTxCosts, seedFromString } from '@memebot/execution';
import type { TxCostEstimate } from '@memebot/execution';
import { LAMPORTS_PER_SIGNATURE, fetchTokenAccountRent } from '@memebot/ingest';
import type { ProtocolConfigSnapshot } from '@memebot/ingest';
import { TelegramNotifier, formatHourlySummary } from '@memebot/monitor';
import type { Recorder } from '@memebot/recorder';
import { DEFAULT_STOP_FILE_PATH, buildEffectiveRiskLimits, isStopFilePresent } from '@memebot/risk';
import { loadStrategyConfig } from '@memebot/strategy';
import { PUMP_FUN_PROGRAM_ID } from '../../../../config/protocol.ts';
import { openRecordingSession, waitForShutdown } from '../recording.ts';
import { PaperClock } from './clock.ts';
import { PaperEngine } from './engine.ts';

export const STRATEGY_CONFIG_PATH = 'config/strategy.v0.yaml';
/** Pré-carga de `token_created` para o filtro de criador (24 h, como a feature). */
const CREATOR_LOOKBACK_HOURS = 24;

/**
 * Adaptador do `pnpm bot --mode=paper`: liga o `PaperEngine` (puro) ao ingest ao vivo, ao
 * ClickHouse (eventos + decisions + fills), ao Telegram e ao log. Entradas externas com fallback:
 * - curva/taxas: leitura on-chain da partida (a mesma gravada em `protocol_config`); se o RPC falhar,
 *   a linha mais recente de `protocol_config`. Sem nenhuma das duas não há como simular → erro.
 * - rent da ATA: `fetchTokenAccountRent` (RPC; fallback = valor observado em tx real gravada).
 * - custos: `tx_costs` das últimas `PAPER_COST_LOOKBACK_HOURS` h, recarregado a cada
 *   `PAPER_COST_RELOAD_MS`; falha de leitura mantém a estimativa anterior (na partida: fallback).
 */

function pick(snaps: readonly ProtocolConfigSnapshot[], accountType: string): unknown {
  const s = snaps.find((x) => x.programId === PUMP_FUN_PROGRAM_ID && x.accountType === accountType);
  return s ? (JSON.parse(s.configJson) as unknown) : null;
}

async function loadProtocolInputs(
  snaps: readonly ProtocolConfigSnapshot[],
  recorder: Recorder,
  log: Logger,
): Promise<{ curveParams: CurveInitialParams; fees: CurveFeeBps; source: string }> {
  let global = pick(snaps, 'Global');
  let feeConfig = pick(snaps, 'FeeConfig');
  let source = 'rpc';
  if (global === null || feeConfig === null) {
    const g = await recorder.loadLatestProtocolConfig(PUMP_FUN_PROGRAM_ID, 'Global');
    const f = await recorder.loadLatestProtocolConfig(PUMP_FUN_PROGRAM_ID, 'FeeConfig');
    if (!g || !f) throw new Error('sem Global/FeeConfig do Pump.fun (RPC falhou e protocol_config vazio): não há como simular a curva');
    global = g.configJson;
    feeConfig = f.configJson;
    source = `protocol_config (Global ${new Date(g.tsMs).toISOString()}, FeeConfig ${new Date(f.tsMs).toISOString()})`;
    log.warn({ source }, 'protocol_config lido do banco (RPC indisponível na partida)');
  }
  return { curveParams: parseCurveInitialParams(global), fees: worstCaseCurveFees(parseFeeConfigAccount(feeConfig)), source };
}

export async function runPaper(cfg: AppConfig, log: Logger): Promise<void> {
  const strategyYaml = readFileSync(STRATEGY_CONFIG_PATH, 'utf8');
  const config = loadStrategyConfig(STRATEGY_CONFIG_PATH);
  const limits = buildEffectiveRiskLimits(config);
  let engine: PaperEngine | null = null;

  const session = await openRecordingSession(cfg, log, {
    mode: 'paper',
    extraConfigHash: createHash('sha256').update(strategyYaml).digest('hex'),
    preflight: async (recorder) => {
      const missing = await recorder.missingFillsColumns();
      if (missing.length > 0) {
        throw new Error(`tabela fills sem as colunas da migração 006 (${missing.join(', ')}): aplique com \`pnpm migrate\` antes do paper`);
      }
    },
    onProtocolConfig: (snaps) => {
      if (!engine) return;
      try {
        const g = pick(snaps, 'Global');
        const f = pick(snaps, 'FeeConfig');
        if (g !== null) engine.setCurveParams(parseCurveInitialParams(g));
        if (f !== null) engine.setFees(worstCaseCurveFees(parseFeeConfigAccount(f)));
      } catch (e) {
        log.error({ err: e instanceof Error ? e.message : String(e) }, 'protocol_config inválido; mantendo os parâmetros anteriores');
      }
    },
  });
  const { runId, recorder, rpc } = session;
  const telegram = new TelegramNotifier({ botToken: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID, logger: log });

  try {
    const protocol = await loadProtocolInputs(session.initialProtocolConfig, recorder, log);
    const rent = await fetchTokenAccountRent(rpc);
    if (rent.source !== 'rpc') log.warn({ err: rent.error, lamports: rent.lamports.toString() }, 'rent por RPC falhou: usando o valor observado em tx real gravada');

    const costParams = {
      minSamples: cfg.PAPER_COST_MIN_SAMPLES,
      fallbackPriorityFeeLamports: cfg.PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS,
      fallbackJitoTipLamports: cfg.PAPER_FALLBACK_JITO_TIP_LAMPORTS,
    };
    const loadCosts = async (): Promise<TxCostEstimate | null> => {
      try {
        return estimateTxCosts(await recorder.loadTxCostSamples(cfg.PAPER_COST_LOOKBACK_HOURS), costParams);
      } catch (e) {
        log.error({ err: e instanceof Error ? e.message : String(e) }, 'falha ao ler tx_costs');
        return null;
      }
    };
    const costs = (await loadCosts()) ?? estimateTxCosts([], costParams);

    const seed = seedFromString(runId);
    const clock = new PaperClock();
    const startMs = clock.nowMs();
    const sinks = {
      decision: (d: Parameters<Recorder['recordDecision']>[0]) => {
        recorder.recordDecision(d);
      },
      fill: (f: Parameters<Recorder['recordFill']>[0]) => {
        recorder.recordFill(f);
        log.info({ decisionId: f.decisionId, mint: f.mint, side: f.side, status: f.status, error: f.error }, 'fill');
      },
      notify: (text: string) => {
        telegram.send(text);
      },
      log,
    };
    const e = new PaperEngine({
      runId, config, limits, curveParams: protocol.curveParams, fees: protocol.fees, costs,
      latencyMs: cfg.PAPER_LATENCY_MS, failRate: cfg.PAPER_FAIL_RATE,
      tokenAccountRentLamports: rent.lamports, baseFeeLamportsPerSignature: LAMPORTS_PER_SIGNATURE,
      seed, startMs, sinks,
    });
    engine = e;
    log.info(
      {
        runId, seed, protocolSource: protocol.source, fees: { protocolBps: protocol.fees.protocolFeeBps.toString(), creatorBps: protocol.fees.creatorFeeBps.toString() },
        rentLamports: rent.lamports.toString(), rentSource: rent.source, baseFeeLamportsPerSignature: LAMPORTS_PER_SIGNATURE.toString(),
        costs: { priority: costs.priorityFeeLamports.toString(), tip: costs.jitoTipLamports.toString(), prioritySource: costs.priorityFeeSource, tipSource: costs.jitoTipSource, samples: costs.prioritySampleCount },
        sizeLamports: limits.sizeLamports.toString(), maxOpenPositions: limits.maxOpenPositions, latencyMs: cfg.PAPER_LATENCY_MS, failRate: cfg.PAPER_FAIL_RATE,
      },
      'paper: parâmetros do run (seed do PRNG derivada do run id)',
    );

    try {
      const created = await recorder.loadRecentTokenCreations(CREATOR_LOOKBACK_HOURS);
      const seeded = e.seedSkeletons(created);
      log.info({ seeded, hours: CREATOR_LOOKBACK_HOURS }, 'token_created pré-carregados (só criador/horário; gravações com RPC público podem ter lacunas)');
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'pré-carga de token_created falhou: filtro de criador começa vazio');
    }

    await session.startIngest((ev) => {
      if (ev.kind !== 'tx_cost') clock.observeEvent(ev.ts);
      e.onEvent(ev, clock.nowMs());
    });

    const timers: ReturnType<typeof setInterval>[] = [];
    timers.push(setInterval(() => {
      try {
        e.setStopFile(isStopFilePresent(DEFAULT_STOP_FILE_PATH));
        e.onTick(clock.nowMs());
      } catch (err) {
        log.error({ err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 'erro no tick do paper');
      }
    }, 1_000));
    timers.push(setInterval(() => {
      void loadCosts().then((c) => {
        if (c) e.setCosts(c);
      });
    }, cfg.PAPER_COST_RELOAD_MS));
    timers.push(setInterval(() => {
      const s = e.takeMinuteStats();
      const c = e.currentCosts;
      log.info(
        {
          openPositions: e.openPositions.length,
          pendingOrders: e.pendingOrders,
          entriesPerMin: s.entries,
          exitsPerMin: s.exits,
          failedEntriesPerMin: s.failedEntries,
          closedOperationsPerMin: s.closedOperations,
          rejectedTokensByReasonPerMin: Object.fromEntries([...s.rejectedMintsByReason].map(([r, m]) => [r, m.size])),
          runNetPnlLamports: e.runNetPnlLamports.toString(),
          costSource: { priority: c.priorityFeeSource, tip: c.jitoTipSource, samples: c.prioritySampleCount, tipSamples: c.tipSampleCount },
          trackedTokens: e.trackedTokens,
        },
        'paper',
      );
    }, 60_000));
    timers.push(setInterval(() => {
      telegram.send(formatHourlySummary(e.takeHourlySummary(clock.nowMs())));
    }, 3_600_000));

    await waitForShutdown(log);
    e.stopEntries();
    for (const t of timers) clearInterval(t);
    log.info(
      {
        openPositions: e.openPositions.map((p) => ({ mint: p.mint, tokenAmount: p.tokenAmount.toString(), entryDecisionId: p.entryDecisionId })),
        pendingOrders: e.pendingOrders,
        runNetPnlLamports: e.runNetPnlLamports.toString(),
      },
      'paper encerrando: sem novas entradas; posições abertas ficam registradas como abertas no run',
    );
  } finally {
    await session.close();
    await telegram.close(5_000);
  }
}
