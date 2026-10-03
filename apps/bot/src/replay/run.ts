import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@memebot/core';
import type { EventSource } from '@memebot/core';
import type { Fill, TxCostEstimateParams } from '@memebot/execution';
import { LAMPORTS_PER_SIGNATURE } from '@memebot/ingest';
import type { DecisionRecord } from '@memebot/recorder';
import { buildEffectiveRiskLimits } from '@memebot/risk';
import type { TokenSkeleton } from '@memebot/state';
import type { StrategyV0Config } from '@memebot/strategy';
import { PaperEngine } from '../paper/engine.ts';
import { ReplayDriver, type ReplayDriverStats } from './driver.ts';
import { tokenAffectedByGap, type Interval } from './gaps.ts';
import type { ReplayEvent } from './order.ts';
import { CostSchedule, ProtocolSchedule, SolUsdSchedule, type ProtocolRow, type SolUsdCandle, type TimedCostSample } from './schedules.ts';

/**
 * Execução de um replay (Fase 4) sobre entradas já carregadas — sem banco: o `EventSource` é injetado
 * (ClickHouse no CLI, lista em memória nos testes). Várias variantes de config rodam na MESMA passada
 * de eventos, cada uma com o seu `PaperEngine` (estado, executor, risco, PRNG e sinks em memória).
 */

export interface ReplayVariant {
  label: string;
  config: StrategyV0Config;
  /** Texto da config (entra no hash/run id: config versionada). */
  configText: string;
}

export interface ReplayParams {
  /** Início do período: relógio, primeiro tick, risco e pré-carga de 24 h ancorados aqui. */
  fromMs: number;
  /** Fim das ENTRADAS (exclusivo); depois disso só saídas, até `drainMs` ou até não haver posição. */
  entriesUntilMs: number;
  /** Tempo de eventos depois de `entriesUntilMs` para fechar as posições abertas (padrão 30 min). */
  drainMs: number;
  /** Seed do PRNG das falhas simuladas (mesma seed + mesmos eventos ⇒ mesmos fills). */
  seed: number;
  latencyMs: number;
  failRate: number;
  /** Kill switch nas entradas (padrão ligado, como no paper). Desligado só para pesquisa de hipóteses. */
  killSwitchEnabled: boolean;
  /** Tokens com lacuna de gravação na janela de avaliação ficam inelegíveis. */
  excludeGapTokens: boolean;
  /** Rent da conta de token (valor observado/registrado). */
  rentLamports: bigint;
  costParams: TxCostEstimateParams;
  costLookbackMs: number;
  costReloadMs: number;
  /**
   * Relógio do replay: `event` (padrão, determinístico pelo ts on-chain) ou `paper_wall` (emula o PaperClock
   * do paper ao vivo com o received_at gravado — só para reproduzir/explicar um run de paper).
   */
  clockMode?: 'event' | 'paper_wall';
  /**
   * Aquecimento só de estado: tokens criados antes deste instante (padrão `fromMs`) nunca são elegíveis — os eventos
   * deles entram no estado (filtro de criador, compactação), mas o engine não os avalia. Usado no sweep para o período
   * de ajuste (começo dos dados) ter o mesmo histórico de criadores que o de validação.
   */
  eligibleFromMs?: number;
  /** Janela da pré-carga de `token_created` antes de `fromMs` (padrão 24 h, como o paper). */
  creatorPreloadMs?: number;
  /**
   * Universo GRADUADO (experimento de 2026-10-03): libera a simulação do PumpSwap no executor/risco dos
   * engines, carrega os trades do PumpSwap dos tokens graduados no período (com `swapDetails`) e bloqueia
   * entradas antes de `eligibleFromMs`. Ausente = replay da curva exatamente como antes.
   */
  pumpSwapEnabled?: boolean;
}

export interface ReplayInputs {
  source: EventSource;
  /** `token_created` das 24 h antes de `fromMs` (pré-carga do filtro de criador, como o paper). */
  skeletons: readonly TokenSkeleton[];
  costSamples: readonly TimedCostSample[];
  protocolRows: readonly ProtocolRow[];
  gaps: readonly Interval[];
  /** Velas SOL/US$ (só o universo graduado com filtro de market cap usa). */
  solUsd?: readonly SolUsdCandle[];
}

export interface VariantRun {
  label: string;
  runId: string;
  configHash: string;
  config: StrategyV0Config;
  decisions: DecisionRecord[];
  fills: Fill[];
  /** Linhas de log de erro do engine (ex.: executor recusou ordem). */
  engineErrors: number;
  openPositionsAtEnd: number;
}

