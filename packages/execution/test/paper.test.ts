import { describe, expect, it } from 'vitest';
import { bondingCurveBuy, bondingCurveSell } from '@memebot/curve-math';
import { quoteInForBudget } from '@memebot/risk';
import type { MarketState } from '@memebot/state';
import {
  HardLimitViolationError,
  InvalidOrderError,
  PumpSwapSimulationNotValidatedError,
  createPaperExecutorState,
  estimateTxCosts,
  fillCashFlow,
  medianLamports,
  mulberry32Next,
  openMints,
  seedFromString,
  settleBeforeEvent,
  settleOnTick,
  simulatePumpSwapSwap,
  submitOrder,
} from '../src/index.ts';
import type { Fill, PaperExecutorParams, PaperExecutorState, TxCostSample } from '../src/index.ts';
import {
  FEES,
  INITIAL_VIRTUAL_QUOTE,
  INITIAL_VIRTUAL_TOKEN,
  MINT,
  RENT_FIXTURE,
  BASE_FEE,
  T0,
  applyAll,
  completed,
  costs,
  initialMarket,
  params,
  poolCreated,
  trade,
} from './helpers.ts';

const K = INITIAL_VIRTUAL_QUOTE * INITIAL_VIRTUAL_TOKEN;

function buy(decisionId = 'd-buy', sizeLamports = 50_000_000n, maxSlippageBps = 1500) {
  return { side: 'buy' as const, decisionId, mint: MINT, sizeLamports, maxSlippageBps };
}
function sell(fraction = 1, decisionId = 'd-sell', maxSlippageBps = 1500) {
  return { side: 'sell' as const, decisionId, mint: MINT, fraction, maxSlippageBps };
}

function onlyFill(fills: Fill[]): Fill {
  expect(fills).toHaveLength(1);
  const f = fills[0];
  if (!f) throw new Error('sem fill');
  return f;
}

/** Abre uma posição em `MINT` com latência 0 e devolve estado + fill. */
function openAt(p: PaperExecutorParams, market: MarketState): { state: PaperExecutorState; fill: Fill } {
  const s1 = submitOrder(createPaperExecutorState(1), { ...p, latencyMs: 0 }, buy(), market, T0);
  const r = settleOnTick(s1, { ...p, latencyMs: 0 }, market, T0);
  return { state: r.state, fill: onlyFill(r.fills) };
}

describe('estimateTxCosts', () => {
  const sample = (priorityFee: bigint, jitoTip: bigint | null): TxCostSample => ({ priorityFee, jitoTip });
  const p = { minSamples: 30, fallbackPriorityFeeLamports: 500_000n, fallbackJitoTipLamports: 400_000n };

  it('com menos amostras que o mínimo (hoje: 3) usa o fallback e marca a origem', () => {
    const est = estimateTxCosts([sample(150_000n, 0n), sample(150_000n, 0n), sample(140_000n, null)], p);
    expect(est).toMatchObject({
      priorityFeeLamports: 500_000n, jitoTipLamports: 400_000n, priorityFeeSource: 'fallback', jitoTipSource: 'fallback',
      prioritySampleCount: 3, tipSampleCount: 0,
    });
  });

  it('com amostras suficientes: mediana × 1,5 (tip só de quem pagou tip)', () => {
    const samples = Array.from({ length: 30 }, (_, i) => sample(BigInt(100_000 + i * 1_000), i < 30 ? BigInt(10_000 + i) : null));
    const est = estimateTxCosts(samples, p);
    // mediana de 100_000..129_000 (par): (114_000 + 115_000)/2 = 114_500 → × 1,5 = 171_750
    expect(est.priorityFeeLamports).toBe(171_750n);
    expect(est.priorityFeeSource).toBe('tx_costs_median');
    expect(est.jitoTipLamports).toBe(((10_014n + 10_015n + 1n) / 2n * 3n + 1n) / 2n);
    expect(est.jitoTipSource).toBe('tx_costs_median');
    // tips zero não contam: 30 amostras com tip 0 → fallback do tip
    const noTip = estimateTxCosts(Array.from({ length: 30 }, () => sample(1n, 0n)), p);
    expect(noTip.jitoTipSource).toBe('fallback');
    expect(noTip.priorityFeeSource).toBe('tx_costs_median');
  });

  it('medianLamports', () => {
    expect(medianLamports([3n, 1n, 2n])).toBe(2n);
    expect(medianLamports([1n, 2n])).toBe(2n); // (1+2+1)/2 = 2, arredonda para cima
    expect(() => medianLamports([])).toThrow(RangeError);
  });
});

