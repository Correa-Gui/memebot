import { bondingCurveBuy, bondingCurveSell } from '@memebot/curve-math';
import { quoteInForBudget } from '@memebot/risk';
import { describe, expect, it } from 'vitest';
import { buildOperations, computeReport, realMedianCostsFrom, recostWithRealMedian, fillCash, histogram, maxDrawdown, operationMetrics, percentile, sensitivity } from './compute.ts';
import type { ReportDecision, ReportFill } from './compute.ts';
import { formatReportJson, formatReportText, table } from './format.ts';
import { gapInterval, coveredMs, mergeIntervals, runQuality } from './quality.ts';
import { parseDecisionRows, parseFillRows } from './rows.ts';

const FEES = { protocolFeeBps: 95n, creatorFeeBps: 30n };
const VQ = 40_000_000_000n;
const K = 30_000_000_000n * 1_073_000_000_000_000n;
const R = { virtualQuote: VQ, virtualToken: K / VQ };
const COSTS = { priorityFee: 300_000n, jitoTip: 200_000n, baseFee: 5_000n };
const RENT = 1_513_840n;

function base(partial: Partial<ReportFill>): ReportFill {
  return {
    ts: 0, decisionId: 'd', mint: 'm', side: 'buy', status: 'filled', solIn: 0n, solOut: 0n, tokenDelta: 0n, protocolFee: 0n, creatorFee: 0n,
    ...COSTS, rent: 0n, rentRefund: 0n, expectedPrice: 0, realizedPrice: 0, venueUnverified: false, costEstimateSource: 'tx_costs_median',
    priorityFeeSource: 'tx_costs_median', jitoTipSource: 'tx_costs_median',
    virtualQuoteBefore: VQ, virtualTokenBefore: K / VQ, ...partial,
  };
}

/** Operação real: compra 0,05 SOL em R e vende tudo com o preço multiplicado por `mult` (vq × √mult aprox.). */
function op(mint: string, t: number, sellVq: bigint, opts: { size?: bigint; partial?: boolean } = {}): ReportFill[] {
  const size = opts.size ?? 50_000_000n;
  const b = bondingCurveBuy(R, quoteInForBudget(size, FEES), FEES);
  const buy = base({
    ts: t, decisionId: `${mint}-in`, mint, side: 'buy', solIn: b.totalQuoteCost, tokenDelta: b.tokenOut, protocolFee: b.protocolFee, creatorFee: b.creatorFee,
    rent: RENT, expectedPrice: Number(b.totalQuoteCost) / Number(b.tokenOut) * 0.99, realizedPrice: Number(b.totalQuoteCost) / Number(b.tokenOut),
  });
  const rs = { virtualQuote: sellVq, virtualToken: K / sellVq };
  const sell = (ts: number, tokens: bigint, last: boolean, id: string): ReportFill => {
    const s = bondingCurveSell(rs, tokens, FEES);
    return base({
      ts, decisionId: id, mint, side: 'sell', solOut: s.netQuoteOut, tokenDelta: -tokens, protocolFee: s.protocolFee, creatorFee: s.creatorFee,
      rentRefund: last ? RENT : 0n, virtualQuoteBefore: rs.virtualQuote, virtualTokenBefore: rs.virtualToken,
      expectedPrice: Number(s.netQuoteOut) / Number(tokens), realizedPrice: Number(s.netQuoteOut) / Number(tokens),
    });
  };
  if (opts.partial) {
    const half = b.tokenOut / 2n;
    return [buy, sell(t + 1_000, half, false, `${mint}-out1`), base({ ts: t + 1_500, decisionId: `${mint}-outf`, mint, side: 'sell', status: 'failed', jitoTip: 0n }), sell(t + 2_000, b.tokenOut - half, true, `${mint}-out2`)];
  }
  return [buy, sell(t + 1_000, b.tokenOut, true, `${mint}-out`)];
}

const exitDecisions = (fills: readonly ReportFill[], reason: string): ReportDecision[] =>
  fills.filter((f) => f.side === 'sell').map((f) => ({ ts: f.ts, decisionId: f.decisionId, mint: f.mint, type: 'exit' as const, reason }));

