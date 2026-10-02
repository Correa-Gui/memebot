import { bondingCurveBuy, bondingCurveSell } from '@memebot/curve-math';
import { quoteInForBudget } from '@memebot/risk';
import { describe, expect, it } from 'vitest';
import {
  aliveAfterHour,
  analyzeStops,
  bootstrapExpectancy,
  bucketize,
  covered,
  priceAt,
  slippageBySide,
} from './analysis.ts';
import type { DataCoverage, MintMarketData, MintTradePoint } from './analysis.ts';
import { buildOperations, operationMetrics } from './compute.ts';
import type { OperationMetrics, ReportFill } from './compute.ts';
import { alternativeRules, firstUncovered, postExitAnalysis, simulateExitRule } from './exit-sim.ts';
import type { ExitRule } from './exit-sim.ts';
import { brt } from './format.ts';

const FEES = { protocolFeeBps: 95n, creatorFeeBps: 30n };
const K = 30_000_000_000n * 1_073_000_000_000_000n;
const VQ0 = 40_000_000_000n;
const T0 = Date.UTC(2026, 9, 1, 23, 0, 0);
const MIN = 60_000;
const COSTS = { priorityFee: 300_000n, jitoTip: 200_000n, baseFee: 5_000n };

/** Cobertura total de [T0 − 1 h, T0 + horas]. */
function coverage(hours: number): DataCoverage {
  const minutes = new Set<number>();
  for (let m = T0 - 60 * MIN; m <= T0 + hours * 60 * MIN; m += MIN) minutes.add(m);
  return { minutes, endMs: T0 + hours * 60 * MIN };
}

const pt = (ts: number, vq: bigint, venue: 'curve' | 'pumpswap' = 'curve'): MintTradePoint =>
  venue === 'curve' ? { ts, venue, virtualQuote: vq, virtualToken: K / vq } : { ts, venue, virtualQuote: null, virtualToken: null };

function fill(p: Partial<ReportFill>): ReportFill {
  return {
    ts: T0, decisionId: 'd', mint: 'm', side: 'buy', status: 'filled', solIn: 0n, solOut: 0n, tokenDelta: 0n, protocolFee: 0n, creatorFee: 0n,
    ...COSTS, rent: 0n, rentRefund: 0n, expectedPrice: 0, realizedPrice: 0, venueUnverified: false, costEstimateSource: 'tx_costs_median',
    priorityFeeSource: 'tx_costs_median', jitoTipSource: 'tx_costs_median', virtualQuoteBefore: VQ0, virtualTokenBefore: K / VQ0, ...p,
  };
}

/** Operação real: compra 0,05 SOL em VQ0 no instante T0, vende tudo em `sellVq` no instante T0 + holdMs. */
function realOp(sellVq: bigint, holdMs: number, mint = 'm') {
  const b = bondingCurveBuy({ virtualQuote: VQ0, virtualToken: K / VQ0 }, quoteInForBudget(50_000_000n, FEES), FEES);
  const s = bondingCurveSell({ virtualQuote: sellVq, virtualToken: K / sellVq }, b.tokenOut, FEES);
  const fills = [
    fill({ mint, decisionId: `${mint}-in`, solIn: b.totalQuoteCost, tokenDelta: b.tokenOut, protocolFee: b.protocolFee, creatorFee: b.creatorFee, rent: 1_513_840n }),
    fill({
      mint, ts: T0 + holdMs, decisionId: `${mint}-out`, side: 'sell', solOut: s.netQuoteOut, tokenDelta: -b.tokenOut, protocolFee: s.protocolFee, creatorFee: s.creatorFee,
      rentRefund: 1_513_840n, virtualQuoteBefore: sellVq, virtualTokenBefore: K / sellVq,
    }),
  ];
  const [op] = buildOperations(fills, new Map([[`${mint}-out`, 'stop_loss']])).operations;
  if (!op) throw new Error('sem operação');
  return { op, metrics: operationMetrics(op), fills };
}

function market(points: MintTradePoint[], hours = 2, completed: number | null = null, mint = 'm'): MintMarketData {
  return { points: new Map([[mint, points]]), completedAt: completed === null ? new Map() : new Map([[mint, completed]]), coverage: coverage(hours) };
}