export interface ReplayResult {
  params: ReplayParams;
  variants: VariantRun[];
  driver: ReplayDriverStats;
  protocol: { globalTsMs: number; feeTsMs: number };
  seededSkeletons: number;
  /** Tokens criados no aquecimento (antes de `eligibleFromMs`): só estado, nunca avaliados. */
  warmupTokens: number;
  /** Fim real dos eventos processados (o replay para cedo se não houver mais posição depois do fim das entradas). */
  endMs: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function paramsKey(p: ReplayParams): string {
  return JSON.stringify(p, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Hash da config da variante + parâmetros do replay (vai para `runs.config_hash`). */
export function replayConfigHash(v: ReplayVariant, p: ReplayParams): string {
  return sha256(`${v.configText}\n${paramsKey(p)}`);
}

/** Run id determinístico: `replay-<rótulo>-<início ISO compacto>-<hash 8>`. */
export function replayRunId(v: ReplayVariant, p: ReplayParams): string {
  const iso = new Date(p.fromMs).toISOString().replace(/[:.]/g, '-');
  return `replay-${v.label}-${iso}-${replayConfigHash(v, p).slice(0, 8)}`;
}

export async function executeReplay(inputs: ReplayInputs, variants: readonly ReplayVariant[], params: ReplayParams): Promise<ReplayResult> {
  const protocol = new ProtocolSchedule(inputs.protocolRows);
  const initial = protocol.initial(params.fromMs);
  const costs = new CostSchedule(inputs.costSamples, params.costParams, params.costLookbackMs, params.costReloadMs, params.fromMs);
  const initialCosts = costs.estimateAt(params.fromMs);

  const runs = variants.map((v) => {
    const runId = replayRunId(v, params);
    const decisions: DecisionRecord[] = [];
    const fills: Fill[] = [];
    const counter = { errors: 0 };
    // log do engine: só conta erros (o replay não imprime linha por evento)
    const log = createLogger({
      name: `replay-${v.label}`,
      level: 'error',
      destination: new Writable({ write: (_c, _e, cb) => { counter.errors++; cb(); } }),
    });
    const engine = new PaperEngine({
      runId, config: v.config, limits: buildEffectiveRiskLimits(v.config), curveParams: initial.curveParams, fees: initial.fees,
      costs: initialCosts, latencyMs: params.latencyMs, failRate: params.failRate, tokenAccountRentLamports: params.rentLamports,
      baseFeeLamportsPerSignature: LAMPORTS_PER_SIGNATURE, seed: params.seed, startMs: params.fromMs,
      sinks: { decision: (d) => decisions.push(d), fill: (f) => fills.push(f), notify: () => undefined, log },
      tradeAlerts: false, killSwitchEnabled: params.killSwitchEnabled,
      ...(params.pumpSwapEnabled === true ? { pumpSwapEnabled: true, entriesFromMs: params.eligibleFromMs ?? params.fromMs } : {}),
    });
    return { label: v.label, runId, configHash: replayConfigHash(v, params), config: v.config, decisions, fills, engine, counter };
  });

  let seeded = 0;
  for (const r of runs) seeded = r.engine.seedSkeletons(inputs.skeletons);

  const maxAgeSec = Math.max(...variants.map((v) => v.config.entry.maxAgeSec));
  const eligibleFromMs = params.eligibleFromMs ?? params.fromMs;
  let warmupTokens = 0;
  const driver = new ReplayDriver({
    engines: runs.map((r) => r.engine),
    fromMs: params.fromMs,
    entriesUntilMs: params.entriesUntilMs,
    costs,
    protocol,
    clockMode: params.clockMode ?? 'event',
    ...(inputs.solUsd ? { solUsd: new SolUsdSchedule(inputs.solUsd) } : {}),
    excludeToken: (_mint: string, createdAtMs: number) => {
      if (createdAtMs < eligibleFromMs) {
        warmupTokens++;
        return true;
      }
      return params.excludeGapTokens && tokenAffectedByGap(inputs.gaps, createdAtMs, maxAgeSec);
    },
  });
  const hardEnd = params.entriesUntilMs + params.drainMs;
  await inputs.source.start((e) => {
    if (e.kind === 'tx_cost' || e.kind === 'social_post') return;
    const ev: ReplayEvent = e;
    if (ev.ts >= hardEnd || driver.idle) {
      void inputs.source.stop();
      return;
    }
    driver.onEvent(ev);
  });
  // vence as ordens já submetidas (latência) sem inventar eventos: só ticks até 2 s depois do último evento
  const endMs = driver.clock.nowMs();
  driver.advanceTo(endMs + 2_000);

  return {
    params,
    variants: runs.map(({ engine, counter, ...r }): VariantRun => ({ ...r, engineErrors: counter.errors, openPositionsAtEnd: engine.openPositions.length })),
    driver: driver.stats,
    protocol: { globalTsMs: initial.globalTsMs, feeTsMs: initial.feeTsMs },
    seededSkeletons: seeded,
    warmupTokens,
    endMs,
  };
}

/** `EventSource` em memória (testes e fixtures): entrega a lista na ordem dada. */
export class ArrayEventSource implements EventSource {
  private stopped = false;
  private readonly events: readonly ReplayEvent[];

  constructor(events: readonly ReplayEvent[]) {
    this.events = events;
  }

  start(onEvent: (e: ReplayEvent) => void): Promise<void> {
    for (const e of this.events) {
      if (this.stopped) break;
      onEvent(e);
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}
