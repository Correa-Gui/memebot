import { applyEvent, createEmptyMarketState } from '@memebot/state';
import { describe, expect, it } from 'vitest';
import {
  buySellVolumeRatio60s,
  creatorHoldingPct,
  creatorTokensCreated24h,
  curveProgress,
  largestSingleSellPctSupply60s,
  priceAboveMean120s,
  riskScore,
  sameSlotBuyPct,
  tokenAgeSec,
  top10HolderPct,
  uniqueBuyers60s,
  uniqueHolderCount,
  volume60sSol,
} from '../src/index.ts';
import { CURVE_PARAMS, curveTrade, getToken, tokenCreated } from './helpers.ts';

describe('tokenAgeSec', () => {
  it('calcula a idade em segundos a partir de createdAtMs', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 1_000 }));
    const token = getToken(state, 'mintA');
    expect(tokenAgeSec(token, 1_000 + 90_000)).toBe(90);
  });

  it('retorna null se o token ainda não foi criado (sem token_created)', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1_000, side: 'buy', trader: 'bob' }));
    const token = getToken(state, 'mintA');
    expect(tokenAgeSec(token, 2_000)).toBeNull();
  });
});

describe('curveProgress', () => {
  it('é 0 antes de qualquer trade (reservas ainda não observadas)', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 1_000 }));
    expect(curveProgress(getToken(state, 'mintA'), CURVE_PARAMS)).toBe(0);
  });

  it('é 0 com a reserva real intacta (igual a initial_real_token_reserves)', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 1_000 }));
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 1_100, side: 'buy', trader: 'bob', realTokenReserves: CURVE_PARAMS.initialRealToken }),
    );
    expect(curveProgress(getToken(state, 'mintA'), CURVE_PARAMS)).toBe(0);
  });

  it('usa initial_real_token_reserves como denominador, não tokenTotalSupply', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 1_000, tokenTotalSupply: 1_000_000_000_000_000n }));
    // 40% da reserva inicial (793.1e12) vendida → sobram 475.86e12.
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 1_100, side: 'buy', trader: 'bob', realTokenReserves: 475_860_000_000_000n }),
    );
    expect(curveProgress(getToken(state, 'mintA'), CURVE_PARAMS)).toBeCloseTo(0.4, 9);
  });

  it('é 1 com a reserva real esgotada', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1_100, side: 'buy', trader: 'bob', realTokenReserves: 0n }));
    expect(curveProgress(getToken(state, 'mintA'), CURVE_PARAMS)).toBe(1);
  });
});

describe('uniqueHolderCount', () => {
  it('não conta carteiras com saldo inferido 0 (venderam tudo)', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1_000, side: 'buy', trader: 'bob', tokenAmount: 100n }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1_100, side: 'buy', trader: 'carol', tokenAmount: 50n }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1_200, side: 'sell', trader: 'bob', tokenAmount: 100n }));

    expect(uniqueHolderCount(getToken(state, 'mintA'))).toBe(1);
  });
});

describe('top10HolderPct', () => {
  it('soma os 10 maiores saldos sobre o supply total', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 1_000, tokenTotalSupply: 1_000n }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1_100, side: 'buy', trader: 'bob', tokenAmount: 300n }));

    expect(top10HolderPct(getToken(state, 'mintA'))).toBeCloseTo(0.3, 6);
  });
});

describe('sameSlotBuyPct', () => {
  it('soma só as compras no mesmo slot da criação', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 1_000, slot: 50n, tokenTotalSupply: 1_000n }));
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 1_000, slot: 50n, side: 'buy', trader: 'bob', tokenAmount: 100n }),
    );
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 1_500, slot: 51n, side: 'buy', trader: 'carol', tokenAmount: 900n }),
    );

    expect(sameSlotBuyPct(getToken(state, 'mintA'))).toBeCloseTo(0.1, 6);
  });

  it('retorna null se createdAtSlot é desconhecido', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1_000, side: 'buy', trader: 'bob' }));
    expect(sameSlotBuyPct(getToken(state, 'mintA'))).toBeNull();
  });
});

describe('buySellVolumeRatio60s / uniqueBuyers60s / volume60sSol', () => {
  it('calcula a razão, compradores únicos e volume só dentro da janela de 60s', () => {
    let state = createEmptyMarketState();
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 0, side: 'buy', trader: 'bob', quoteAmount: 10_000_000_000n }),
    ); // fora da janela em nowMs=61_000
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 10_000, side: 'buy', trader: 'carol', quoteAmount: 3_000_000_000n }),
    );
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 20_000, side: 'sell', trader: 'dave', quoteAmount: 1_000_000_000n }),
    );

    const token = getToken(state, 'mintA');
    const nowMs = 61_000;

    expect(buySellVolumeRatio60s(token, nowMs)).toBeCloseTo(3, 6);
    expect(uniqueBuyers60s(token, nowMs)).toBe(1);
    expect(volume60sSol(token, nowMs)).toBeCloseTo(4, 6);
  });
});