describe('operações', () => {
  it('reconstrói operações (parciais, venda falha como custo), separa entradas não executadas e abertas', () => {
    const fills = [...op('a', 0, 50_000_000_000n, { partial: true }), base({ ts: 5, decisionId: 'x-in', mint: 'x', status: 'failed', jitoTip: 0n }), op('b', 10_000, 45_000_000_000n)[0] as ReportFill];
    const { operations, failedEntries } = buildOperations(fills, new Map([['a-out2', 'take_profit_2']]));
    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({ mint: 'a', closed: true, exitReason: 'take_profit_2' });
    expect(operations[0]?.fills).toHaveLength(4);
    expect(operations[1]).toMatchObject({ mint: 'b', closed: false });
    expect(failedEntries.map((f) => f.mint)).toEqual(['x']);
  });

  it('bruto − líquido = taxas da curva + priority + tip + taxa base + rent líquido', () => {
    const fills = op('a', 0, 50_000_000_000n, { partial: true });
    const [o] = buildOperations(fills, new Map()).operations;
    if (!o) throw new Error('sem operação');
    const m = operationMetrics(o);
    expect(m.net).toBe(fills.reduce((acc, f) => acc + fillCash(f), 0n));
    expect(m.gross - m.net).toBe(m.curveFees + m.priorityFee + m.jitoTip + m.baseFee + m.rentNet);
    expect(m.rentNet).toBe(0n);
    expect(m.slippage).toBeGreaterThan(0n); // compra 1% acima do esperado
  });
});

