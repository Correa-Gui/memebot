import { describe, expect, it } from 'vitest';
import type { PumpSwapTradeEvent } from '@memebot/core';
import { bondingCurveSell, effectiveQuoteReserves, pumpSwapBuyExactQuoteIn, pumpSwapSell } from '@memebot/curve-math';
import type { MarketState } from '@memebot/state';
import { InvalidOrderError, PumpSwapSimulationNotValidatedError, createPaperExecutorState, settleOnTick, submitOrder } from '../src/index.ts';
import type { Fill, PaperExecutorParams } from '../src/index.ts';
import { FEES, INITIAL_VIRTUAL_QUOTE, INITIAL_VIRTUAL_TOKEN, MINT, RENT_FIXTURE, T0, applyAll, completed, initialMarket, params, poolCreated, trade } from './helpers.ts';

/**
 * Universo graduado (experimento de 2026-10-03): com `pumpSwapEnabled`, o executor simula compra e venda
 * no PumpSwap com a matemática exata (`curve-math/pumpswap.ts`), usando as reservas DEPOIS do último trade
 * e os bps EFETIVOS do estado. Sem a flag, nada muda (testes de paper.test.ts).
 */
const POOL = 'poolA';
const B0 = 206_900_000_000_000n;
const Q0 = 67_000_000_000n;
const VQ = 17_584_505_396n;
const BPS = { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n, cashbackFeeBps: 0n };