describe('PRNG semeado', () => {
  it('mesma seed → mesma sequência; seedFromString é estável', () => {
    const a = mulberry32Next(seedFromString('run-1'));
    const b = mulberry32Next(seedFromString('run-1'));
    expect(a).toEqual(b);
    expect(a.value).toBeGreaterThanOrEqual(0);
    expect(a.value).toBeLessThan(1);
    expect(seedFromString('run-1')).not.toBe(seedFromString('run-2'));
  });
});

describe('paper executor — latência e preço', () => {
  it('preenche no estado após todos os eventos com ts ≤ t + latência (e não depois)', () => {
    const p = params({ latencyMs: 800 });
    let market = initialMarket();
    let state = submitOrder(createPaperExecutorState(1), p, buy(), market, T0);

    // evento em t + 800 (= vencimento) entra no estado usado no preenchimento
    const atDue = trade(MINT, T0 + 800, 31_000_000_000n, K / 31_000_000_000n);
    let r = settleBeforeEvent(state, p, market, atDue.ts);
    expect(r.fills).toHaveLength(0);
    state = r.state;
    market = applyAll([atDue], market);

    // evento depois do vencimento: preenche ANTES de aplicá-lo, com as reservas de atDue
    const after = trade(MINT, T0 + 801, 40_000_000_000n, K / 40_000_000_000n);
    r = settleBeforeEvent(state, p, market, after.ts);
    const fill = onlyFill(r.fills);
    const expected = bondingCurveBuy({ virtualQuote: 31_000_000_000n, virtualToken: K / 31_000_000_000n }, quoteInForBudget(50_000_000n, FEES), FEES);
    expect(fill).toMatchObject({ status: 'filled', ts: T0 + 800, solIn: expected.totalQuoteCost, tokenDelta: expected.tokenOut });
    expect(fill.solIn).toBeLessThanOrEqual(50_000_000n);
    expect(fill.slippageBps).toBeGreaterThan(0); // preço subiu durante a latência
    expect(fill.rent).toBe(RENT_FIXTURE);
    expect(fill.priorityFee).toBe(225_000n);
    expect(fill.jitoTip).toBe(300_000n);
    expect(fill.costEstimateSource).toBe('tx_costs_median');
    expect(fill.landedSlot).toBeNull();
  });

  it('expira se o slippage passar do máximo aprovado: sem posição, paga priority fee, sem tip', () => {
    const p = params({ latencyMs: 800 });
    let market = initialMarket();
    const state = submitOrder(createPaperExecutorState(1), p, buy('d', 50_000_000n, 100), market, T0);
    market = applyAll([trade(MINT, T0 + 500, 33_000_000_000n, K / 33_000_000_000n)], market); // +~21% no preço
    const r = settleOnTick(state, p, market, T0 + 800);
    const fill = onlyFill(r.fills);
    expect(fill).toMatchObject({ status: 'expired', error: 'slippage_exceeded', tokenDelta: 0n, solIn: 0n, jitoTip: 0n, priorityFee: 225_000n, rent: 0n });
    expect(fill.slippageBps).toBeGreaterThan(100);
    expect(r.state.holdings.size).toBe(0);
    expect(openMints(r.state).size).toBe(0);
  });

  it('falha semeada: failRate 1 → failed (paga priority, sem tip, sem posição); determinístico', () => {
    const p = params({ failRate: 1, latencyMs: 0 });
    const market = initialMarket();
    const s = submitOrder(createPaperExecutorState(42), p, buy(), market, T0);
    const r1 = settleOnTick(s, p, market, T0);
    const r2 = settleOnTick(s, p, market, T0);
    expect(r1).toEqual(r2);
    const fill = onlyFill(r1.fills);
    expect(fill).toMatchObject({ status: 'failed', error: 'simulated_tx_failure', priorityFee: 225_000n, jitoTip: 0n, tokenDelta: 0n });
    expect(Number.isNaN(fill.realizedPriceLamportsPerUnit)).toBe(true);
    expect(fillCashFlow(fill)).toBe(-225_000n - BASE_FEE);
    expect(r1.state.holdings.size).toBe(0);
  });

  it('taxa de falha intermediária segue o PRNG semeado', () => {
    const p = params({ failRate: 0.5, latencyMs: 0 });
    const market = applyAll([trade('m0', T0, INITIAL_VIRTUAL_QUOTE, INITIAL_VIRTUAL_TOKEN), trade('m1', T0, INITIAL_VIRTUAL_QUOTE, INITIAL_VIRTUAL_TOKEN), trade('m2', T0, INITIAL_VIRTUAL_QUOTE, INITIAL_VIRTUAL_TOKEN)]);
    let s = createPaperExecutorState(seedFromString('seed-x'));
    for (const m of ['m0', 'm1', 'm2']) s = submitOrder(s, p, { ...buy(`d-${m}`), mint: m }, market, T0);
    const statuses = settleOnTick(s, p, market, T0).fills.map((f) => f.status);
    let rng = seedFromString('seed-x');
    const expected = [0, 1, 2].map(() => { const d = mulberry32Next(rng); rng = d.state; return d.value < 0.5 ? 'failed' : 'filled'; });
    expect(statuses).toEqual(expected);
  });
});

