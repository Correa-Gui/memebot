import { describe, expect, it } from 'vitest';
import { bondingCurveBuy, bondingCurveSell, marginalPrice } from '../src/bonding-curve.ts';
import type { CurveReserves } from '../src/bonding-curve.ts';

/**
 * Testes de propriedade (CLAUDE.md §8). `fast-check` não é dependência do monorepo (checado em
 * package.json de todos os pacotes antes de escrever este arquivo); em vez de adicionar uma nova
 * dependência só para isto, geramos os casos manualmente com um PRNG determinístico simples —
 * suficiente para cobrir uma faixa ampla de reservas/valores sem rede nem flakiness.
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

const rand = mulberry32(42);

function randomReserves(): CurveReserves {
  // Faixa plausível: curva recém-criada até quase completa.
  const virtualQuote = 30_000_000_000n + BigInt(Math.floor(rand() * 100_000_000_000));
  const virtualToken = 300_000_000_000_000n + BigInt(Math.floor(rand() * 900_000_000_000_000));
  return { virtualQuote, virtualToken };
}

function randomFees(): { protocolFeeBps: bigint; creatorFeeBps: bigint } {
  return { protocolFeeBps: 95n, creatorFeeBps: 30n };
}

const CASES = 200;

describe('propriedade: comprar e vender em seguida nunca dá lucro', () => {
  it.each(Array.from({ length: CASES }, (_, i) => i))('caso aleatório #%i', () => {
    const reserves = randomReserves();
    const fees = randomFees();
    const quoteIn = 1_000_000n + BigInt(Math.floor(rand() * 5_000_000_000));

    const buy = bondingCurveBuy(reserves, quoteIn, fees);
    const sell = bondingCurveSell(buy.reservesAfter, buy.tokenOut, fees);

    // Custo total pago na compra (quoteIn + taxas) deve ser estritamente maior que o valor
    // líquido recebido ao vender a mesma quantidade de token imediatamente depois — a diferença
    // mínima é a soma das taxas pagas nas duas pontas (compra + venda).
    expect(sell.netQuoteOut).toBeLessThan(buy.totalQuoteCost);

    const roundTripLoss = buy.totalQuoteCost - sell.netQuoteOut;
    const minExpectedLoss = buy.protocolFee + buy.creatorFee + sell.protocolFee + sell.creatorFee;
    expect(roundTripLoss).toBeGreaterThanOrEqual(minExpectedLoss);
  });
});

describe('propriedade: preço marginal sobe com reservas de token caindo / quote subindo', () => {
  it.each(Array.from({ length: CASES }, (_, i) => i))('caso aleatório #%i', () => {
    const reserves = randomReserves();
    const fees = randomFees();
    const quoteIn = 1_000_000n + BigInt(Math.floor(rand() * 5_000_000_000));

    const priceBefore = marginalPrice(reserves);
    const { reservesAfter } = bondingCurveBuy(reserves, quoteIn, fees);
    const priceAfter = marginalPrice(reservesAfter);

    // Comprar remove token da curva (supply vendido sobe) e injeta quote: preço sobe.
    expect(priceAfter).toBeGreaterThan(priceBefore);
    expect(reservesAfter.virtualToken).toBeLessThan(reserves.virtualToken);
    expect(reservesAfter.virtualQuote).toBeGreaterThan(reserves.virtualQuote);
  });

  it.each(Array.from({ length: CASES }, (_, i) => i))('venda: preço cai quando supply vendido recua #%i', () => {
    const reserves = randomReserves();
    const fees = randomFees();
    const tokenIn = 1_000_000_000n + BigInt(Math.floor(rand() * 10_000_000_000_000));

    const priceBefore = marginalPrice(reserves);
    const { reservesAfter } = bondingCurveSell(reserves, tokenIn, fees);
    const priceAfter = marginalPrice(reservesAfter);

    expect(priceAfter).toBeLessThan(priceBefore);
  });
});

describe('propriedade: tokenOut/quoteOut nunca excede a liquidez disponível', () => {
  it.each(Array.from({ length: CASES }, (_, i) => i))('compra #%i', () => {
    const reserves = randomReserves();
    const fees = randomFees();
    const quoteIn = 1_000_000n + BigInt(Math.floor(rand() * 5_000_000_000));

    const { tokenOut } = bondingCurveBuy(reserves, quoteIn, fees);
    expect(tokenOut).toBeGreaterThanOrEqual(0n);
    expect(tokenOut).toBeLessThan(reserves.virtualToken);
  });
});
