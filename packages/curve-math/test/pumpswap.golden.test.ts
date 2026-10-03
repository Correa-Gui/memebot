import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUMPSWAP_NO_COIN_CREATOR, effectivePumpSwapFeeBps, pumpSwapBuyExactBaseOut, pumpSwapBuyExactQuoteIn, pumpSwapSell } from '../src/pumpswap.ts';
import type { PumpSwapFeeBps, PumpSwapReserves } from '../src/pumpswap.ts';

interface PumpSwapGoldenFixture {
  description: string;
  source: { sig: string; eventIndex: number; slot: string; pool: string; eventRawB64: string };
  category: 'wsol' | 'base-wsol' | 'other-quote';
  ixName: 'buy' | 'buy_exact_quote_in' | 'sell';
  before: { base: string; quote: string; virtualQuote: string };
  feeBps: { lp: string; protocol: string; creator: string; cashback: string };
  event: {
    baseAmount: string;
    quoteAmount: string;
    userQuoteAmount: string;
    lpFee: string;
    protocolFee: string;
    creatorFee: string;
    cashback: string;
  };
  after: { base: string; quote: string };
  /** Só nas fixtures de pool sem criador (`pumpswap-no-creator.json`). */
  coinCreator?: string;
}

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golden', 'pumpswap.json');
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as PumpSwapGoldenFixture[];
const noCreatorPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golden', 'pumpswap-no-creator.json');
const noCreatorFixtures = JSON.parse(readFileSync(noCreatorPath, 'utf8')) as PumpSwapGoldenFixture[];

function reservesOf(fx: PumpSwapGoldenFixture): PumpSwapReserves {
  return { base: BigInt(fx.before.base), quote: BigInt(fx.before.quote), virtualQuote: BigInt(fx.before.virtualQuote) };
}

function feeBpsOf(fx: PumpSwapGoldenFixture): PumpSwapFeeBps {
  return {
    lpFeeBps: BigInt(fx.feeBps.lp),
    protocolFeeBps: BigInt(fx.feeBps.protocol),
    creatorFeeBps: BigInt(fx.feeBps.creator),
    cashbackFeeBps: BigInt(fx.feeBps.cashback),
  };
}

/**
 * Fixtures = eventos `BuyEvent`/`SellEvent` REAIS (decodificados do `raw_b64` com o IDL oficial),
 * extraídos por `scripts/extract-pumpswap-fixtures.ts`; `after` = reservas do próximo evento do
 * mesmo pool. Exigência: 0 unidades de diferença em TUDO (base, quote bruto/líquido, cada taxa
 * e reservas depois do swap).
 */
describe('PumpSwap — fixtures golden (swap exato, trades reais)', () => {
  it('cobertura: >= 50 fixtures, as 3 instruções, as 3 categorias de pool, com e sem reserva virtual, cashback e caso de borda', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(50);
    for (const ix of ['buy', 'buy_exact_quote_in', 'sell'] as const) {
      expect(fixtures.filter((f) => f.ixName === ix).length).toBeGreaterThanOrEqual(10);
    }
    for (const c of ['wsol', 'base-wsol', 'other-quote'] as const) {
      expect(fixtures.filter((f) => f.category === c).length).toBeGreaterThanOrEqual(10);
    }
    expect(new Set(fixtures.map((f) => f.source.pool)).size).toBeGreaterThanOrEqual(20);
    expect(fixtures.some((f) => f.before.virtualQuote === '0')).toBe(true);
    expect(fixtures.some((f) => BigInt(f.before.virtualQuote) > 0n)).toBe(true);
    expect(fixtures.some((f) => BigInt(f.event.cashback) > 0n)).toBe(true);
    // buy_exact_quote_in onde userQuoteAmount + taxas = spendable - 1 (taxas de n0 exatas)
    const edge = fixtures.filter((f) => {
      if (f.ixName !== 'buy_exact_quote_in') return false;
      const e = f.event;
      const total = BigInt(e.userQuoteAmount) + BigInt(e.lpFee) + BigInt(e.protocolFee) + BigInt(e.creatorFee) + BigInt(e.cashback);
      return total === BigInt(e.quoteAmount) - 1n;
    });
    expect(edge.length).toBeGreaterThanOrEqual(1);
  });

  it.each(fixtures)('$description', (fx) => {
    expectExact(fx);
  });
});