describe('paper executor — custos e rent', () => {
  it('estimativa acima do hard limit é limitada e marcada (nunca passa do limite)', () => {
    const p = params({ costs: costs(10_000_000n, 9_000_000n), latencyMs: 0 });
    const { fill } = openAt(p, initialMarket());
    expect(fill.priorityFee).toBe(2_000_000n);
    expect(fill.jitoTip).toBe(2_000_000n);
    expect(fill.costCappedByHardLimit).toBe(true);
  });

  it('fallback é propagado como costEstimateSource', () => {
    const est = { ...costs(), priorityFeeSource: 'fallback' as const };
    const { fill } = openAt(params({ costs: est }), initialMarket());
    expect(fill.costEstimateSource).toBe('fallback');
  });

  it('rent cobrado na primeira compra; venda parcial não devolve; venda que zera devolve', () => {
    const p = params({ latencyMs: 0 });
    const market = initialMarket();
    const { state, fill } = openAt(p, market);
    expect(fill.rent).toBe(RENT_FIXTURE);

    const partial = settleOnTick(submitOrder(state, p, sell(0.5, 's1'), market, T0 + 10), p, market, T0 + 10);
    const pf = onlyFill(partial.fills);
    expect(pf.status).toBe('filled');
    expect(pf.rentRefund).toBe(0n);
    expect(pf.tokenDelta).toBe(-(fill.tokenDelta / 2n));

    const full = settleOnTick(submitOrder(partial.state, p, sell(1, 's2'), market, T0 + 20), p, market, T0 + 20);
    const ff = onlyFill(full.fills);
    expect(ff.rentRefund).toBe(RENT_FIXTURE);
    expect(full.state.holdings.has(MINT)).toBe(false);
  });
});