describe('preço depois de um instante', () => {
  const pts = [pt(T0 + 1_000, 41_000_000_000n), pt(T0 + 5 * MIN, 30_000_000_000n), pt(T0 + 70 * MIN, 0n, 'pumpswap')];
  it('último trade de curva ≤ t; sem dados além do fim/minuto descoberto; graduou depois do PumpSwap', () => {
    const c = coverage(2);
    expect(priceAt(pts, T0 + 3 * MIN, T0, c, null)).toMatchObject({ status: 'ok', lastTradeTs: T0 + 1_000 });
    expect(priceAt(pts, T0 + 3 * 60 * MIN, T0, c, null)).toEqual({ status: 'no_data' });
    expect(priceAt(pts, T0 + 80 * MIN, T0, c, null)).toEqual({ status: 'graduated' });
    expect(priceAt(pts, T0 + 3 * MIN, T0, c, T0 + 2 * MIN)).toEqual({ status: 'graduated' });
    const holed: DataCoverage = { minutes: new Set([...c.minutes].filter((m) => m !== T0 + 2 * MIN)), endMs: c.endMs };
    expect(covered(holed, T0, T0 + 3 * MIN)).toBe(false);
    expect(priceAt(pts, T0 + 3 * MIN, T0, holed, null)).toEqual({ status: 'no_data' });
    expect(firstUncovered(holed, T0, T0 + 10 * MIN)).toBe(T0 + 2 * MIN);
  });

  it('horários em BRT com UTC entre parênteses', () => {
    expect(brt(T0)).toBe('01/10 20:00:00 BRT (23:00:00 UTC)');
  });
});

describe('stops', () => {
  it('tempo até o stop, MFE (líquido e de preço) e preço 5/15/60 min depois; 60 min além dos dados → sem dados', () => {
    const stopVq = 36_000_000_000n;
    const { op, metrics } = realOp(stopVq, 2 * MIN);
    const pts = [pt(T0 + 30_000, 44_000_000_000n), pt(T0 + 90_000, 37_000_000_000n), pt(T0 + 2 * MIN + 1_000, stopVq), pt(T0 + 7 * MIN, 39_600_000_000n)];
    const a = analyzeStops([{ op, metrics }], market(pts, 1), FEES);
    const row = a.rows[0];
    if (!row) throw new Error('sem linha');
    expect(row.holdMs).toBe(2 * MIN);
    const entryPrice = Number(VQ0) / Number(K / VQ0);
    const peak = 44_000_000_000 / Number(K / 44_000_000_000n);
    expect(row.mfePriceRatio).toBeCloseTo(peak / entryPrice - 1, 9);
    const held = op.entry.tokenDelta;
    const liq = bondingCurveSell({ virtualQuote: 44_000_000_000n, virtualToken: K / 44_000_000_000n }, held, FEES).netQuoteOut - (COSTS.priorityFee + COSTS.jitoTip + COSTS.baseFee) + 1_513_840n;
    expect(row.mfeNetRatio).toBeCloseTo(Number(liq - metrics.entryCost) / Number(metrics.entryCost), 9);
    const exitPrice = Number(stopVq) / Number(K / stopVq);
    const p7 = 39_600_000_000 / Number(K / 39_600_000_000n);
    expect(row.after[0]).toMatchObject({ minutes: 5, status: 'ok' });
    expect(row.after[0]?.ratio).toBeCloseTo(p7 / exitPrice - 1, 9);
    expect(row.after[2]).toEqual({ minutes: 60, status: 'no_data', ratio: null });
    expect(a.horizons[0]).toMatchObject({ withData: 1, aboveExit: 1, noData: 0 });
    expect(a.horizons[2]).toMatchObject({ withData: 0, noData: 1 });
  });

  it('operação que não saiu por stop fica de fora', () => {
    const { op, metrics } = realOp(36_000_000_000n, MIN);
    expect(analyzeStops([{ op: { ...op, exitReason: 'take_profit_1' }, metrics }], market([]), FEES).rows).toHaveLength(0);
  });
});

describe('token vivo 1 h depois', () => {
  const { op } = realOp(36_000_000_000n, MIN);
  it('vivo / morto (sem trade na janela ou preço < 10%) / graduou / sem dados', () => {
    expect(aliveAfterHour(op, market([pt(T0 + 58 * MIN, 30_000_000_000n)]))).toBe('vivo');
    expect(aliveAfterHour(op, market([pt(T0 + 20 * MIN, 30_000_000_000n)]))).toBe('morto');
    // preço < 10% do de entrada: vq tão baixo não existe na curva real, então usamos uma razão K diferente
    const dead: MintTradePoint = { ts: T0 + 58 * MIN, venue: 'curve', virtualQuote: 1_000_000_000n, virtualToken: K / VQ0 };
    expect(aliveAfterHour(op, market([dead]))).toBe('morto');
    expect(aliveAfterHour(op, market([pt(T0 + 58 * MIN, 0n, 'pumpswap')]))).toBe('graduou');
    expect(aliveAfterHour(op, market([pt(T0 + 58 * MIN, 30_000_000_000n)], 0.5))).toBe('sem_dados');
  });
});

