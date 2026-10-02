import type { Clock, Lamports, Logger, PumpEvent } from '@memebot/core';
import type { CurveFeeBps, CurveInitialParams } from '@memebot/curve-math';
import {
  SIGNATURES_PER_TX,
  createPaperExecutorState,
  fillCashFlow,
  openMints,
  pendingBuyExposure,
  settleBeforeEvent,
  settleOnTick,
  submitOrder,
} from '@memebot/execution';
import type { Fill, PaperExecutorParams, PaperExecutorState, PaperOrder, TxCostEstimate } from '@memebot/execution';
import { formatAlertMessage, formatEntryAlert, formatExitAlert, formatTradeBatchSummary } from '@memebot/monitor';
import type { ClosedTradePnl, HourlySummary, TelegramMessage } from '@memebot/monitor';
import { applyExitFill, evaluateExits, markExitSubmitted, netPnlRatio, openPosition } from '@memebot/positions';
import type { ExitContext, ExitOrder, Position } from '@memebot/positions';
import type { DecisionRecord } from '@memebot/recorder';
import { approveEntry, createRiskState, nextDecisionId, recordRealizedPnl, recordTxOutcome } from '@memebot/risk';
import type { EffectiveRiskLimits, RiskState } from '@memebot/risk';
import { MarketStore } from '@memebot/state';
import type { CompactionPolicy, TokenSkeleton, TokenState } from '@memebot/state';
import { evaluate } from '@memebot/strategy';
import type { StrategyV0Config } from '@memebot/strategy';

/**
 * Orquestrador do paper trading (ROADMAP Fase 3), sem I/O: recebe eventos e ticks com o instante
 * explícito (`nowMs`, do `PaperClock`) e devolve efeitos por callbacks (`sinks`) — o adaptador em
 * `run-paper.ts` liga os callbacks ao ClickHouse, ao Telegram e ao log. Determinístico para a mesma
 * sequência (eventos, nowMs) e a mesma seed: testável com eventos sintéticos.
 *
 * Fluxo por evento: `settleBeforeEvent` → `MarketStore.apply` → saídas do mint afetado (se há
 * posição) → avaliação de entrada do mint (se elegível). Tick (1 s): `settleOnTick` → saídas de todas
 * as posições (time stop sem depender de evento) → compactação (1×/min).
 *
 * Decisões de volume (~15–20 mil eventos/min no ingest) — ver docs/ARCHITECTURE.md §4 "orquestrador":
 * (a) só avalia `trade` de curva de um mint cuja criação foi vista AO VIVO neste run (pré-carregados
 *     do banco não têm histórico → features incompletas), sem posição/ordem pendente, curva não
 *     completada e idade em [minAgeSec, maxAgeSec]; e no máximo 1× por `evalIntervalMs` por mint;
 * (b) `decisions` só recebe uma linha quando o resultado do mint MUDA (primeiro reject, mudança de
 *     motivo, enter, saída) — não uma por avaliação. As contagens "tokens por motivo" do log/resumo
 *     contam mints distintos (Set), não avaliações.
 */

export interface PaperSinks {
  decision(d: DecisionRecord): void;
  fill(f: Fill): void;
  /** Texto para o Telegram (o adaptador decide se envia). */
  notify(message: TelegramMessage): void;
  log: Logger;
}