describe('paper executor — hard limits e ordens inválidas', () => {
  const market = initialMarket();
  it('tamanho, slippage e nº de posições acima do limite lançam HardLimitViolationError', () => {
    const p = params();
    expect(() => submitOrder(createPaperExecutorState(1), p, buy('d', 50_000_001n), market, T0)).toThrow(HardLimitViolationError);
    expect(() => submitOrder(createPaperExecutorState(1), p, buy('d', 50_000_000n, 1501), market, T0)).toThrow(HardLimitViolationError);
    const reduced = params({ limits: { ...p.limits, maxPositionLamports: 10_000_000n, sizeLamports: 10_000_000n } });
    expect(() => submitOrder(createPaperExecutorState(1), reduced, buy('d', 10_000_001n), market, T0)).toThrow(HardLimitViolationError);

    const m4 = applyAll(['a', 'b', 'c', 'd'].map((m) => trade(m, T0, INITIAL_VIRTUAL_QUOTE, INITIAL_VIRTUAL_TOKEN)));
    let s = createPaperExecutorState(1);
    for (const m of ['a', 'b', 'c']) s = submitOrder(s, p, { ...buy(`d-${m}`), mint: m }, m4, T0);
    expect(() => submitOrder(s, p, { ...buy('d-d'), mint: 'd' }, m4, T0)).toThrow(HardLimitViolationError);
  });

  it('limites com valor acima do hard limit nos params são recusados', () => {
    const p = params();
    expect(() => submitOrder(createPaperExecutorState(1), { ...p, limits: { ...p.limits, maxPriorityFeeLamports: 3_000_000n } }, buy(), market, T0)).toThrow();
  });

  it('venda sem posição, fração inválida e compra duplicada lançam InvalidOrderError', () => {
    const p = params();
    expect(() => submitOrder(createPaperExecutorState(1), p, sell(), market, T0)).toThrow(InvalidOrderError);
    const s = submitOrder(createPaperExecutorState(1), p, buy(), market, T0);
    expect(() => submitOrder(s, p, buy('d2'), market, T0)).toThrow(InvalidOrderError);
    const { state } = openAt(p, market);
    expect(() => submitOrder(state, p, sell(0), market, T0)).toThrow(InvalidOrderError);
    expect(() => submitOrder(state, p, sell(1.5), market, T0)).toThrow(InvalidOrderError);
  });
});

describe('PumpSwap: nunca simula, erro explícito', () => {
  it('simulatePumpSwapSwap sempre lança PumpSwapSimulationNotValidatedError', () => {
    expect(() => simulatePumpSwapSwap(MINT)).toThrow(PumpSwapSimulationNotValidatedError);
  });

  it('compra num token no PumpSwap ou com curva completada lança erro tipado', () => {
    const p = params();
    const onPool = applyAll([poolCreated(MINT, T0)], initialMarket());
    expect(() => submitOrder(createPaperExecutorState(1), p, buy(), onPool, T0)).toThrow(PumpSwapSimulationNotValidatedError);
    const done = applyAll([completed(MINT, T0)], initialMarket());
    expect(() => submitOrder(createPaperExecutorState(1), p, buy(), done, T0)).toThrow(PumpSwapSimulationNotValidatedError);
  });

  it('compra pendente quando a curva completa durante a latência → failed (a tx na curva falharia)', () => {
    const p = params();
    const market = initialMarket();
    const s = submitOrder(createPaperExecutorState(1), p, buy(), market, T0);
    const r = settleOnTick(s, p, applyAll([completed(MINT, T0 + 100)], market), T0 + 800);
    expect(onlyFill(r.fills)).toMatchObject({ status: 'failed', error: 'curve_unavailable_at_fill', tokenDelta: 0n });
  });
});

describe('graduação com posição aberta', () => {
  it('fecha tudo no último preço da curva, venueUnverified = true, sem simular PumpSwap', () => {
    const p = params({ failRate: 1 }); // nem a falha sorteada se aplica ao fechamento por graduação
    const market = initialMarket();
    const { state, fill: buyFill } = openAt({ ...p, failRate: 0 }, market);
    const lastVq = 85_000_000_000n;
    const lastVt = K / lastVq;
    const graduated = applyAll([trade(MINT, T0 + 100, lastVq, lastVt), completed(MINT, T0 + 101), poolCreated(MINT, T0 + 102)], market);
    const s = submitOrder(state, p, sell(0.5), graduated, T0 + 200);
    const fill = onlyFill(settleOnTick(s, p, graduated, T0 + 1_000).fills);
    const expected = bondingCurveSell({ virtualQuote: lastVq, virtualToken: lastVt }, buyFill.tokenDelta, FEES);
    expect(fill).toMatchObject({
      status: 'filled', venueUnverified: true, tokenDelta: -buyFill.tokenDelta, solOut: expected.netQuoteOut, rentRefund: RENT_FIXTURE,
    });
  });
});