describe('estatísticas', () => {
  it('percentil, histograma e drawdown', () => {
    expect(percentile([0, 1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([0, 10], 0.25)).toBe(2.5);
    const h = histogram([-0.9, -0.15, 0.05, 2]);
    expect(h.reduce((a, b) => a + b.count, 0)).toBe(4);
    expect(h[0]).toEqual({ label: '≤ -50%', count: 1 });
    expect(h.at(-1)).toEqual({ label: '> 100%', count: 1 });
    // acumulado 10, −20, −15, −25 → pico 10, vale −25 → dd 35
    expect(maxDrawdown([{ ts: 1, delta: 10n }, { ts: 2, delta: -30n }, { ts: 3, delta: 5n }, { ts: 4, delta: -10n }])).toBe(35n);
    expect(maxDrawdown([{ ts: 1, delta: -5n }])).toBe(5n); // pico inicial 0
  });
});

describe('sensibilidade', () => {
  it('no tamanho real com venda única reproduz exatamente o PnL líquido real', () => {
    const fills = op('a', 0, 50_000_000_000n);
    const { operations, failedEntries } = buildOperations(fills, new Map());
    const real = fills.reduce((acc, f) => acc + fillCash(f), 0n);
    const row = sensitivity(operations, failedEntries, 50_000_000n, FEES, 50_000_000n);
    expect(row).toMatchObject({ operations: 1, skipped: 0, netLamports: real, hypothetical: false });
  });

  it('tamanho maior: mais impacto (retorno % menor num ganho), marcado hipotético acima do hard limit; sem reservas → ignorada', () => {
    const fills = op('a', 0, 60_000_000_000n);
    const { operations } = buildOperations(fills, new Map());
    const small = sensitivity(operations, [], 50_000_000n, FEES, 50_000_000n);
    const big = sensitivity(operations, [], 500_000_000n, FEES, 50_000_000n);
    expect(big.hypothetical).toBe(true);
    const fixed = COSTS.priorityFee * 2n + COSTS.jitoTip * 2n + COSTS.baseFee * 2n;
    expect(Number(big.netLamports + fixed) / 500e6).toBeLessThan(Number(small.netLamports + fixed) / 50e6);
    const noRes = buildOperations(fills.map((f) => ({ ...f, virtualQuoteBefore: 0n })), new Map()).operations;
    expect(sensitivity(noRes, [], 50_000_000n, FEES, 50_000_000n)).toMatchObject({ operations: 0, skipped: 1 });
  });
});

describe('computeReport', () => {
  const win = op('w', 0, 60_000_000_000n);
  const loss = op('l', 10_000, 30_000_000_000n);
  const failed = base({ ts: 20_000, decisionId: 'f-in', mint: 'f', status: 'expired', jitoTip: 0n, costEstimateSource: 'fallback' });
  const decisions: ReportDecision[] = [
    ...exitDecisions(win, 'take_profit_1'), ...exitDecisions(loss, 'stop_loss'),
    { ts: 1, decisionId: 'r1', mint: 'x', type: 'reject', reason: 'minUniqueHolders' },
    { ts: 2, decisionId: 'r2', mint: 'x', type: 'reject', reason: 'minUniqueHolders' },
    { ts: 3, decisionId: 'r3', mint: 'y', type: 'reject', reason: 'minUniqueHolders' },
    { ts: 4, decisionId: 'r4', mint: 'y', type: 'reject', reason: 'minVolume60sSol' },
  ];
  const input = {
    runId: 'paper-1', mode: 'paper', startedAtMs: 0, decisions, fills: [...win, ...loss, failed], fees: FEES,
    sizeLamports: 50_000_000n, maxOpenPositions: 3, hardLimitPositionLamports: 50_000_000n,
    sensitivitySizesLamports: [50_000_000n, 100_000_000n, 250_000_000n, 500_000_000n],
  };

  it('números, critérios §7, rejeições por mints distintos, custos e fallback', () => {
    const r = computeReport(input);
    const netWin = win.reduce((a, f) => a + fillCash(f), 0n);
    const netLoss = loss.reduce((a, f) => a + fillCash(f), 0n);
    expect(netWin).toBeGreaterThan(0n);
    expect(netLoss).toBeLessThan(0n);
    expect(r.operations).toMatchObject({ total: 2, closed: 2, open: 0, failedEntries: 1 });
    expect(r.hitRate).toBe(0.5);
    expect(r.netLamports).toBe(netWin + netLoss + fillCash(failed));
    expect(r.netWithoutTop3Lamports).toBe(fillCash(failed));
    expect(r.capitalLamports).toBe(150_000_000n);
    expect(r.exitReasons).toEqual([{ reason: 'stop_loss', count: 1 }, { reason: 'take_profit_1', count: 1 }]);
    expect(r.stopLosses).toMatchObject({ count: 1, losingCount: 1, overOneAndHalfConfiguredStop: 1, configuredStopPct: 0.2 });
    expect(r.stopLosses.averageLossLamports).toBe(netLoss);
    const stopOperation = buildOperations(loss, new Map([['l-out', 'stop_loss']])).operations[0];
    if (!stopOperation) throw new Error('operação de stop ausente');
    expect(r.stopLosses.averageLossPct).toBe(operationMetrics(stopOperation).returnRatio);
    expect(r.rejectedTokensByReason).toEqual([{ reason: 'minUniqueHolders', tokens: 2 }, { reason: 'minVolume60sSol', tokens: 1 }]);
    expect(r.criteria.map((c) => c.ok)).toEqual([false, r.netLamports > 0n, false, r.maxDrawdownPct <= 0.3]);
    expect(r.fallbackFills).toBe(1);
    expect(r.costs.find((c) => c.category.startsWith('taxa base'))?.avgLamports).toBe(10_000n);
    expect(r.sensitivity).toHaveLength(4);
    expect(r.sensitivity[0]?.netLamports).toBe(r.netLamports);
    // drawdown: ganho primeiro, depois perda e custo da expirada
    expect(r.maxDrawdownLamports).toBe(-(netLoss + fillCash(failed)));
  });

  it('texto alinhado com ✓/✗ e limitações; JSON com bigint como string', () => {
    const r = computeReport(input);
    const text = formatReportText(r);
    expect(text).toContain('Critério de sucesso');
    expect(text).toMatch(/✗ +≥ 200 operações/);
    expect(text).toContain('HIPOTÉTICO');
    expect(text).toContain('2.1 Stops');
    expect(text).toContain('perda média nos stops');
    expect(text).toContain('1,5× stop configurado');
    expect(text).toContain('NÃO modela o efeito');
    const json = JSON.parse(formatReportJson(r)) as { netLamports: string };
    expect(json.netLamports).toBe(r.netLamports.toString());
    expect(table(['a', 'bb'], [['ccc', '1']], ['l', 'r'])).toBe('a    bb\n---  --\nccc   1');
  });
});

describe('parse das linhas do ClickHouse', () => {
  it('fills e decisions (u64 como string, features JSON)', () => {
    const fills = parseFillRows([{
      ts_ms: '1000', decision_id: 'd', mint: 'm', side: 'sell', status: 'filled', sol_in: '0', sol_out: '10', token_delta: '-5', protocol_fee: '1', creator_fee: '1',
      priority_fee: '2', jito_tip: '3', base_fee: '5000', rent: '0', rent_refund: '1513840', expected_price_lamports_per_unit: 0.1,
      realized_price_lamports_per_unit: 0.09, venue_unverified: 1, cost_estimate_source: 'fallback', virtual_quote_before: '40000000000', virtual_token_before: '1',
    }]);
    expect(fills[0]).toMatchObject({ tokenDelta: -5n, baseFee: 5_000n, venueUnverified: true, virtualQuoteBefore: 40_000_000_000n });
    const d = parseDecisionRows([{ ts_ms: '1', decision_id: 'e', mint: 'm', type: 'enter', reason: 'momentum_trigger', features_json: '{"protocolFeeBps":95}' }]);
    expect(d.features.get('e')).toEqual({ protocolFeeBps: 95 });
    expect(() => parseFillRows([{ side: 'x' }])).toThrow();
  });
});

describe('origem dos custos e comparação com a mediana real', () => {
  const fills = op('a', 0, 60_000_000_000n).map((f) => ({ ...f, priorityFeeSource: 'tx_costs_p75', jitoTipSource: 'fallback', costEstimateSource: 'fallback' }));
  const failed = base({ ts: 5_000, decisionId: 'x-in', mint: 'x', status: 'failed', jitoTip: 0n, priorityFeeSource: 'fallback', jitoTipSource: 'fallback' });
  const input = {
    runId: 'r', mode: 'paper', startedAtMs: 0, decisions: [] as ReportDecision[], fills: [...fills, failed], fees: FEES,
    sizeLamports: 50_000_000n, maxOpenPositions: 3, hardLimitPositionLamports: 50_000_000n, sensitivitySizesLamports: [],
  };

  it('mediana real × 1,5 por tipo (tip só > 0), com teto; sem amostras → null', () => {
    const caps = { maxPriorityFeeLamports: 2_000_000n, maxJitoTipLamports: 150_000n };
    expect(realMedianCostsFrom([{ priorityFee: 100_000n, jitoTip: 0n }, { priorityFee: 200_000n, jitoTip: 100_000n }, { priorityFee: 300_000n, jitoTip: null }], caps))
      .toEqual({ priorityFeeLamports: 300_000n, jitoTipLamports: 150_000n });
    expect(realMedianCostsFrom([], caps)).toEqual({ priorityFeeLamports: null, jitoTipLamports: null });
  });

  it('recost troca só origem ≠ mediana; tip só em fill executado', () => {
    const r = recostWithRealMedian([...fills, failed, base({ priorityFee: 9n })], { priorityFeeLamports: 1_000n, jitoTipLamports: 2_000n });
    expect(r.changed).toBe(3);
    expect(r.fills[0]).toMatchObject({ priorityFee: 1_000n, jitoTip: 2_000n });
    expect(r.fills[2]).toMatchObject({ priorityFee: 1_000n, jitoTip: 0n });
    expect(r.fills[3]).toMatchObject({ priorityFee: 9n }); // mediana: intocado
  });

  it('report conta origens por tipo e mostra "como rodou" × "com mediana real" lado a lado', () => {
    const r = computeReport({ ...input, realMedianCosts: { priorityFeeLamports: 10_000n, jitoTipLamports: 20_000n } });
    expect(r.costSources).toEqual({ priority: { tx_costs_p75: 2, fallback: 1 }, tip: { fallback: 3 } });
    const cmp = r.realMedianComparison;
    if (!cmp) throw new Error('sem comparação');
    expect(cmp.recostedFills).toBe(3);
    // custos menores → PnL maior exatamente pela diferença de custos
    const saved = (COSTS.priorityFee - 10_000n) * 3n + (COSTS.jitoTip - 20_000n) * 2n;
    expect(cmp.realMedian.netLamports - cmp.asRun.netLamports).toBe(saved);
    expect(cmp.asRun.criteria).toHaveLength(4);
    expect(formatReportText(r)).toContain('com mediana real');
    // tudo mediana → sem comparação
    expect(computeReport({ ...input, fills: op('b', 0, 60_000_000_000n), realMedianCosts: { priorityFeeLamports: 1n, jitoTipLamports: 1n } }).realMedianComparison).toBeNull();
  });
});

describe('lacunas do stream e qualidade medida', () => {
  it('intervalo da lacuna: duration_ms; linha antiga → "desconectado por N ms" + 30 s', () => {
    expect(gapInterval({ detectedAtMs: 100_000, durationMs: 40_000, detail: 'x' })).toEqual({ fromMs: 60_000, toMs: 100_000, estimated: false });
    expect(gapInterval({ detectedAtMs: 100_000, durationMs: 0, detail: 'desconectado por 32670 ms' })).toEqual({ fromMs: 37_330, toMs: 100_000, estimated: true });
    expect(mergeIntervals([{ fromMs: 0, toMs: 10 }, { fromMs: 5, toMs: 20 }, { fromMs: 30, toMs: 40 }])).toEqual([{ fromMs: 0, toMs: 20 }, { fromMs: 30, toMs: 40 }]);
    expect(coveredMs([{ fromMs: -10, toMs: 20 }, { fromMs: 90, toMs: 200 }], 0, 100)).toBe(30);
  });

  it('qualidade: v_run_quality quando há; senão fallback sobre [início, fim] com limite de 1%', () => {
    expect(runQuality({ uptimeMs: 3_600_000, streamGapMs: 10_000 }, [], 0, 1)).toMatchObject({ source: 'run_health', quality: 'production' });
    const q = runQuality(null, [{ detectedAtMs: 1_000_000, durationMs: 0, detail: 'desconectado por 10000 ms' }], 0, 3_600_000);
    expect(q).toMatchObject({ source: 'ingest_gaps_fallback', streamGapMs: 40_000, uptimeMs: 3_600_000, quality: 'provisional', estimatedGaps: 1 });
  });

  it('marca operações cuja [entrada, saída] cruza uma lacuna e mostra o PnL com e sem elas', () => {
    const inGap = op('g', 100_000, 60_000_000_000n); // 100 s → 101 s
    const clean = op('c', 500_000, 30_000_000_000n);
    const r = computeReport({
      runId: 'r', mode: 'paper', startedAtMs: 0, decisions: [], fills: [...inGap, ...clean], fees: FEES, sizeLamports: 50_000_000n,
      maxOpenPositions: 3, hardLimitPositionLamports: 50_000_000n, sensitivitySizesLamports: [],
      gaps: [{ detectedAtMs: 130_000, durationMs: 0, detail: 'desconectado por 5000 ms' }], // [95 s, 130 s]
    });
    expect(r.gapOperations.operations.map((o) => o.mint)).toEqual(['g']);
    const netG = inGap.reduce((a, f) => a + fillCash(f), 0n);
    expect(r.gapOperations.netWithLamports - r.gapOperations.netWithoutLamports).toBe(netG);
    expect(r.quality.source).toBe('ingest_gaps_fallback');
    expect(r.endMs).toBe(501_000);
    const text = formatReportText(r);
    expect(text).toContain('qualidade medida do stream');
    expect(text).toContain('lacunas do stream');
  });
});

describe('run descartado', () => {
  it('aviso no topo com o motivo; relatório continua sendo gerado', () => {
    const r = computeReport({
      runId: 'r', mode: 'paper', startedAtMs: 0, decisions: [], fills: [], fees: FEES, sizeLamports: 50_000_000n, maxOpenPositions: 3,
      hardLimitPositionLamports: 50_000_000n, sensitivitySizesLamports: [], discardReason: 'reiniciado por mudança de config',
    });
    const text = formatReportText(r);
    expect(text.split('\n')[1]).toBe('!!! RUN DESCARTADO — motivo: reiniciado por mudança de config');
    expect(text).toContain('Relatório do run r');
    expect(formatReportText({ ...r, discardReason: null })).not.toContain('DESCARTADO');
  });
});
