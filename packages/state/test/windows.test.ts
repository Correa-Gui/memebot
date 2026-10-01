import { describe, expect, it } from 'vitest';
import { applyEvent, createEmptyMarketState } from '../src/market-state.ts';
import { buySellRatio, computeWindowStats, tokenAgeMs, topHolderConcentration } from '../src/windows.ts';
import { curveTrade, getToken, tokenCreated } from './helpers.ts';

function buildState() {
  let state = createEmptyMarketState();
  state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 0, creator: 'alice' }));
  // Eventos sempre aplicados em ordem cronológica (ts crescente) — mesma suposição do uso real
  // (ingest ao vivo ou replay ordenado), documentada em `windows.ts`.
  // Fora da janela de 60s relativa a nowMs=100_000 (ts=10_000 -> 90_000ms atrás).
  state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 10_000, side: 'sell', trader: 'dave', quoteAmount: 9_999n, tokenAmount: 9_999n }));
  // Dentro da janela de 60s (ts entre 40_000 e 100_000):
  state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 40_000, side: 'buy', trader: 'bob', quoteAmount: 1_000n, tokenAmount: 100n }));
  state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 50_000, side: 'buy', trader: 'carol', quoteAmount: 2_000n, tokenAmount: 200n }));
  state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 60_000, side: 'sell', trader: 'bob', quoteAmount: 500n, tokenAmount: 50n }));
  return state;
}

describe('computeWindowStats', () => {
  it('só considera trades dentro da janela [nowMs-windowMs, nowMs]', () => {
    const state = buildState();
    const token = getToken(state, 'mintA');
    const stats = computeWindowStats(token, 100_000, 60_000);

    expect(stats.buyCount).toBe(2);
    expect(stats.sellCount).toBe(1);
    expect(stats.buyVolumeQuote).toBe(3_000n);
    expect(stats.sellVolumeQuote).toBe(500n);
    expect(stats.uniqueBuyers).toBe(2);
    expect(stats.uniqueSellers).toBe(1);
    expect(stats.largestSellToken).toBe(50n);
  });

  it('é determinístico: duas chamadas com o mesmo nowMs dão o mesmo resultado', () => {
    const state = buildState();
    const token = getToken(state, 'mintA');
    expect(computeWindowStats(token, 100_000, 60_000)).toEqual(computeWindowStats(token, 100_000, 60_000));
  });

  it('janela vazia quando nowMs é anterior a todos os trades', () => {
    const state = buildState();
    const token = getToken(state, 'mintA');
    const stats = computeWindowStats(token, 0, 60_000);
    expect(stats.buyCount).toBe(0);
    expect(stats.sellCount).toBe(0);
  });
});

describe('buySellRatio', () => {
  it('calcula a razão volume compra/venda', () => {
    const stats = computeWindowStats(getToken(buildState(), 'mintA'), 100_000, 60_000);
    expect(buySellRatio(stats)).toBe(3_000 / 500);
  });

  it('retorna Infinity quando não há venda na janela mas há compra', () => {
    expect(buySellRatio({ buyVolumeQuote: 10n, sellVolumeQuote: 0n, buyCount: 1, sellCount: 0, uniqueBuyers: 1, uniqueSellers: 0, largestSellToken: 0n })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('retorna null quando não há nenhum volume', () => {
    expect(buySellRatio({ buyVolumeQuote: 0n, sellVolumeQuote: 0n, buyCount: 0, sellCount: 0, uniqueBuyers: 0, uniqueSellers: 0, largestSellToken: 0n })).toBeNull();
  });
});

describe('tokenAgeMs', () => {
  it('calcula a idade a partir de createdAtMs', () => {
    const state = buildState();
    expect(tokenAgeMs(getToken(state, 'mintA'), 100_000)).toBe(100_000);
  });

  it('retorna null se createdAtMs é desconhecido', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, curveTrade({ mint: 'mintB', ts: 1_000, side: 'buy', trader: 'bob' }));
    expect(tokenAgeMs(getToken(state, 'mintB'), 2_000)).toBeNull();
  });
});

describe('topHolderConcentration', () => {
  it('calcula a fração do supply nos top-N holders', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 0, tokenTotalSupply: 1_000n }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1_000, side: 'buy', trader: 'bob', tokenAmount: 300n }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 2_000, side: 'buy', trader: 'carol', tokenAmount: 100n }));

    const token = getToken(state, 'mintA');
    expect(topHolderConcentration(token, 1)).toBeCloseTo(0.3);
    expect(topHolderConcentration(token, 10)).toBeCloseTo(0.4);
  });

  it('retorna null se tokenTotalSupply é desconhecido', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, curveTrade({ mint: 'mintB', ts: 1_000, side: 'buy', trader: 'bob' }));
    expect(topHolderConcentration(getToken(state, 'mintB'), 10)).toBeNull();
  });
});
