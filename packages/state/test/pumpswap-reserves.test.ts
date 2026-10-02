import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PumpSwapSwapDetails } from '@memebot/core';
import { applyEvent, createEmptyMarketState, pumpSwapReservesAfter } from '../src/index.ts';
import { pumpSwapTrade } from './helpers.ts';

/**
 * Fixtures golden do PumpSwap (eventos reais; `after` = reservas do PRÓXIMO evento do mesmo pool),
 * de `packages/curve-math/scripts/extract-pumpswap-fixtures.ts`. Campos mapeados como o
 * `normalize` faz: compra → quoteAmount = quote_amount_in, userQuoteAmount = user_quote_amount_in;
 * venda → quoteAmount = quote_amount_out, userQuoteAmount = user_quote_amount_out.
 */
interface GoldenFixture {
  description: string;
  source: { pool: string; slot: string };
  ixName: 'buy' | 'buy_exact_quote_in' | 'sell';
  before: { base: string; quote: string; virtualQuote: string };
  feeBps: { lp: string; protocol: string; creator: string; cashback: string };
  event: { baseAmount: string; quoteAmount: string; userQuoteAmount: string; lpFee: string; cashback: string };
  after: { base: string; quote: string };
}
const golden = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'curve-math', 'test', 'fixtures', 'golden', 'pumpswap.json'), 'utf8'),
) as GoldenFixture[];

function detailsOf(fx: GoldenFixture): PumpSwapSwapDetails {
  return {
    instruction: fx.ixName,
    virtualQuoteReserves: BigInt(fx.before.virtualQuote),
    lpFeeBps: BigInt(fx.feeBps.lp),
    protocolFeeBps: BigInt(fx.feeBps.protocol),
    creatorFeeBps: BigInt(fx.feeBps.creator),
    cashbackFeeBps: BigInt(fx.feeBps.cashback),
    cashbackFee: BigInt(fx.event.cashback),
    buybackFeeBps: 0n,
    buybackFee: 0n,
    holderRewardsBps: 0n,
    holderRewards: 0n,
    baseSupply: 1_000_000_000_000_000n,
  };
}

function eventOf(fx: GoldenFixture, withDetails: boolean) {
  return pumpSwapTrade({
    pool: fx.source.pool,
    ts: 1000,
    slot: BigInt(fx.source.slot),
    side: fx.ixName === 'sell' ? 'sell' : 'buy',
    trader: 't',
    mint: 'mintA',
    poolUnresolved: false,
    tokenAmount: BigInt(fx.event.baseAmount),
    quoteAmount: BigInt(fx.event.quoteAmount),
    userQuoteAmount: BigInt(fx.event.userQuoteAmount),
    poolBaseReserves: BigInt(fx.before.base),
    poolQuoteReserves: BigInt(fx.before.quote),
    lpFee: BigInt(fx.event.lpFee),
    ixName: fx.ixName === 'sell' ? null : fx.ixName,
    ...(withDetails ? { swapDetails: detailsOf(fx) } : {}),
  });
}

describe('pumpSwapReserves = estado DEPOIS do trade (evento traz o ANTES)', () => {
  it.each(golden)('$description', (fx) => {
    const snap = pumpSwapReservesAfter(eventOf(fx, true));
    expect(snap.base).toBe(BigInt(fx.after.base));
    expect(snap.quote).toBe(BigInt(fx.after.quote));
    expect(snap.virtualQuote).toBe(BigInt(fx.before.virtualQuote));
    expect(snap.feeBps).toEqual({
      lpFeeBps: BigInt(fx.feeBps.lp),
      protocolFeeBps: BigInt(fx.feeBps.protocol),
      creatorFeeBps: BigInt(fx.feeBps.creator),
      cashbackFeeBps: BigInt(fx.feeBps.cashback),
    });
    expect(snap.lastSlot).toBe(BigInt(fx.source.slot));
  });

  it('sem swapDetails: reservas depois continuam exatas, offset/bps/supply ficam null (não precificar)', () => {
    const fx = golden[0];
    if (!fx) throw new Error('fixture ausente');
    const snap = pumpSwapReservesAfter(eventOf(fx, false));
    expect(snap.base).toBe(BigInt(fx.after.base));
    expect(snap.quote).toBe(BigInt(fx.after.quote));
    expect(snap).toMatchObject({ virtualQuote: null, feeBps: null, baseSupply: null });
  });

  it('applyEvent guarda o snapshot do último trade no TokenState', () => {
    const fx = golden.find((f) => f.ixName === 'buy_exact_quote_in');
    if (!fx) throw new Error('fixture ausente');
    const state = applyEvent(createEmptyMarketState(), eventOf(fx, true));
    expect(state.tokens.get('mintA')?.pumpSwapReserves).toEqual(pumpSwapReservesAfter(eventOf(fx, true)));
  });
});
