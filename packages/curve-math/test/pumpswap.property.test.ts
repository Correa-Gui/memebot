import { describe, expect, it } from 'vitest';
import { pumpSwapBuyExactBaseOut, pumpSwapBuyExactQuoteIn, pumpSwapSell } from '../src/pumpswap.ts';
import type { PumpSwapFeeBps, PumpSwapReserves } from '../src/pumpswap.ts';

/** Gerador determinístico (semente fixa) — os testes não dependem de aleatoriedade não semeada. */
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
const randBig = (min: number, span: number): bigint => BigInt(min) + BigInt(Math.floor(rand() * span));

function randomReserves(): PumpSwapReserves {
  return {
    base: randBig(10_000_000_000_000, 900_000_000_000_000),
    quote: randBig(1_000_000_000, 500_000_000_000),
    // metade com offset virtual (pools graduadas da Pump.fun ~17,58 SOL), metade sem
    virtualQuote: rand() < 0.5 ? 0n : randBig(1_000_000_000, 30_000_000_000),
  };
}

function randomFees(): PumpSwapFeeBps {
  // inclui o caso de taxa zero (pools isentas), em que ida e volta ainda não pode dar lucro
  const pick = (max: number): bigint => (rand() < 0.15 ? 0n : randBig(0, max + 1));
  return { lpFeeBps: pick(30), protocolFeeBps: pick(95), creatorFeeBps: pick(95), cashbackFeeBps: rand() < 0.8 ? 0n : pick(50) };
}

const CASES = Array.from({ length: 200 }, (_, i) => i);

describe('PumpSwap — propriedades', () => {
  it.each(CASES)('ida e volta (buy_exact_quote_in → sell) nunca dá lucro #%i', () => {
    const r = randomReserves();
    const fees = randomFees();
    const spend = randBig(10_000, 5_000_000_000);
    const buy = pumpSwapBuyExactQuoteIn(r, spend, fees);
    const sell = pumpSwapSell(buy.reservesAfter, buy.baseOut, fees);
    expect(buy.totalQuoteCost).toBeLessThanOrEqual(spend);
    expect(sell.netQuoteOut).toBeLessThan(buy.totalQuoteCost);
  });

  it.each(CASES)('ida e volta (buy base exata → sell) nunca dá lucro #%i', () => {
    const r = randomReserves();
    const fees = randomFees();
    const baseOut = 1_000n + (r.base * randBig(1, 50_000)) / 1_000_000n;
    const buy = pumpSwapBuyExactBaseOut(r, baseOut, fees);
    const sell = pumpSwapSell(buy.reservesAfter, buy.baseOut, fees);
    expect(sell.netQuoteOut).toBeLessThan(buy.totalQuoteCost);
  });

  it.each(CASES)('buy_exact_quote_in: comprar a mesma base com `buy` nunca custa mais que o gastável #%i', () => {
    const r = randomReserves();
    const fees = randomFees();
    const q = pumpSwapBuyExactQuoteIn(r, randBig(10_000, 5_000_000_000), fees);
    const b = pumpSwapBuyExactBaseOut(r, q.baseOut, fees);
    expect(b.netQuoteIn).toBeLessThanOrEqual(q.netQuoteIn);
  });

  it.each(CASES)('reservas: base conserva, k efetivo não diminui, vault de quote nunca negativa #%i', () => {
    const r0 = randomReserves();
    // offset virtual limitado ao saldo real: com offset maior, uma venda grande pode pedir mais
    // quote do que a vault tem (o programa falharia; ver teste 'rejeita saída maior que a vault')
    const r: PumpSwapReserves = { ...r0, virtualQuote: r0.virtualQuote > r0.quote ? r0.quote : r0.virtualQuote };
    const fees = randomFees();
    const baseIn = (r.base * randBig(1, 200_000)) / 1_000_000n + 1n;
    const s = pumpSwapSell(r, baseIn, fees);
    expect(s.reservesAfter.base).toBe(r.base + baseIn);
    expect(s.reservesAfter.quote).toBeGreaterThanOrEqual(0n);
    const kBefore = r.base * (r.quote + r.virtualQuote);
    const kAfter = s.reservesAfter.base * (s.reservesAfter.quote + s.reservesAfter.virtualQuote);
    expect(kAfter).toBeGreaterThanOrEqual(kBefore);
  });

  it('rejeita entradas inválidas', () => {
    const r: PumpSwapReserves = { base: 1_000_000n, quote: 1_000_000n, virtualQuote: 0n };
    const fees: PumpSwapFeeBps = { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 90n, cashbackFeeBps: 0n };
    expect(() => pumpSwapSell(r, 0n, fees)).toThrow(RangeError);
    expect(() => pumpSwapBuyExactBaseOut(r, 1_000_000n, fees)).toThrow(RangeError);
    expect(() => pumpSwapBuyExactQuoteIn(r, 0n, fees)).toThrow(RangeError);
    expect(() => pumpSwapSell({ ...r, base: 0n }, 1n, fees)).toThrow(RangeError);
    expect(() => pumpSwapSell(r, 1n, { ...fees, lpFeeBps: 10_001n })).toThrow(RangeError);
  });

  it('rejeita saída maior que o saldo real da vault de quote (offset virtual grande)', () => {
    const r: PumpSwapReserves = { base: 1_000_000n, quote: 100n, virtualQuote: 1_000_000n };
    const fees: PumpSwapFeeBps = { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 90n, cashbackFeeBps: 0n };
    expect(() => pumpSwapSell(r, 1_000_000n, fees)).toThrow(/saldo real da vault/);
  });
});