export interface PaperEngineOptions {
  runId: string;
  config: StrategyV0Config;
  limits: EffectiveRiskLimits;
  curveParams: CurveInitialParams;
  fees: CurveFeeBps;
  costs: TxCostEstimate;
  latencyMs: number;
  failRate: number;
  tokenAccountRentLamports: Lamports;
  /** `LAMPORTS_PER_SIGNATURE` de `packages/ingest` (o executor não duplica o número). */
  baseFeeLamportsPerSignature: Lamports;
  seed: number;
  startMs: number;
  sinks: PaperSinks;
  /** Intervalo mínimo entre duas avaliações do mesmo mint (padrão 1 s). */
  evalIntervalMs?: number;
  /** Intervalo da compactação de memória (padrão 60 s). */
  compactionIntervalMs?: number;
  /** Retenção do esqueleto (criador/horário) para o filtro de criador (padrão 24 h). */
  skeletonRetentionMs?: number;
  /**
   * Alertas por entrada/saída (e lotes de 10 operações) no Telegram. `false` = TELEGRAM_MODE=hourly:
   * só o resumo por hora e os alertas imediatos (kill switch etc.). Padrão `true`.
   */
  tradeAlerts?: boolean;
}

/** Saúde do ingest na hora (vem do adaptador de gravação; o engine não vê WS/HTTP). */
export interface HourlyHealthInput {
  streamGapMs: number;
  http429PerMin: number;
}

export interface PeriodStats {
  entries: number;
  exits: number;
  closedOperations: number;
  winningOperations: number;
  failedEntries: number;
  netPnlLamports: Lamports;
  streamGaps: number;
  /** reason → mints distintos rejeitados no período (strategy e risco). */
  rejectedMintsByReason: Map<string, Set<string>>;
  /** Mints avaliados (passaram pela strategy) no período. */
  evaluatedMints: Set<string>;
  /** Fills de venda executados no período, por motivo de saída. */
  exitsByReason: Map<string, number>;
  /** Operações fechadas no período (símbolo + PnL líquido / custo de entrada). */
  closedOps: { symbol: string | null; pnlRatio: number }[];
}

function emptyPeriod(): PeriodStats {
  return {
    entries: 0, exits: 0, closedOperations: 0, winningOperations: 0, failedEntries: 0, netPnlLamports: 0n, streamGaps: 0,
    rejectedMintsByReason: new Map(), evaluatedMints: new Set(), exitsByReason: new Map(), closedOps: [],
  };
}

