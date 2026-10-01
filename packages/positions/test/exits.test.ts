import { describe, expect, it } from 'vitest';
import type { Position } from '../src/index.ts';
import { applyExitFill, evaluateExits, markExitSubmitted, netPnlRatio, openPosition } from '../src/index.ts';
import { BASE_FEE, CREATOR, CTX, INITIAL_VIRTUAL_QUOTE, MINT, RENT_FIXTURE, SUPPLY, T0, buyFill, realConfig, sellFill, tokenAt, trade } from './helpers.ts';

const config = realConfig().exits;

/** Menor vq (preço) em que o PnL líquido da posição atinge `target` (busca binária; preço cresce com vq). */
function vqForPnl(position: Position, target: number): bigint {
  let lo = 1_000_000_000n;
  let hi = 2_000_000_000_000n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const pnl = netPnlRatio(position, tokenAt(mid), CTX) ?? Number.NaN;
    if (pnl >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

function evalAt(position: Position, vq: bigint, nowMs = T0 + 10_000, extra: Parameters<typeof tokenAt>[1] = []) {
  return evaluateExits(position, tokenAt(vq, extra), nowMs, config, CTX);
}

describe('openPosition e PnL líquido', () => {
  it('custo de entrada = solIn + priority + tip + taxa base + rent', () => {
    const fill = buyFill();
    const pos = openPosition(fill);
    expect(pos.entryCostLamports).toBe(fill.solIn + 225_000n + 300_000n + BASE_FEE + RENT_FIXTURE);
    expect(pos.tokenAmount).toBe(fill.tokenDelta);
  });

  it('logo após entrar, nas mesmas reservas, o PnL líquido é negativo (taxas de ida e volta)', () => {
    const pos = openPosition(buyFill());
    const pnl = netPnlRatio(pos, tokenAt(INITIAL_VIRTUAL_QUOTE), CTX);
    expect(pnl).not.toBeNull();
    expect(pnl ?? 0).toBeLessThan(0);
    expect(evalAt(pos, INITIAL_VIRTUAL_QUOTE).orders).toEqual([]);
  });

  it('openPosition recusa fill que não é compra preenchida', () => {
    expect(() => openPosition({ ...buyFill(), status: 'failed', tokenDelta: 0n })).toThrow();
  });
});

describe('regras de saída isoladas', () => {
  const pos = openPosition(buyFill());

  it('take profit 1: +40% líquido vende 50% da quantidade inicial', () => {
    expect(evalAt(pos, vqForPnl(pos, 0.39)).orders).toEqual([]);
    expect(evalAt(pos, vqForPnl(pos, 0.41)).orders).toEqual([{ mint: MINT, fraction: 0.5, reason: 'take_profit_1', takeProfitStep: 1 }]);
  });

  it('take profit 2: depois do TP1, +100% vende mais 30% da inicial (= 60% do restante)', () => {
    const afterTp1: Position = { ...pos, tokenAmount: pos.initialTokenAmount / 2n, takeProfitStepsDone: 1 };
    const out = evalAt(afterTp1, vqForPnl(afterTp1, 1.01)).orders;
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe('take_profit_2');
    expect(out[0]?.takeProfitStep).toBe(2);
    expect(out[0]?.fraction).toBeCloseTo(0.6, 9);
  });

  it('pulo de vários degraus num tick vende a soma numa ordem só', () => {
    const out = evalAt(pos, vqForPnl(pos, 1.05)).orders;
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe('take_profit_2');
    expect(out[0]?.fraction).toBeCloseTo(0.8, 9);
  });

  it('stop loss: −20% líquido vende tudo', () => {
    expect(evalAt(pos, vqForPnl(pos, -0.19)).orders).toEqual([]);
    expect(evalAt(pos, vqForPnl(pos, -0.21)).orders).toEqual([{ mint: MINT, fraction: 1, reason: 'stop_loss', takeProfitStep: null }]);
  });

  it('time stop: 10 min sem TP1 vende tudo; com TP1 feito não dispara', () => {
    const vq = INITIAL_VIRTUAL_QUOTE;
    expect(evalAt(pos, vq, T0 + 599_999).orders).toEqual([]);
    expect(evalAt(pos, vq, T0 + 600_000).orders).toEqual([{ mint: MINT, fraction: 1, reason: 'time_stop', takeProfitStep: null }]);
    const afterTp1: Position = { ...pos, tokenAmount: pos.initialTokenAmount / 2n, takeProfitStepsDone: 1 };
    expect(evalAt(afterTp1, vq, T0 + 600_000).orders.some((o) => o.reason === 'time_stop')).toBe(false);
  });

  it('trailing: só depois do TP1; −25% da máxima LÍQUIDA do restante vende tudo', () => {
    const afterTp1: Position = { ...pos, tokenAmount: pos.initialTokenAmount / 2n, takeProfitStepsDone: 1 };
    const high = evalAt(afterTp1, 60_000_000_000n);
    expect(high.orders).toEqual([]);
    const peak = high.position.trailingPeakLamports;
    expect(peak).not.toBeNull();
    // queda pequena: atualiza nada, não dispara
    const small = evalAt(high.position, 57_000_000_000n);
    expect(small.orders).toEqual([]);
    expect(small.position.trailingPeakLamports).toBe(peak);
    // queda grande: dispara
    const big = evalAt(high.position, 50_000_000_000n);
    expect(big.orders).toEqual([{ mint: MINT, fraction: 1, reason: 'trailing_stop', takeProfitStep: null }]);
    // sem TP1 não há trailing (a mesma queda não dispara trailing)
    const noTp: Position = { ...pos, trailingPeakLamports: peak };
    expect(evalAt(noTp, 50_000_000_000n).orders.some((o) => o.reason === 'trailing_stop')).toBe(false);
  });

  it('emergência: venda individual > 5% do supply depois da entrada vende tudo', () => {
    const big = trade(MINT, T0 + 5_000, INITIAL_VIRTUAL_QUOTE, { side: 'sell', tokenAmount: (SUPPLY * 5n) / 100n + 1n });
    expect(evalAt(pos, INITIAL_VIRTUAL_QUOTE, T0 + 6_000, [big]).orders[0]?.reason).toBe('emergency_large_sell');
    const exact = trade(MINT, T0 + 5_000, INITIAL_VIRTUAL_QUOTE, { side: 'sell', tokenAmount: (SUPPLY * 5n) / 100n });
    expect(evalAt(pos, INITIAL_VIRTUAL_QUOTE, T0 + 6_000, [exact]).orders).toEqual([]);
    const before = trade(MINT, T0 - 500, INITIAL_VIRTUAL_QUOTE, { side: 'sell', tokenAmount: SUPPLY / 10n });
    expect(evalAt(pos, INITIAL_VIRTUAL_QUOTE, T0 + 6_000, [before]).orders).toEqual([]);
  });

  it('emergência: criador vendendo depois da entrada vende tudo', () => {
    const sale = trade(MINT, T0 + 5_000, INITIAL_VIRTUAL_QUOTE, { side: 'sell', trader: CREATOR, tokenAmount: 10n });
    expect(evalAt(pos, INITIAL_VIRTUAL_QUOTE, T0 + 6_000, [sale]).orders).toEqual([
      { mint: MINT, fraction: 1, reason: 'emergency_creator_sell', takeProfitStep: null },
    ]);
  });

  it('graduação (curve_completed) vende tudo', () => {
    const done = { kind: 'curve_completed' as const, mint: MINT, bondingCurve: 'bc', slot: 1n, ts: T0 + 5_000, sig: 'x', eventIndex: 0, receivedAtMs: 0, recvSeq: 0, rawB64: '' };
    expect(evalAt(pos, INITIAL_VIRTUAL_QUOTE, T0 + 6_000, [done]).orders[0]?.reason).toBe('graduated');
  });
});

describe('precedência e pendência', () => {
  const pos = openPosition(buyFill());

  it('emergência vence stop loss; stop loss vence time stop', () => {
    const vqLoss = vqForPnl(pos, -0.3);
    const sale = trade(MINT, T0 + 5_000, vqLoss, { side: 'sell', trader: CREATOR, tokenAmount: 10n });
    expect(evalAt(pos, vqLoss, T0 + 700_000, [sale]).orders[0]?.reason).toBe('emergency_creator_sell');
    expect(evalAt(pos, vqLoss, T0 + 700_000).orders[0]?.reason).toBe('stop_loss');
  });

  it('com saída pendente não emite nova ordem', () => {
    const pending = markExitSubmitted(pos, { mint: MINT, fraction: 1, reason: 'stop_loss', takeProfitStep: null });
    expect(evalAt(pending, vqForPnl(pos, -0.5)).orders).toEqual([]);
  });
});

describe('applyExitFill', () => {
  it('parcial: aloca custo proporcional, marca o degrau de TP; total: fecha a posição', () => {
    const pos = openPosition(buyFill());
    const order = { mint: MINT, fraction: 0.5, reason: 'take_profit_1' as const, takeProfitStep: 1 };
    const half = pos.tokenAmount / 2n;
    const r1 = applyExitFill(markExitSubmitted(pos, order), sellFill({ tokenDelta: -half, solOut: 40_000_000n, priorityFee: 225_000n, jitoTip: 300_000n, baseFee: BASE_FEE }));
    expect(r1.position).not.toBeNull();
    const p1 = r1.position as Position;
    expect(p1.takeProfitStepsDone).toBe(1);
    expect(p1.exitPending).toBeNull();
    const allocated = (pos.entryCostLamports * half) / pos.tokenAmount;
    expect(r1.realizedPnlDelta).toBe(40_000_000n - 525_000n - BASE_FEE - allocated);

    const r2 = applyExitFill(p1, sellFill({ tokenDelta: -p1.tokenAmount, solOut: 30_000_000n, rentRefund: RENT_FIXTURE }));
    expect(r2.position).toBeNull();
    expect(r1.realizedPnlDelta + r2.realizedPnlDelta).toBe(40_000_000n - 525_000n - BASE_FEE + 30_000_000n + RENT_FIXTURE - pos.entryCostLamports);
  });

  it('falha/expiração: perde só o custo da transação e mantém a posição', () => {
    const pos = openPosition(buyFill());
    const r = applyExitFill(pos, sellFill({ status: 'failed', priorityFee: 225_000n, baseFee: BASE_FEE }));
    expect(r.realizedPnlDelta).toBe(-225_000n - BASE_FEE);
    expect(r.position?.tokenAmount).toBe(pos.tokenAmount);
  });
});

describe('taxa base na liquidação', () => {
  it('L desconta a taxa base da saída: com taxa base o PnL líquido é menor', () => {
    const pos = openPosition(buyFill());
    const token = tokenAt(INITIAL_VIRTUAL_QUOTE * 2n);
    const withFee = netPnlRatio(pos, token, CTX) ?? Number.NaN;
    const withoutFee = netPnlRatio(pos, token, { ...CTX, exitBaseFeeLamports: 0n }) ?? Number.NaN;
    expect(withFee).toBeLessThan(withoutFee);
    expect((withoutFee - withFee) * Number(pos.entryCostLamports)).toBeCloseTo(Number(BASE_FEE), 3);
  });
});