describe('largestSingleSellPctSupply60s', () => {
  it('pega a maior venda individual na janela como % do supply', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 0, tokenTotalSupply: 1_000n }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1_000, side: 'sell', trader: 'bob', tokenAmount: 50n }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 2_000, side: 'sell', trader: 'carol', tokenAmount: 10n }));

    expect(largestSingleSellPctSupply60s(getToken(state, 'mintA'), 2_000)).toBeCloseTo(0.05, 6);
  });
});

describe('priceAboveMean120s (preço marginal = virtualQuote/virtualToken após cada trade)', () => {
  /** Trade de curva cujo preço marginal pós-trade é `quote / 1_000_000`. */
  function tradeAtPrice(ts: number, quote: bigint, overrides: { quoteAmount?: bigint; tokenAmount?: bigint } = {}) {
    return curveTrade({
      mint: 'mintA',
      ts,
      side: 'buy',
      trader: `t-${String(ts)}`,
      virtualQuoteReserves: quote,
      virtualTokenReserves: 1_000_000n,
      ...overrides,
    });
  }

  it('true quando o preço marginal do último trade está acima da média dos marginais da janela', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tradeAtPrice(10_000, 1_000_000n)); // 1.0
    state = applyEvent(state, tradeAtPrice(20_000, 2_000_000n)); // 2.0
    state = applyEvent(state, tradeAtPrice(30_000, 3_000_000n)); // 3.0 > média 2.0
    expect(priceAboveMean120s(getToken(state, 'mintA'), 30_000)).toBe(true);
  });

  it('false quando o preço marginal está caindo', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tradeAtPrice(10_000, 3_000_000n));
    state = applyEvent(state, tradeAtPrice(20_000, 2_000_000n));
    state = applyEvent(state, tradeAtPrice(30_000, 1_000_000n)); // 1.0 < média 2.0
    expect(priceAboveMean120s(getToken(state, 'mintA'), 30_000)).toBe(false);
  });

  it('ignora o preço médio de execução (quoteAmount/tokenAmount): só as reservas contam', () => {
    let state = createEmptyMarketState();
    // Preço de execução enorme no 1º trade e minúsculo no 2º: com preço de execução daria `true`;
    // com preço marginal (1.0 → 0.5) tem que dar `false`.
    state = applyEvent(state, tradeAtPrice(10_000, 1_000_000n, { quoteAmount: 1_000_000_000n, tokenAmount: 1n }));
    state = applyEvent(state, tradeAtPrice(20_000, 500_000n, { quoteAmount: 1n, tokenAmount: 1_000_000_000n }));
    expect(priceAboveMean120s(getToken(state, 'mintA'), 20_000)).toBe(false);
  });

  it('só considera trades dentro de [nowMs - 120s, nowMs]', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tradeAtPrice(0, 10_000_000n)); // fora da janela em nowMs=200_000
    state = applyEvent(state, tradeAtPrice(100_000, 1_000_000n));
    state = applyEvent(state, tradeAtPrice(150_000, 2_000_000n));
    state = applyEvent(state, tradeAtPrice(250_000, 1n)); // futuro relativo a nowMs: ignorado
    expect(priceAboveMean120s(getToken(state, 'mintA'), 200_000)).toBe(true);
  });

  it('false com um único trade na janela (atual == média)', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tradeAtPrice(10_000, 2_000_000n));
    expect(priceAboveMean120s(getToken(state, 'mintA'), 10_000)).toBe(false);
  });

  it('null sem nenhum trade de curva na janela de 120s', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 0 }));
    expect(priceAboveMean120s(getToken(state, 'mintA'), 0)).toBeNull();
  });
});

describe('creatorHoldingPct', () => {
  it('soma os saldos das carteiras do criador sobre o supply', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 0, creator: 'creator-1', tokenTotalSupply: 1_000n }));
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 100, side: 'buy', trader: 'creator-1', tokenAmount: 40n }),
    );

    expect(creatorHoldingPct(getToken(state, 'mintA'))).toBeCloseTo(0.04, 6);
  });
});

describe('creatorTokensCreated24h', () => {
  it('conta outros tokens do mesmo criador dentro das últimas 24h, excluindo o próprio', () => {
    let state = createEmptyMarketState();
    const dayMs = 24 * 60 * 60 * 1000;
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 0, creator: 'creator-1' }));
    state = applyEvent(state, tokenCreated({ mint: 'mintB', ts: 1_000, creator: 'creator-1' }));
    state = applyEvent(state, tokenCreated({ mint: 'mintC', ts: 2_000, creator: 'other-creator' }));
    state = applyEvent(state, tokenCreated({ mint: 'mintD', ts: -(dayMs + 1), creator: 'creator-1' })); // fora da janela

    const token = getToken(state, 'mintA');
    expect(creatorTokensCreated24h(state, token, 2_000)).toBe(1);
  });
});

describe('riskScore', () => {
  it('sempre retorna ausente (NaN + missing) — modelo ainda não existe', () => {
    const result = riskScore();
    expect(result.missing).toBe(true);
    expect(Number.isNaN(result.value)).toBe(true);
  });
});