const fixedClock = (ms: number): Clock => ({ nowMs: () => ms, slot: () => 0n });

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export class PaperEngine {
  private readonly o: Required<Omit<PaperEngineOptions, 'fees' | 'costs' | 'curveParams'>>;
  private killSwitchAlerted: string | null = null;
  private readonly market = new MarketStore();
  private exec: PaperExecutorState;
  private risk: RiskState;
  private params: PaperExecutorParams;
  private curveParams: CurveInitialParams;
  private readonly positions = new Map<string, Position>();
  /** Mints com `token_created` visto neste run → símbolo (para alertas). */
  private readonly liveCreated = new Map<string, { symbol: string; name: string }>();
  private readonly lastEvalMs = new Map<string, number>();
  private readonly lastOutcome = new Map<string, string>();
  private lastStreamEventMs: number | null = null;
  private lastStreamReceivedAtMs: number | null = null;
  private stopFilePresent = false;
  private entriesEnabled = true;
  private lastCompactionMs: number;
  private runNetPnl: Lamports = 0n;
  private minute = emptyPeriod();
  private hour = emptyPeriod();
  private hourStartMs: number;
  private completedOperations = 0;
  private tradePnlBatch: ClosedTradePnl[] = [];
  private readonly policy: CompactionPolicy;

  constructor(opts: PaperEngineOptions) {
    this.o = {
      evalIntervalMs: 1_000,
      compactionIntervalMs: 60_000,
      skeletonRetentionMs: 24 * 60 * 60 * 1000,
      tradeAlerts: true,
      ...opts,
    };
    this.curveParams = opts.curveParams;
    this.params = {
      runId: opts.runId,
      latencyMs: opts.latencyMs,
      failRate: opts.failRate,
      fees: opts.fees,
      tokenAccountRentLamports: opts.tokenAccountRentLamports,
      baseFeeLamportsPerSignature: opts.baseFeeLamportsPerSignature,
      costs: opts.costs,
      limits: opts.limits,
    };
    this.exec = createPaperExecutorState(opts.seed);
    this.risk = createRiskState(opts.startMs);
    this.lastCompactionMs = opts.startMs;
    this.hourStartMs = opts.startMs;
    // Estado completo até a idade máxima de entrada + 1 min de folga; depois só o esqueleto.
    this.policy = { fullStateMaxAgeMs: opts.config.entry.maxAgeSec * 1000 + 60_000, skeletonRetentionMs: this.o.skeletonRetentionMs };
  }

  // ---- entradas externas (adaptadores atualizam periodicamente) ----

  setCosts(costs: TxCostEstimate): void {
    this.params = { ...this.params, costs };
  }

  setFees(fees: CurveFeeBps): void {
    this.params = { ...this.params, fees };
  }

  setCurveParams(curveParams: CurveInitialParams): void {
    this.curveParams = curveParams;
  }

  setStopFile(present: boolean): void {
    this.stopFilePresent = present;
  }

  /** Encerramento: não abre novas posições (saídas continuam enquanto houver ticks/eventos). */
  stopEntries(): void {
    this.entriesEnabled = false;
  }

  seedSkeletons(skeletons: readonly TokenSkeleton[]): number {
    let n = 0;
    for (const s of skeletons) if (this.market.seedSkeleton(s)) n++;
    return n;
  }

  // ---- leitura ----

  get openPositions(): readonly Position[] {
    return [...this.positions.values()];
  }

  get pendingOrders(): number {
    return this.exec.pending.length;
  }

  tokenState(mint: string): TokenState | undefined {
    return this.market.state.tokens.get(mint);
  }

  get trackedTokens(): number {
    return this.market.size;
  }

  get closedOperationsCount(): number {
    return this.completedOperations;
  }

  get runNetPnlLamports(): Lamports {
    return this.runNetPnl;
  }

  /** `receivedAtMs` do último evento do stream (null antes do primeiro). */
  get lastStreamReceivedAt(): number | null {
    return this.lastStreamReceivedAtMs;
  }

  get currentCosts(): TxCostEstimate {
    return this.params.costs;
  }

  /** Estatísticas do minuto (e zera). */
  takeMinuteStats(): PeriodStats {
    const s = this.minute;
    this.minute = emptyPeriod();
    return s;
  }

  /** Resumo da hora para o Telegram (e zera). `health` vem do adaptador (WS/HTTP). */
  takeHourlySummary(nowMs: number, health: HourlyHealthInput): HourlySummary {
    const s = this.hour;
    const from = this.hourStartMs;
    this.hour = emptyPeriod();
    this.hourStartMs = nowMs;
    const byRatio = [...s.closedOps].sort((x, y) => y.pnlRatio - x.pnlRatio);
    const c = this.params.costs;
    return {
      mode: 'paper',
      runId: this.o.runId,
      fromMs: from,
      toMs: nowMs,
      openedOperations: s.entries,
      closedOperations: s.closedOperations,
      winningOperations: s.winningOperations,
      netPnlLamports: s.netPnlLamports,
      runNetPnlLamports: this.runNetPnl,
      capitalLamports: this.o.limits.sizeLamports * BigInt(this.o.limits.maxOpenPositions),
      best: byRatio[0] ?? null,
      worst: byRatio.length > 1 ? (byRatio.at(-1) ?? null) : null,
      openPositions: this.positions.size,
      exitsByReason: new Map(s.exitsByReason),
      evaluatedTokens: s.evaluatedMints.size,
      rejectionsByReason: new Map([...s.rejectedMintsByReason].map(([r, m]) => [r, m.size])),
      health: {
        streamGapMs: health.streamGapMs,
        http429PerMin: health.http429PerMin,
        priorityFeeLamports: c.priorityFeeLamports,
        jitoTipLamports: c.jitoTipLamports,
        costSource: c.priorityFeeSource === c.jitoTipSource ? c.priorityFeeSource : `${c.priorityFeeSource}/${c.jitoTipSource}`,
      },
    };
  }

  /** Registra uma lacuna real de reconnect na janela do resumo horário. */
  recordStreamGap(): void {
    this.minute.streamGaps++;
    this.hour.streamGaps++;
  }

  // ---- fluxo ----

  onEvent(event: PumpEvent, nowMs: number): void {
    if (event.kind === 'tx_cost') return; // custos vêm de tx_costs (recarregados), não do MarketState
    this.lastStreamReceivedAtMs = event.receivedAtMs;
    const settled = settleBeforeEvent(this.exec, this.params, this.market.state, event.ts);
    this.exec = settled.state;
    this.handleFills(settled.fills);

    const mint = this.market.apply(event);
    this.lastStreamEventMs = this.lastStreamEventMs === null ? event.ts : Math.max(this.lastStreamEventMs, event.ts);
    if (mint === null) return;
    if (event.kind === 'token_created') this.liveCreated.set(mint, { symbol: event.symbol, name: event.name });
    if (this.positions.has(mint)) this.runExits(mint, nowMs);
    if (event.kind === 'trade' && event.venue === 'curve') this.maybeEvaluate(mint, nowMs);
  }

  onTick(nowMs: number): void {
    const settled = settleOnTick(this.exec, this.params, this.market.state, nowMs);
    this.exec = settled.state;
    this.handleFills(settled.fills);
    for (const mint of [...this.positions.keys()]) this.runExits(mint, nowMs);
    if (nowMs - this.lastCompactionMs >= this.o.compactionIntervalMs) {
      this.compact(nowMs);
      this.lastCompactionMs = nowMs;
    }
  }

  // ---- entrada ----

  private maybeEvaluate(mint: string, nowMs: number): void {
    if (!this.entriesEnabled || !this.liveCreated.has(mint)) return;
    if (this.positions.has(mint) || openMints(this.exec).has(mint)) return;
    const token = this.market.state.tokens.get(mint);
    if (!token || token.createdAtMs === null || token.curveCompleted || token.venue !== 'curve') return;
    const ageSec = (nowMs - token.createdAtMs) / 1000;
    if (ageSec < this.o.config.entry.minAgeSec || ageSec > this.o.config.entry.maxAgeSec) return;
    const last = this.lastEvalMs.get(mint);
    if (last !== undefined && nowMs - last < this.o.evalIntervalMs) return;
    this.lastEvalMs.set(mint, nowMs);
    this.minute.evaluatedMints.add(mint);
    this.hour.evaluatedMints.add(mint);

    const decision = evaluate(this.market.state, mint, fixedClock(nowMs), this.o.config, this.curveParams)[0];
    if (!decision) return;
    if (decision.outcome === 'reject') {
      this.recordReject(mint, decision.reason, nowMs, null);
      return;
    }

    const open = openMints(this.exec);
    let exposure = pendingBuyExposure(this.exec);
    for (const p of this.positions.values()) exposure += p.entryCostLamports;
    const { result, riskState } = approveEntry(
      {
        decision,
        token,
        runId: this.o.runId,
        limits: this.o.limits,
        fees: this.params.fees,
        riskState: this.risk,
        portfolio: { openMints: open, openExposureLamports: exposure },
        killSwitch: { lastStreamEventMs: this.lastStreamEventMs, balance: null, stopFilePresent: this.stopFilePresent },
      },
      fixedClock(nowMs),
    );
    this.risk = riskState;
    if (!result.approved) {
      if (result.reason.startsWith('kill_switch') && this.killSwitchAlerted !== result.reason) {
        this.killSwitchAlerted = result.reason;
        this.o.sinks.notify(formatAlertMessage('kill switch acionado', [`motivo: ${result.reason}`, 'novas entradas bloqueadas; posições abertas continuam sendo geridas']));
      }
      this.recordReject(mint, result.reason, nowMs, result.decisionId);
      return;
    }
    this.killSwitchAlerted = null;
    const order: PaperOrder = { side: 'buy', decisionId: result.decisionId, mint, sizeLamports: result.sizeLamports, maxSlippageBps: result.maxSlippageBps };
    if (!this.trySubmit(order, nowMs)) {
      this.recordReject(mint, 'executor_refused', nowMs, result.decisionId);
      return;
    }
    this.lastOutcome.set(mint, 'enter');
    this.o.sinks.decision({
      runId: this.o.runId,
      ts: nowMs,
      decisionId: result.decisionId,
      mint,
      type: 'enter',
      reason: decision.reason,
      features: {
        ...decision.features,
        sizeLamports: result.sizeLamports.toString(),
        quoteAmountIn: result.quoteAmountIn.toString(),
        priceImpactPct: result.priceImpactPct,
        sizeReduced: result.sizeReduced,
        maxSlippageBps: result.maxSlippageBps,
        protocolFeeBps: Number(this.params.fees.protocolFeeBps),
        creatorFeeBps: Number(this.params.fees.creatorFeeBps),
        costEstimateSource: this.costSource(),
      },
    });
  }

  private recordReject(mint: string, reason: string, nowMs: number, decisionId: string | null): void {
    const set = (p: PeriodStats): void => {
      const s = p.rejectedMintsByReason.get(reason) ?? new Set<string>();
      s.add(mint);
      p.rejectedMintsByReason.set(reason, s);
    };
    set(this.minute);
    set(this.hour);
    const key = `reject:${reason}`;
    if (this.lastOutcome.get(mint) === key) return; // dedup: só grava quando o resultado muda
    this.lastOutcome.set(mint, key);
    let id = decisionId;
    if (id === null) {
      const next = nextDecisionId(this.risk, this.o.runId, mint, nowMs);
      this.risk = next.state;
      id = next.decisionId;
    }
    this.o.sinks.decision({ runId: this.o.runId, ts: nowMs, decisionId: id, mint, type: 'reject', reason, features: {} });
  }

  private trySubmit(order: PaperOrder, nowMs: number): boolean {
    try {
      this.exec = submitOrder(this.exec, this.params, order, this.market.state, nowMs);
      return true;
    } catch (e) {
      // Erro tipado do executor (hard limit, ordem inválida, PumpSwap): não é engolido — vai ao log
      // com o nome do erro e a decisão fica registrada como recusada.
      this.o.sinks.log.error(
        { err: e instanceof Error ? `${e.name}: ${e.message}` : String(e), mint: order.mint, side: order.side, decisionId: order.decisionId },
        'executor recusou a ordem',
      );
      return false;
    }
  }

  // ---- saída ----

  private exitContext(): ExitContext {
    return {
      fees: this.params.fees,
      exitPriorityFeeLamports: minBig(this.params.costs.priorityFeeLamports, this.o.limits.maxPriorityFeeLamports),
      exitJitoTipLamports: minBig(this.params.costs.jitoTipLamports, this.o.limits.maxJitoTipLamports),
      exitBaseFeeLamports: this.params.baseFeeLamportsPerSignature * SIGNATURES_PER_TX,
    };
  }

  private runExits(mint: string, nowMs: number): void {
    const position = this.positions.get(mint);
    const token = this.market.state.tokens.get(mint);
    if (!position || !token) return;
    const ctx = this.exitContext();
    const out = evaluateExits(position, token, nowMs, this.o.config.exits, ctx);
    let next = out.position;
    const order: ExitOrder | undefined = out.orders[0];
    if (order) {
      const { decisionId, state } = nextDecisionId(this.risk, this.o.runId, mint, nowMs);
      this.risk = state;
      const submitted = this.trySubmit(
        { side: 'sell', decisionId, mint, fraction: order.fraction, maxSlippageBps: this.o.limits.maxSlippageBps },
        nowMs,
      );
      if (submitted) {
        next = markExitSubmitted(next, order);
        this.o.sinks.decision({
          runId: this.o.runId,
          ts: nowMs,
          decisionId,
          mint,
          type: 'exit',
          reason: order.reason,
          features: {
            entryDecisionId: position.entryDecisionId,
            fraction: order.fraction,
            takeProfitStep: order.takeProfitStep,
            netPnlRatio: netPnlRatio(position, token, ctx),
            holdMs: nowMs - position.openedAtMs,
          },
        });
      }
    }
    this.positions.set(mint, next);
  }

  // ---- fills ----

  private costSource(): string {
    return `priority:${this.params.costs.priorityFeeSource}/tip:${this.params.costs.jitoTipSource}`;
  }

  private addPnl(delta: Lamports, ts: number): void {
    this.risk = recordRealizedPnl(this.risk, delta, ts);
    this.runNetPnl += delta;
    this.minute.netPnlLamports += delta;
    this.hour.netPnlLamports += delta;
  }

  private streamStatus(nowMs: number): string {
    if (this.lastStreamReceivedAtMs === null) return 'aguardando eventos';
    const ageSeconds = Math.floor(Math.max(0, nowMs - this.lastStreamReceivedAtMs) / 1_000);
    return ageSeconds <= 30 ? `ativo (último evento há ${String(ageSeconds)}s)` : `sem eventos há ${String(ageSeconds)}s`;
  }

  private handleFills(fills: readonly Fill[]): void {
    for (const fill of fills) {
      this.o.sinks.fill(fill);
      this.risk = recordTxOutcome(this.risk, fill.status);
      if (fill.side === 'buy') this.handleBuyFill(fill);
      else this.handleSellFill(fill);
    }
  }

  private handleBuyFill(fill: Fill): void {
    if (fill.status !== 'filled') {
      // Compra que não executou: perde o que a tx custou (priority + taxa base); sem posição.
      this.addPnl(fillCashFlow(fill), fill.ts);
      this.minute.failedEntries++;
      this.hour.failedEntries++;
      return;
    }
    this.positions.set(fill.mint, openPosition(fill));
    this.minute.entries++;
    this.hour.entries++;
    if (!this.o.tradeAlerts) return;
    this.o.sinks.notify(
      formatEntryAlert({
        mode: 'paper',
        mint: fill.mint,
        symbol: this.liveCreated.get(fill.mint)?.symbol ?? null,
        name: this.liveCreated.get(fill.mint)?.name ?? null,
        priceLamportsPerUnit: fill.realizedPriceLamportsPerUnit,
        sizeLamports: fill.solIn,
        curveFeeLamports: fill.protocolFee + fill.creatorFee,
        priorityFeeLamports: fill.priorityFee,
        jitoTipLamports: fill.jitoTip,
        baseFeeLamports: fill.baseFee,
        rentLamports: fill.rent,
        tokenAgeMs: (() => {
          const createdAt = this.market.state.tokens.get(fill.mint)?.createdAtMs;
          return createdAt === null || createdAt === undefined ? null : fill.ts - createdAt;
        })(),
      }),
    );
  }

  private handleSellFill(fill: Fill): void {
    const position = this.positions.get(fill.mint);
    if (!position) {
      this.o.sinks.log.error({ mint: fill.mint, decisionId: fill.decisionId }, 'fill de venda sem posição conhecida');
      this.addPnl(fillCashFlow(fill), fill.ts);
      return;
    }
    const reason = position.exitPending?.reason ?? 'unknown';
    const { position: next, realizedPnlDelta } = applyExitFill(position, fill);
    this.addPnl(realizedPnlDelta, fill.ts);
    if (next) this.positions.set(fill.mint, next);
    else this.positions.delete(fill.mint);
    if (fill.status !== 'filled') return;

    this.minute.exits++;
    this.hour.exits++;
    this.minute.exitsByReason.set(reason, (this.minute.exitsByReason.get(reason) ?? 0) + 1);
    this.hour.exitsByReason.set(reason, (this.hour.exitsByReason.get(reason) ?? 0) + 1);
    const sold = -fill.tokenDelta;
    const netProceeds = fill.solOut + fill.rentRefund - fill.priorityFee - fill.jitoTip - fill.baseFee;
    const allocated = netProceeds - realizedPnlDelta;
    const closed = next === null;
    const operationPnl = closed ? position.realizedPnlLamports + realizedPnlDelta : null;
    if (closed && operationPnl !== null) {
      this.completedOperations++;
      this.minute.closedOperations++;
      this.hour.closedOperations++;
      if (operationPnl > 0n) {
        this.minute.winningOperations++;
        this.hour.winningOperations++;
      }
      const closedOp = {
        symbol: this.liveCreated.get(fill.mint)?.symbol ?? null,
        pnlRatio: position.entryCostLamports > 0n ? Number(operationPnl) / Number(position.entryCostLamports) : Number.NaN,
      };
      this.minute.closedOps.push(closedOp);
      this.hour.closedOps.push(closedOp);
      // só acumula o lote no modo `all` (no `hourly` ele nunca seria esvaziado)
      if (this.o.tradeAlerts) this.tradePnlBatch.push({ symbol: closedOp.symbol, pnlLamports: operationPnl });
      if (this.tradePnlBatch.length === 10) {
        const batch = this.tradePnlBatch;
        this.tradePnlBatch = [];
        this.o.sinks.notify(formatTradeBatchSummary({
          mode: 'paper',
          firstOperation: this.completedOperations - batch.length + 1,
          lastOperation: this.completedOperations,
          trades: batch,
        }));
      }
    }
    if (!this.o.tradeAlerts) return;
    this.o.sinks.notify(
      formatExitAlert({
        mode: 'paper',
        mint: fill.mint,
        symbol: this.liveCreated.get(fill.mint)?.symbol ?? null,
        name: this.liveCreated.get(fill.mint)?.name ?? null,
        reason,
        fraction: position.tokenAmount > 0n ? Number(sold) / Number(position.tokenAmount) : 1,
        remainingFraction: next ? Number(next.tokenAmount) / Number(position.initialTokenAmount) : 0,
        priceLamportsPerUnit: fill.realizedPriceLamportsPerUnit,
        pnlLamports: realizedPnlDelta,
        pnlRatio: allocated > 0n ? Number(realizedPnlDelta) / Number(allocated) : Number.NaN,
        closed,
        operationPnlLamports: operationPnl,
        operationPnlRatio: operationPnl !== null && position.entryCostLamports > 0n ? Number(operationPnl) / Number(position.entryCostLamports) : null,
        heldMs: fill.ts - position.openedAtMs,
        stopLossPct: this.o.config.exits.stopLossPct,
      }),
    );
  }

  // ---- memória ----

  private compact(nowMs: number): void {
    const busy = openMints(this.exec);
    const isProtected = (mint: string): boolean => this.positions.has(mint) || busy.has(mint);
    const r = this.market.compact(nowMs, this.policy, isProtected);
    // Mapas auxiliares por mint: só para tokens ainda dentro da janela de estado completo.
    const stale = (mint: string): boolean => {
      if (isProtected(mint)) return false;
      const t = this.market.state.tokens.get(mint);
      return !t || t.createdAtMs === null || nowMs - t.createdAtMs > this.policy.fullStateMaxAgeMs;
    };
    for (const m of [...this.liveCreated.keys()]) if (stale(m)) this.liveCreated.delete(m);
    for (const m of [...this.lastEvalMs.keys()]) if (stale(m)) this.lastEvalMs.delete(m);
    for (const m of [...this.lastOutcome.keys()]) if (stale(m)) this.lastOutcome.delete(m);
    this.o.sinks.log.debug({ ...r, tokens: this.market.size }, 'compactação do estado');
  }
}