describe('propriedade: comprar e vender no mesmo instante sempre perde', () => {
  it('500 casos semeados sobre reservas/tamanhos realistas (sem custos de tx: só a curva e as taxas)', () => {
    let rng = seedFromString('roundtrip');
    const rand = (): number => { const d = mulberry32Next(rng); rng = d.state; return d.value; };
    for (let i = 0; i < 500; i++) {
      // reservas virtuais ao longo da curva inteira: de 30 SOL (início) a ~115 SOL (perto de completar)
      const vq = INITIAL_VIRTUAL_QUOTE + BigInt(Math.floor(rand() * 85_000_000_000));
      const vt = K / vq;
      const size = 10_000n + BigInt(Math.floor(rand() * 49_990_000));
      const withCosts = i % 2 === 0;
      const p = params({ latencyMs: 0, costs: withCosts ? costs() : costs(0n, 0n) });
      const market = applyAll([trade(MINT, T0, vq, vt)]);
      let s = submitOrder(createPaperExecutorState(i), p, buy(`b${String(i)}`, size), market, T0);
      const b = settleOnTick(s, p, market, T0);
      s = submitOrder(b.state, p, sell(1, `s${String(i)}`), market, T0);
      const r = settleOnTick(s, p, market, T0);
      const fills = [...b.fills, ...r.fills];
      expect(fills.map((f) => f.status)).toEqual(['filled', 'filled']);
      const pnl = fills.reduce((acc, f) => acc + fillCashFlow(f), 0n);
      expect(pnl).toBeLessThan(0n);
    }
  });
});

describe('taxa base por assinatura (fee não-priority)', () => {
  it('cobrada em filled, failed e expired (1 assinatura por tx) e descontada em fillCashFlow', () => {
    const market = initialMarket();
    const filled = openAt(params(), market).fill;
    expect(filled.status).toBe('filled');
    expect(filled.baseFee).toBe(BASE_FEE);
    expect(fillCashFlow(filled)).toBe(-(filled.solIn + filled.priorityFee + filled.jitoTip + BASE_FEE + filled.rent));

    const pf = params({ failRate: 1, latencyMs: 0 });
    const failed = onlyFill(settleOnTick(submitOrder(createPaperExecutorState(1), pf, buy(), market, T0), pf, market, T0).fills);
    expect(failed).toMatchObject({ status: 'failed', baseFee: BASE_FEE });

    const pe = params({ latencyMs: 800 });
    const s = submitOrder(createPaperExecutorState(1), pe, buy('d', 50_000_000n, 100), market, T0);
    const moved = applyAll([trade(MINT, T0 + 500, 33_000_000_000n, K / 33_000_000_000n)], market);
    const expired = onlyFill(settleOnTick(s, pe, moved, T0 + 800).fills);
    expect(expired).toMatchObject({ status: 'expired', baseFee: BASE_FEE });
    expect(fillCashFlow(expired)).toBe(-(expired.priorityFee + BASE_FEE));
  });

  it('venda também paga a taxa base; parâmetro negativo é recusado', () => {
    const p = params({ latencyMs: 0 });
    const market = initialMarket();
    const { state } = openAt(p, market);
    const sold = onlyFill(settleOnTick(submitOrder(state, p, sell(), market, T0 + 1), p, market, T0 + 1).fills);
    expect(sold.baseFee).toBe(BASE_FEE);
    expect(() => submitOrder(createPaperExecutorState(1), params({ baseFeeLamportsPerSignature: -1n }), buy(), market, T0)).toThrow(InvalidOrderError);
  });

  it('o fill guarda as reservas virtuais usadas no preenchimento', () => {
    const { fill } = openAt(params(), initialMarket());
    expect(fill.virtualQuoteBefore).toBe(INITIAL_VIRTUAL_QUOTE);
    expect(fill.virtualTokenBefore).toBe(INITIAL_VIRTUAL_TOKEN);
  });
});
