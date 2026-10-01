import { describe, expect, it } from 'vitest';
import type { Clock, PumpEvent } from '@memebot/core';
import {
  createPaperExecutorState,
  fillCashFlow,
  mulberry32Next,
  openMints,
  pendingBuyExposure,
  settleBeforeEvent,
  submitOrder,
} from '@memebot/execution';
import type { Fill, PaperExecutorParams, PaperExecutorState } from '@memebot/execution';
import {
  HARD_LIMITS,
  HardLimitExceededError,
  approveEntry,
  buildEffectiveRiskLimits,
  createRiskState,
  dailyRealizedLoss,
  recordRealizedPnl,
  recordTxOutcome,
} from '@memebot/risk';
import type { ApprovalResult, EffectiveRiskLimits, RiskState } from '@memebot/risk';
import { applyEvent, createEmptyMarketState } from '@memebot/state';
import type { MarketState } from '@memebot/state';
import type { StrategyV0Config } from '@memebot/strategy';
import { applyExitFill, evaluateExits, markExitSubmitted, openPosition } from '../src/index.ts';
import type { ExitContext, Position } from '../src/index.ts';
import { CREATOR, FEES, RENT_FIXTURE, SUPPLY, T0, created, realConfig, trade } from './helpers.ts';

/**
 * Simulação integrada (risk → execution/paper → positions) dirigida por eventos sintéticos gerados
 * por PRNG semeado. Usada para as propriedades "nenhum fill ultrapassa hard limits" e
 * "determinismo". Nenhum acesso a rede/banco.
 */

interface SubmittedBuy {
  approval: Extract<ApprovalResult, { approved: true }>;
  dailyLossAtApproval: bigint;
  openCountAtApproval: number;
}

interface Trace {
  fills: Fill[];
  approvals: ApprovalResult[];
  submittedBuys: SubmittedBuy[];
  maxOpenObserved: number;
  configErrors: string[];
  limits: EffectiveRiskLimits;
}

function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    const d = mulberry32Next(s);
    s = d.state;
    return d.value;
  };
}

const clockAt = (ms: number): Clock => ({ nowMs: () => ms, slot: () => 0n });

function scenarioLimits(rand: () => number, base: StrategyV0Config, configErrors: string[]): EffectiveRiskLimits {
  // configs sorteadas, inclusive ACIMA dos hard limits: essas têm de falhar com erro explícito.
  const sizeSol = [0.01, 0.03, 0.05, 0.08, 0.1][Math.floor(rand() * 5)] ?? 0.05;
  const slippage = Math.floor(rand() * 2_000);
  const candidate = { ...base, sizing: { ...base.sizing, sizeSol } };
  try {
    return buildEffectiveRiskLimits(candidate, { maxSlippageBps: slippage });
  } catch (e) {
    if (!(e instanceof HardLimitExceededError)) throw e;
    configErrors.push(e.limitKey);
    // config rejeitada → o run seguiria com a config válida (reduzida)
    return buildEffectiveRiskLimits(base, { maxSlippageBps: Math.min(slippage, HARD_LIMITS.maxSlippageBps) });
  }
}