describe('faixas, bootstrap e slippage', () => {
  const m = (net: bigint, ret: number): OperationMetrics => ({ net, gross: 0n, entryCost: 1n, returnRatio: ret, curveFees: 0n, priorityFee: 0n, jitoTip: 0n, baseFee: 0n, rentNet: 0n, slippage: 0n });
  it('bucketize por ageSec: n, acerto, médio, mediano, PnL; sem feature → "sem dado"', () => {
    const rows = bucketize([
      { metrics: m(10n, 0.1), features: { ageSec: 90 } },
      { metrics: m(-20n, -0.2), features: { ageSec: 100 } },
      { metrics: m(-5n, -0.05), features: { ageSec: 400 } },
      { metrics: m(1n, 0.01), features: undefined },
    ], 'ageSec', [{ label: 'a', min: 60, max: 180 }, { label: 'b', min: 180, max: 360 }, { label: 'c', min: 360, max: Number.POSITIVE_INFINITY }]);
    expect(rows.map((r) => [r.label, r.n, r.netLamports])).toEqual([['a', 2, -10n], ['b', 0, 0n], ['c', 1, -5n], ['sem dado', 1, 1n]]);
    expect(rows[0]?.hitRate).toBe(0.5);
    expect(rows[0]?.medianReturn).toBeCloseTo(-0.05, 12);
    expect(rows[0]?.meanReturn).toBeCloseTo(-0.05, 12);
  });

  it('bootstrap determinístico; IC dentro de [mín, máx]; P(>0) = 1 com tudo positivo', () => {
    const a = bootstrapExpectancy([10n, -5n, 3n, 8n], 2_000);
    expect(bootstrapExpectancy([10n, -5n, 3n, 8n], 2_000)).toEqual(a);
    expect(a.meanLamports).toBe(4);
    expect(a.ci95[0]).toBeGreaterThanOrEqual(-5);
    expect(a.ci95[1]).toBeLessThanOrEqual(10);
    expect(bootstrapExpectancy([1n, 2n], 500).probPositive).toBe(1);
    expect(bootstrapExpectancy([]).n).toBe(0);
  });

  it('slippage por lado com sinal "positivo = pior": compra paga mais, venda recebe menos', () => {
    const rows = slippageBySide([
      fill({ side: 'buy', solIn: 1_010n, tokenDelta: 1_000n, expectedPrice: 1 }),
      fill({ side: 'sell', solOut: 1_050n, tokenDelta: -1_000n, expectedPrice: 1 }),
      fill({ side: 'sell', status: 'failed', solOut: 0n, tokenDelta: 0n, expectedPrice: 1 }),
    ]);
    expect(rows[0]).toMatchObject({ side: 'buy', fills: 1, totalLamports: 10n });
    expect(rows[0]?.meanBps).toBeCloseTo(100, 9);
    expect(rows[1]).toMatchObject({ side: 'sell', fills: 1, totalLamports: -50n });
    expect(rows[1]?.meanBps).toBeCloseTo(-500, 9);
  });
});

describe('depois de cada venda', () => {
  it('máx/mín na janela, upside no máximo e resultado no fim, com bondingCurveSell; 4 h sem dados', () => {
    const { fills } = realOp(36_000_000_000n, MIN);
    const sell = fills[1];
    if (!sell) throw new Error('sem venda');
    const pts = [pt(T0 + 2 * MIN, 45_000_000_000n), pt(T0 + 10 * MIN, 33_000_000_000n), pt(T0 + 30 * MIN, 50_000_000_000n)];
    const [row] = postExitAnalysis([{ fill: sell, reason: 'stop_loss' }], market(pts, 2), FEES);
    const w15 = row?.windows[0];
    const tokens = -sell.tokenDelta;
    const at = (vq: bigint): bigint => bondingCurveSell({ virtualQuote: vq, virtualToken: K / vq }, tokens, FEES).netQuoteOut - sell.solOut;
    expect(w15).toMatchObject({ status: 'ok', upsideAtMaxLamports: at(45_000_000_000n), holdToEndLamports: at(33_000_000_000n) });
    expect(row?.windows[1]).toMatchObject({ status: 'ok', upsideAtMaxLamports: at(50_000_000_000n), holdToEndLamports: at(50_000_000_000n) });
    expect(row?.windows[2]).toMatchObject({ status: 'no_data', maxRatio: null });
  });
});