function swapTrade(ts: number, opts: { withDetails?: boolean; creatorFee?: bigint } = {}): PumpSwapTradeEvent {
  return {
    kind: 'trade', venue: 'pumpswap', slot: BigInt(ts), ts, sig: `ps-${String(ts)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: ts, rawB64: '',
    pool: POOL, mint: MINT, quoteMint: 'So11111111111111111111111111111111111111112', poolUnresolved: false, trader: 'other', side: 'buy',
    tokenAmount: 1_000_000_000n, quoteAmount: 400_000n, userQuoteAmount: 404_800n, poolBaseReserves: B0, poolQuoteReserves: Q0,
    lpFee: 800n, protocolFee: 200n, creatorFee: opts.creatorFee ?? 3_800n, ixName: 'buy_exact_quote_in',
    ...(opts.withDetails === false
      ? {}
      : { swapDetails: { instruction: 'buy_exact_quote_in', virtualQuoteReserves: VQ, ...BPS, cashbackFee: 0n, buybackFeeBps: 0n, buybackFee: 0n, holderRewardsBps: 0n, holderRewards: 0n, baseSupply: 1_000_000_000_000_000n } }),
  };
}

/** Reservas que o estado guarda DEPOIS do trade sintético (delta do próprio evento). */
const AFTER = { base: B0 - 1_000_000_000n, quote: Q0 + 400_000n + 800n, virtualQuote: VQ };

function graduatedMarket(opts: { withDetails?: boolean; creatorFee?: bigint } = {}): MarketState {
  return applyAll([completed(MINT, T0 - 2_000), poolCreated(MINT, T0 - 1_000), swapTrade(T0 - 500, opts)], initialMarket());
}

const enabled = (p: Partial<PaperExecutorParams> = {}): PaperExecutorParams => params({ latencyMs: 0, pumpSwapEnabled: true, ...p });
const buy = { side: 'buy' as const, decisionId: 'd-buy', mint: MINT, sizeLamports: 50_000_000n, maxSlippageBps: 1500 };
const sellAll = { side: 'sell' as const, decisionId: 'd-sell', mint: MINT, fraction: 1, maxSlippageBps: 1500 };

function only(fills: Fill[]): Fill {
  expect(fills).toHaveLength(1);
  const f = fills[0];
  if (!f) throw new Error('sem fill');
  return f;
}

describe('paper executor — PumpSwap liberado (pumpSwapEnabled)', () => {
  it('compra = buy_exact_quote_in com spendable = tamanho; taxas no fill; reservas efetivas antes', () => {
    const market = graduatedMarket();
    const p = enabled();
    const s = submitOrder(createPaperExecutorState(1), p, buy, market, T0);
    const f = only(settleOnTick(s, p, market, T0).fills);
    const sim = pumpSwapBuyExactQuoteIn(AFTER, 50_000_000n, BPS);
    expect(f).toMatchObject({
      status: 'filled', solIn: sim.totalQuoteCost, tokenDelta: sim.baseOut, protocolFee: sim.lpFee + sim.protocolFee + sim.cashbackFee,
      creatorFee: sim.creatorFee, rent: RENT_FIXTURE, venueUnverified: false, virtualQuoteBefore: effectiveQuoteReserves(AFTER), virtualTokenBefore: AFTER.base,
    });
    expect(f.solIn).toBeLessThanOrEqual(50_000_000n);
  });

  it('venda da posição comprada no PumpSwap = pumpSwapSell exato; ida e volta imediata sempre perde', () => {
    const market = graduatedMarket();
    const p = enabled();
    const s1 = settleOnTick(submitOrder(createPaperExecutorState(1), p, buy, market, T0), p, market, T0);
    const bought = only(s1.fills);
    const s2 = submitOrder(s1.state, p, sellAll, market, T0 + 10);
    const sold = only(settleOnTick(s2, p, market, T0 + 10).fills);
    const expected = pumpSwapSell(AFTER, bought.tokenDelta, BPS);
    expect(sold).toMatchObject({ status: 'filled', solOut: expected.netQuoteOut, tokenDelta: -bought.tokenDelta, rentRefund: RENT_FIXTURE, venueUnverified: false });
    // nossa compra não entra no MarketState (pessimismo): mesmas reservas na venda → perde as taxas de ida e volta
    expect(sold.solOut).toBeLessThan(bought.solIn);
  });

  it('pool sem criador (taxa do criador 0 no evento): bps efetivo do criador 0 na simulação', () => {
    const market = graduatedMarket({ creatorFee: 0n });
    const p = enabled();
    const f = only(settleOnTick(submitOrder(createPaperExecutorState(1), p, buy, market, T0), p, market, T0).fills);
    expect(f.creatorFee).toBe(0n);
    expect(f.tokenDelta).toBe(pumpSwapBuyExactQuoteIn(AFTER, 50_000_000n, { ...BPS, creatorFeeBps: 0n }).baseOut);
  });

  it('sem swapDetails (offset/bps desconhecidos) → ordem inválida, nunca simula com dado incompleto', () => {
    const market = graduatedMarket({ withDetails: false });
    expect(() => submitOrder(createPaperExecutorState(1), enabled(), buy, market, T0)).toThrow(InvalidOrderError);
  });

  it('sem a flag: compra no PumpSwap continua proibida (erro tipado)', () => {
    expect(() => submitOrder(createPaperExecutorState(1), params({ latencyMs: 0 }), buy, graduatedMarket(), T0)).toThrow(PumpSwapSimulationNotValidatedError);
  });

  it('com a flag, posição de CURVA que gradua continua fechando no último preço da curva (venue_unverified)', () => {
    const p = enabled();
    const market = initialMarket();
    const s1 = settleOnTick(submitOrder(createPaperExecutorState(1), p, buy, market, T0), p, market, T0);
    const bought = only(s1.fills);
    const lastVq = 85_000_000_000n;
    const lastVt = (INITIAL_VIRTUAL_QUOTE * INITIAL_VIRTUAL_TOKEN) / lastVq;
    const grad = applyAll([trade(MINT, T0 + 100, lastVq, lastVt), completed(MINT, T0 + 101), poolCreated(MINT, T0 + 102), swapTrade(T0 + 103)], market);
    const sold = only(settleOnTick(submitOrder(s1.state, p, sellAll, grad, T0 + 200), p, grad, T0 + 200).fills);
    expect(sold).toMatchObject({ status: 'filled', venueUnverified: true, solOut: bondingCurveSell({ virtualQuote: lastVq, virtualToken: lastVt }, bought.tokenDelta, FEES).netQuoteOut });
  });

  it('slippage: reservas pioram entre a submissão e o preenchimento além do limite → expired', () => {
    const market = graduatedMarket();
    const p = enabled({ latencyMs: 800 });
    const s = submitOrder(createPaperExecutorState(1), p, { ...buy, maxSlippageBps: 100 }, market, T0);
    // compra grande de terceiro: o preço sobe ~20% antes do nosso preenchimento
    const pumped = applyAll([{ ...swapTrade(T0 + 100), sig: 'big', tokenAmount: 20_000_000_000_000n, quoteAmount: 9_000_000_000n, userQuoteAmount: 9_100_000_000n, lpFee: 18_000_000n, poolBaseReserves: AFTER.base, poolQuoteReserves: AFTER.quote }], market);
    expect(only(settleOnTick(s, p, pumped, T0 + 800).fills)).toMatchObject({ status: 'expired', error: 'slippage_exceeded' });
  });
});