function runScenario(seed: number): Trace {
  const rand = rngFrom(seed);
  const base = realConfig();
  const configErrors: string[] = [];
  const limits = scenarioLimits(rand, base, configErrors);
  // estimativas de custo sorteadas até 2,5× o hard limit (o executor tem de limitar)
  const priorityEst = BigInt(Math.floor(rand() * 5_000_000));
  const tipEst = BigInt(Math.floor(rand() * 5_000_000));
  const params: PaperExecutorParams = {
    runId: `sim-${String(seed)}`,
    latencyMs: Math.floor(rand() * 2_000),
    failRate: rand() * 0.3,
    fees: FEES,
    tokenAccountRentLamports: RENT_FIXTURE,
    costs: {
      priorityFeeLamports: priorityEst, jitoTipLamports: tipEst,
      priorityFeeSource: 'fallback', jitoTipSource: 'fallback', prioritySampleCount: 3, tipSampleCount: 0,
    },
    limits,
  };
  const ctx: ExitContext = {
    fees: FEES,
    exitPriorityFeeLamports: priorityEst < limits.maxPriorityFeeLamports ? priorityEst : limits.maxPriorityFeeLamports,
    exitJitoTipLamports: tipEst < limits.maxJitoTipLamports ? tipEst : limits.maxJitoTipLamports,
  };

  const mints = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'];
  const vq = new Map<string, bigint>(mints.map((m) => [m, 30_000_000_000n + BigInt(Math.floor(rand() * 40_000_000_000))]));
  const events: PumpEvent[] = mints.map((m, i) => created(m, T0 - 120_000 + i));
  let ts = T0;
  for (let i = 0; i < 1_500; i++) {
    ts += 50 + Math.floor(rand() * 1_500);
    const mint = mints[Math.floor(rand() * mints.length)] ?? 'm0';
    const r = rand();
    const current = vq.get(mint) ?? 30_000_000_000n;
    if (r < 0.002) {
      events.push({ kind: 'curve_completed', mint, bondingCurve: 'bc', slot: BigInt(ts), ts, sig: `cc-${String(i)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: i, rawB64: '' });
      continue;
    }
    // passeio aleatório do preço (±8% em vq por trade), limitado à faixa realista da curva
    const step = 1 + (rand() - 0.48) * 0.16;
    let next = BigInt(Math.floor(Number(current) * step));
    if (next < 30_000_000_000n) next = 30_000_000_000n;
    if (next > 115_000_000_000n) next = 115_000_000_000n;
    vq.set(mint, next);
    const side = next >= current ? 'buy' : 'sell';
    const trader = r < 0.01 ? CREATOR : `w${String(Math.floor(rand() * 50))}`;
    const tokenAmount = r > 0.995 ? SUPPLY / 15n : 1_000_000_000n;
    events.push(trade(mint, ts, next, { side, trader, tokenAmount }));
  }

  let market: MarketState = createEmptyMarketState();
  let exec: PaperExecutorState = createPaperExecutorState(seed);
  let risk: RiskState = createRiskState(T0);
  const positions = new Map<string, Position>();
  const trace: Trace = { fills: [], approvals: [], submittedBuys: [], maxOpenObserved: 0, configErrors, limits };
  let lastEventMs: number | null = null;

  const processFills = (fills: Fill[]): void => {
    for (const fill of fills) {
      trace.fills.push(fill);
      risk = recordTxOutcome(risk, fill.status);
      if (fill.side === 'buy') {
        if (fill.status === 'filled') positions.set(fill.mint, openPosition(fill));
        else risk = recordRealizedPnl(risk, fillCashFlow(fill), fill.ts);
      } else {
        const pos = positions.get(fill.mint);
        if (!pos) throw new Error(`venda sem posição ${fill.mint}`);
        const r = applyExitFill(pos, fill);
        risk = recordRealizedPnl(risk, r.realizedPnlDelta, fill.ts);
        if (r.position) positions.set(fill.mint, r.position);
        else positions.delete(fill.mint);
      }
    }
  };

  for (const event of events) {
    const eventTs = event.kind === 'tx_cost' ? 0 : event.ts;
    const settled = settleBeforeEvent(exec, params, market, eventTs);
    exec = settled.state;
    processFills(settled.fills);
    market = applyEvent(market, event);
    lastEventMs = eventTs;

    // saídas (posições abertas são gerenciadas mesmo com kill switch ativo)
    for (const [mint, pos] of [...positions]) {
      const token = market.tokens.get(mint);
      if (!token) continue;
      const out = evaluateExits(pos, token, eventTs, base.exits, ctx);
      let next = out.position;
      const order = out.orders[0];
      if (order) {
        exec = submitOrder(exec, params, { side: 'sell', decisionId: `${params.runId}:exit:${mint}:${String(eventTs)}`, mint, fraction: order.fraction, maxSlippageBps: limits.maxSlippageBps }, market, eventTs);
        next = markExitSubmitted(next, order);
      }
      positions.set(mint, next);
    }

    // "strategy" sorteada: às vezes emite enter para o mint do evento
    if (event.kind === 'trade' && rand() < 0.08) {
      let exposure = pendingBuyExposure(exec);
      for (const p of positions.values()) exposure += p.entryCostLamports;
      const open = openMints(exec);
      const lossBefore = dailyRealizedLoss(risk, eventTs);
      const { result, riskState } = approveEntry(
        {
          decision: { outcome: 'enter', mint: event.mint, reason: 'momentum_trigger', features: {} },
          token: market.tokens.get(event.mint),
          runId: params.runId,
          limits,
          fees: FEES,
          riskState: risk,
          portfolio: { openMints: open, openExposureLamports: exposure },
          killSwitch: { lastStreamEventMs: lastEventMs, balance: null, stopFilePresent: false },
        },
        clockAt(eventTs),
      );
      risk = riskState;
      trace.approvals.push(result);
      if (result.approved) {
        trace.submittedBuys.push({ approval: result, dailyLossAtApproval: lossBefore, openCountAtApproval: open.size });
        exec = submitOrder(exec, params, { side: 'buy', decisionId: result.decisionId, mint: result.mint, sizeLamports: result.sizeLamports, maxSlippageBps: result.maxSlippageBps }, market, eventTs);
      }
    }
    trace.maxOpenObserved = Math.max(trace.maxOpenObserved, openMints(exec).size);
  }
  return trace;
}

describe('propriedade: nenhum fill ultrapassa hard limits', () => {
  it('40 cenários semeados (configs e estimativas de custo acima dos limites incluídas)', () => {
    let totalFills = 0;
    let sawConfigError = false;
    let sawCapped = false;
    for (let seed = 1; seed <= 40; seed++) {
      const t = runScenario(seed);
      totalFills += t.fills.length;
      if (t.configErrors.length > 0) sawConfigError = true;
      expect(t.maxOpenObserved).toBeLessThanOrEqual(HARD_LIMITS.maxOpenPositions);
      expect(t.maxOpenObserved).toBeLessThanOrEqual(t.limits.maxOpenPositions);
      for (const b of t.submittedBuys) {
        expect(b.approval.sizeLamports).toBeLessThanOrEqual(HARD_LIMITS.maxPositionLamports);
        expect(b.approval.maxSlippageBps).toBeLessThanOrEqual(HARD_LIMITS.maxSlippageBps);
        expect(b.dailyLossAtApproval).toBeLessThan(HARD_LIMITS.maxDailyLossLamports);
        expect(b.openCountAtApproval).toBeLessThan(HARD_LIMITS.maxOpenPositions);
      }
      const approvedSlippage = new Map(t.submittedBuys.map((b) => [b.approval.decisionId, b.approval.maxSlippageBps]));
      for (const f of t.fills) {
        if (f.costCappedByHardLimit) sawCapped = true;
        expect(f.solIn).toBeLessThanOrEqual(HARD_LIMITS.maxPositionLamports);
        expect(f.solIn).toBeLessThanOrEqual(t.limits.sizeLamports);
        expect(f.priorityFee).toBeLessThanOrEqual(HARD_LIMITS.maxPriorityFeeLamports);
        expect(f.jitoTip).toBeLessThanOrEqual(HARD_LIMITS.maxJitoTipLamports);
        if (f.status === 'filled' && !f.venueUnverified) {
          const max = f.side === 'buy' ? approvedSlippage.get(f.decisionId) : t.limits.maxSlippageBps;
          expect(max).toBeDefined();
          expect(f.slippageBps).toBeLessThanOrEqual(max ?? -1);
          expect(f.slippageBps).toBeLessThanOrEqual(HARD_LIMITS.maxSlippageBps);
        }
      }
    }
    // o cenário de fato exercitou os caminhos de limite
    expect(totalFills).toBeGreaterThan(100);
    expect(sawConfigError).toBe(true);
    expect(sawCapped).toBe(true);
  });
});

describe('determinismo', () => {
  it('mesma sequência de eventos + mesma seed → exatamente os mesmos fills e decisões', () => {
    for (const seed of [7, 19, 33]) {
      const a = runScenario(seed);
      const b = runScenario(seed);
      expect(a.fills.length).toBeGreaterThan(0);
      expect(b).toEqual(a);
    }
  });
});