describe('regras de saída alternativas', () => {
  const base = { takeProfit: [{ gainPct: 0.4, sellFraction: 0.5 }, { gainPct: 1, sellFraction: 0.3 }], trailingStopPct: 0.25, stopLossPct: 0.2, timeStopSec: 600 };
  const rules = alternativeRules(base);
  const rule = (key: string): ExitRule => {
    const r = rules.find((x) => x.key === key);
    if (!r) throw new Error(key);
    return r;
  };
  const { op, metrics } = realOp(36_000_000_000n, MIN);
  const input = { mint: 'm', entryTs: T0, entryTokens: op.entry.tokenDelta, entryCost: metrics.entryCost, rentPaid: 1_513_840n, exitTxCost: COSTS.priorityFee + COSTS.jitoTip + COSTS.baseFee };
  const params = { fees: FEES, latencyMs: 800, horizonMs: 4 * 60 * MIN };
  const sellNet = (vq: bigint, tokens: bigint): bigint => bondingCurveSell({ virtualQuote: vq, virtualToken: K / vq }, tokens, FEES).netQuoteOut - input.exitTxCost;

  it('(a) vende tudo em +40%: dispara no trade e preenche nas reservas do último trade ≤ gatilho + 800 ms', () => {
    const pts = [pt(T0 - 1_000, VQ0), pt(T0 + 10_000, 52_000_000_000n), pt(T0 + 10_500, 53_000_000_000n), pt(T0 + 11_000, 40_000_000_000n)];
    const r = simulateExitRule(input, pts, null, coverage(5), rule('a'), params);
    expect(r.exits).toEqual(['take_profit_1']);
    expect(r.endedBy).toBe('regra');
    expect(r.net).toBe(sellNet(53_000_000_000n, input.entryTokens) + input.rentPaid - input.entryCost);
  });

  it('stop −20% e time stop no prazo mesmo sem trade', () => {
    const down = simulateExitRule(input, [pt(T0 + 5_000, 33_000_000_000n)], null, coverage(5), rule('a'), params);
    expect(down.exits).toEqual(['stop_loss']);
    const flat = simulateExitRule(input, [pt(T0 + 5_000, VQ0)], null, coverage(5), rule('a'), params);
    expect(flat.exits).toEqual(['time_stop']);
    expect(flat.closeTs).toBe(T0 + 600_000 + 800);
    expect(flat.net).toBe(sellNet(VQ0, input.entryTokens) + input.rentPaid - input.entryCost);
  });

  it('(c) trailing desde a entrada vende na queda de 25% do pico; (d) regra atual faz TP1 antes', () => {
    const pts = [pt(T0 + 5_000, 46_000_000_000n), pt(T0 + 6_000, 39_500_000_000n), pt(T0 + 20_000, 39_500_000_000n)];
    expect(simulateExitRule(input, pts, null, coverage(5), rule('c'), params).exits).toEqual(['trailing_stop']);
    const up = [pt(T0 + 5_000, 52_000_000_000n), pt(T0 + 6_000, 52_000_000_000n), pt(T0 + 20_000, 38_000_000_000n), pt(T0 + 21_000, 38_000_000_000n)];
    expect(simulateExitRule(input, up, null, coverage(5), rule('d'), params).exits[0]).toBe('take_profit_1');
  });

  it('(f) moonbag: guarda a fração até o horizonte; graduação e falta de dados encerram no último preço da curva', () => {
    const pts = [pt(T0 + 5_000, 33_000_000_000n), pt(T0 + 6_000, 33_000_000_000n), pt(T0 + 3 * 60 * MIN, 60_000_000_000n)];
    const r = simulateExitRule(input, pts, null, coverage(5), rule('f40'), params);
    expect(r.exits).toEqual(['stop_loss', 'horizon_end']);
    expect(r.endedBy).toBe('horizonte');
    const g = simulateExitRule(input, [pt(T0 + 5_000, 33_000_000_000n), pt(T0 + 6_000, 33_000_000_000n), pt(T0 + 10 * MIN, 0n, 'pumpswap')], null, coverage(5), rule('f40'), params);
    expect(g.endedBy).toBe('graduou');
    const d = simulateExitRule(input, pts, null, coverage(1), rule('f40'), params);
    expect(d.endedBy).toBe('dados');
  });
});
