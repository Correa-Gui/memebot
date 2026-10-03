import { SimulatedClock } from '@memebot/core';
import type { PaperEngine } from '../paper/engine.ts';
import type { ReplayEvent } from './order.ts';
import type { CostSchedule, ProtocolSchedule, SolUsdSchedule } from './schedules.ts';

/**
 * Laço do replay determinístico (Fase 4): o MESMO `PaperEngine` do paper ao vivo, dirigido pelo tempo
 * dos eventos gravados — sem relógio de parede, sem I/O. Vários engines (variantes de config) podem
 * consumir a mesma passada de eventos: cada um tem o próprio `MarketStore`, executor, risco e sinks; o
 * driver só distribui eventos, ticks e parâmetros externos.
 *
 * Relógio (`SimulatedClock`): `agora = max(agora, ts do evento)`. O `ts` on-chain tem resolução de 1 s,
 * então todas as decisões caem em segundos cheios. Ticks sintéticos a cada segundo cheio T (T ≤ agora),
 * emitidos ANTES dos eventos com ts = T — o equivalente aos ticks de 1 s do paper ao vivo (cujo `PaperClock`
 * também usa o ts dos eventos desde 03/10), para saídas por tempo e preenchimentos que vencem sem
 * evento do mint. Em cada instante (tick ou evento), antes do engine: custos (`CostSchedule`) e
 * `protocol_config` (`ProtocolSchedule`) devidos até ali e, ao cruzar `entriesUntilMs`, `stopEntries()`.
 *
 * Modo de relógio `paper_wall` (só para comparar com papers rodados ATÉ 02/10): emula o `PaperClock` antigo
 * usando o `received_at` gravado como "parede": `agora = max(agora, ts, received_at − 2 s)`. O padrão
 * (`event`) é o tempo do evento puro — o único que não depende do relógio da máquina que gravou.
 *
 * Tokens afetados por lacuna de gravação (`excludeToken`): o `token_created` vira só esqueleto
 * (`seedSkeletons`) — conta para o filtro de criador, mas o engine nunca o avalia (não foi "visto ao vivo").
 */
export interface ReplayDriverOptions {
  engines: readonly PaperEngine[];
  /** Início do período (relógio e primeiro tick). */
  fromMs: number;
  /** A partir deste instante, nenhuma entrada nova (as posições abertas continuam sendo geridas). */
  entriesUntilMs: number;
  costs: CostSchedule;
  protocol: ProtocolSchedule;
  /** `true` = token não elegível (lacuna de gravação na janela de avaliação). */
  excludeToken?: (mint: string, createdAtMs: number) => boolean;
  /** `event` (padrão): relógio = ts do evento. `paper_wall`: emula o PaperClock com received_at − `wallGraceMs`. */
  clockMode?: 'event' | 'paper_wall';
  /** Atraso do PaperClock sobre a parede (padrão 2.000 ms, como em paper/clock.ts). */
  wallGraceMs?: number;
  /** Preço SOL/US$ vigente (universo graduado, filtro de market cap); ausente = engines sem preço. */
  solUsd?: SolUsdSchedule;
}

export interface ReplayDriverStats {
  events: number;
  ticks: number;
  excludedTokens: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
}

export class ReplayDriver {
  readonly clock: SimulatedClock;
  private nextTickMs: number;
  private entriesStopped = false;
  private lastSolUsd: number | null = null;
  readonly stats: ReplayDriverStats = { events: 0, ticks: 0, excludedTokens: 0, firstEventMs: null, lastEventMs: null };

  private readonly o: ReplayDriverOptions;

  constructor(o: ReplayDriverOptions) {
    this.o = o;
    this.clock = new SimulatedClock(o.fromMs, 0n);
    this.nextTickMs = Math.ceil(o.fromMs / 1000) * 1000;
  }

  /** Processa um evento (na ordem de `compareReplayEvents`). */
  onEvent(e: ReplayEvent): void {
    const wall = this.o.clockMode === 'paper_wall' ? e.receivedAtMs - (this.o.wallGraceMs ?? 2_000) : Number.NEGATIVE_INFINITY;
    const t = Math.max(this.clock.nowMs(), e.ts, wall);
    this.advanceTo(t);
    this.clock.advanceTo(t, e.slot);
    this.atInstant(t);
    this.stats.events++;
    this.stats.firstEventMs ??= e.ts;
    this.stats.lastEventMs = e.ts;
    if (e.kind === 'token_created' && this.o.excludeToken?.(e.mint, e.ts)) {
      this.stats.excludedTokens++;
      const skeleton = { mint: e.mint, creator: e.creator, createdAtMs: e.ts, createdAtSlot: e.slot, quoteMint: e.quoteMint, tokenTotalSupply: e.tokenTotalSupply };
      for (const engine of this.o.engines) engine.seedSkeletons([skeleton]);
      return;
    }
    for (const engine of this.o.engines) engine.onEvent(e, t);
  }

  /** Emite os ticks de 1 s até `t` (inclusive), sem eventos. */
  advanceTo(t: number): void {
    while (this.nextTickMs <= t) {
      const tick = this.nextTickMs;
      this.clock.advanceTo(Math.max(this.clock.nowMs(), tick), this.clock.slot());
      this.atInstant(tick);
      for (const engine of this.o.engines) engine.onTick(tick);
      this.stats.ticks++;
      this.nextTickMs += 1000;
    }
  }

  /** Depois do fim das entradas: nenhum engine com posição aberta, ordem pendente ou sinal pendente. */
  get idle(): boolean {
    return this.entriesStopped && this.o.engines.every((e) => e.openPositions.length === 0 && e.pendingOrders === 0 && e.pendingSignalCount === 0);
  }

  private atInstant(t: number): void {
    const costs = this.o.costs.due(t);
    const protocol = this.o.protocol.due(t);
    const solUsd = this.o.solUsd ? this.o.solUsd.at(t) : null;
    const solUsdChanged = solUsd !== this.lastSolUsd;
    this.lastSolUsd = solUsd;
    for (const engine of this.o.engines) {
      if (solUsdChanged) engine.setSolUsd(solUsd);
      if (costs) engine.setCosts(costs);
      if (protocol?.fees) engine.setFees(protocol.fees);
      if (protocol?.curveParams) engine.setCurveParams(protocol.curveParams);
    }
    if (!this.entriesStopped && t >= this.o.entriesUntilMs) {
      this.entriesStopped = true;
      for (const engine of this.o.engines) engine.stopEntries();
    }
  }
}
