import { describe, expect, it } from 'vitest';
import { pumpSwapBuy, pumpSwapSell } from '../src/pumpswap.ts';
import type { PumpSwapReserves } from '../src/pumpswap.ts';

/**
 * Testes de sanidade para o PumpSwap (não golden — ver limitação documentada em
 * `src/pumpswap.ts` e `test/pumpswap.golden.test.ts`): comprar e vender a mesma base
 * imediatamente depois nunca deve dar lucro em quote, dado que lp+protocol+creator fee > 0.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(7);
const FEES = { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 90n };

function randomReserves(): PumpSwapReserves {
  return {
    base: 10_000_000_000_000n + BigInt(Math.floor(rand() * 900_000_000_000_000)),
    quote: 10_000_000_000n + BigInt(Math.floor(rand() * 200_000_000_000)),
  };
}

describe('PumpSwap: comprar e vender em seguida nunca dá lucro', () => {
  it.each(Array.from({ length: 100 }, (_, i) => i))('caso aleatório #%i', () => {
    const reserves = randomReserves();
    const netQuoteIn = 1_000_000n + BigInt(Math.floor(rand() * 1_000_000_000));

    const buy = pumpSwapBuy(reserves, netQuoteIn, FEES);
    const sell = pumpSwapSell(buy.reservesAfter, buy.baseOut, FEES);

    expect(sell.netQuoteOut).toBeLessThan(buy.totalQuoteCost);
  });
});