function expectExact(fx: PumpSwapGoldenFixture): void {
    const r = reservesOf(fx);
    const fees = effectivePumpSwapFeeBps(feeBpsOf(fx), fx.coinCreator !== PUMPSWAP_NO_COIN_CREATOR);
    const e = fx.event;
    const expectedFees = {
      lpFee: BigInt(e.lpFee),
      protocolFee: BigInt(e.protocolFee),
      creatorFee: BigInt(e.creatorFee),
      cashbackFee: BigInt(e.cashback),
    };
    const expectedAfter = { base: BigInt(fx.after.base), quote: BigInt(fx.after.quote), virtualQuote: r.virtualQuote };

    if (fx.ixName === 'sell') {
      const res = pumpSwapSell(r, BigInt(e.baseAmount), fees);
      expect(res.quoteOutGross).toBe(BigInt(e.quoteAmount));
      expect(res.netQuoteOut).toBe(BigInt(e.userQuoteAmount));
      expect({ lpFee: res.lpFee, protocolFee: res.protocolFee, creatorFee: res.creatorFee, cashbackFee: res.cashbackFee }).toEqual(expectedFees);
      expect(res.reservesAfter).toEqual(expectedAfter);
    } else if (fx.ixName === 'buy') {
      // evento de `buy`: quote_amount_in = líquido do swap, user_quote_amount_in = total pago
      const res = pumpSwapBuyExactBaseOut(r, BigInt(e.baseAmount), fees);
      expect(res.netQuoteIn).toBe(BigInt(e.quoteAmount));
      expect(res.totalQuoteCost).toBe(BigInt(e.userQuoteAmount));
      expect({ lpFee: res.lpFee, protocolFee: res.protocolFee, creatorFee: res.creatorFee, cashbackFee: res.cashbackFee }).toEqual(expectedFees);
      expect(res.reservesAfter).toEqual(expectedAfter);
    } else {
      // evento de `buy_exact_quote_in`: quote_amount_in = spendable, user_quote_amount_in = líquido do swap
      const res = pumpSwapBuyExactQuoteIn(r, BigInt(e.quoteAmount), fees);
      expect(res.baseOut).toBe(BigInt(e.baseAmount));
      expect(res.netQuoteIn).toBe(BigInt(e.userQuoteAmount));
      expect({ lpFee: res.lpFee, protocolFee: res.protocolFee, creatorFee: res.creatorFee, cashbackFee: res.cashbackFee }).toEqual(expectedFees);
      expect(res.reservesAfter).toEqual(expectedAfter);
    }
}

/**
 * Pools SEM criador (`coin_creator` = chave padrão): o evento traz `coin_creator_fee_basis_points` > 0,
 * mas o programa não cobra a taxa do criador (achado de 2026-10-03 na verificação em massa de 11,36 M de
 * trades; ver `effectivePumpSwapFeeBps`). Extraídas por `scripts/extract-pumpswap-no-creator-fixtures.ts`.
 */
describe('PumpSwap — fixtures golden de pool sem criador', () => {
  it('cobertura: compra (as duas instruções) e venda, todas com bps do criador > 0 e taxa do criador = 0', () => {
    for (const ix of ['buy', 'buy_exact_quote_in', 'sell'] as const) expect(noCreatorFixtures.filter((f) => f.ixName === ix).length).toBeGreaterThanOrEqual(3);
    for (const f of noCreatorFixtures) {
      expect(f.coinCreator).toBe(PUMPSWAP_NO_COIN_CREATOR);
      expect(BigInt(f.feeBps.creator)).toBeGreaterThan(0n);
      expect(f.event.creatorFee).toBe('0');
    }
  });

  it.each(noCreatorFixtures)('$description', (fx) => {
    expectExact(fx);
  });

  it('com o bps do criador do evento (sem a regra) NENHUMA bate — a regra é necessária', () => {
    for (const fx of noCreatorFixtures) expect(() => { expectExact({ ...fx, coinCreator: 'x' }); }).toThrow();
  });
});
