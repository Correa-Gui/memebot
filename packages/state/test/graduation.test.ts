import { describe, expect, it } from 'vitest';
import type { PumpEvent } from '@memebot/core';
import { MarketStore, applyEvent, createEmptyMarketState } from '../src/index.ts';
import { pumpSwapTrade } from './helpers.ts';

/** Universo graduado (2026-10-03): hora da graduação, preço por trade do PumpSwap e compactação de um mint. */
const details = { instruction: 'buy_exact_quote_in' as const, virtualQuoteReserves: 17_000_000_000n, lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n, cashbackFeeBps: 0n, cashbackFee: 0n, buybackFeeBps: 0n, buybackFee: 0n, holderRewardsBps: 0n, holderRewards: 0n, baseSupply: 1_000_000_000_000_000n };
const done = (ts: number): PumpEvent => ({ kind: 'curve_completed', slot: BigInt(ts), ts, sig: `c${String(ts)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: ts, rawB64: '', mint: 'm', bondingCurve: 'bc' });

describe('graduação e trades do PumpSwap no estado', () => {
  it('graduatedAtMs = primeiro curve_completed (não muda com repetição)', () => {
    let s = applyEvent(createEmptyMarketState(), done(1_000));
    s = applyEvent(s, done(5_000));
    expect(s.tokens.get('m')).toMatchObject({ curveCompleted: true, graduatedAtMs: 1_000 });
  });

  it('TradeRecord do PumpSwap guarda o par do constant product DEPOIS do trade (quote efetivo, base); supply do evento', () => {
    const e = pumpSwapTrade({ pool: 'p', ts: 2_000, side: 'buy', trader: 't', mint: 'm', poolUnresolved: false, swapDetails: details });
    const t = applyEvent(createEmptyMarketState(), e).tokens.get('m');
    const r = t?.pumpSwapReserves;
    if (!t || !r || r.virtualQuote === null) throw new Error('sem reservas');
    expect(t.trades.at(-1)).toMatchObject({ venue: 'pumpswap', virtualQuoteAfter: r.quote + r.virtualQuote, virtualTokenAfter: r.base });
    expect(t.tokenTotalSupply).toBe(details.baseSupply);
    // sem swapDetails: offset desconhecido → sem preço
    const bare = applyEvent(createEmptyMarketState(), pumpSwapTrade({ pool: 'p', ts: 2_000, side: 'buy', trader: 't', mint: 'm', poolUnresolved: false })).tokens.get('m');
    expect(bare?.trades.at(-1)).toMatchObject({ virtualQuoteAfter: null, virtualTokenAfter: null });
  });

  it('MarketStore.compactMint zera histórico e saldos do mint, mantendo reservas e graduação', () => {
    const store = new MarketStore();
    store.apply(done(1_000));
    store.apply(pumpSwapTrade({ pool: 'p', ts: 2_000, side: 'buy', trader: 't', mint: 'm', poolUnresolved: false, swapDetails: details }));
    const before = store.state.tokens.get('m');
    store.compactMint('m');
    const after = store.state.tokens.get('m');
    expect(after).toMatchObject({ trades: [], firstBuyers: [], graduatedAtMs: 1_000, pumpSwapReserves: before?.pumpSwapReserves });
    expect(after?.holderBalances.size).toBe(0);
  });
});
