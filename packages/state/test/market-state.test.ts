import { describe, expect, it } from 'vitest';
import { applyEvent, createEmptyMarketState } from '../src/market-state.ts';
import { curveTrade, getToken, poolCreated, pumpSwapTrade, tokenCreated } from './helpers.ts';

describe('applyEvent — token_created', () => {
  it('cria o TokenState com creator, venue e tokenTotalSupply', () => {
    const s0 = createEmptyMarketState();
    const s1 = applyEvent(s0, tokenCreated({ mint: 'mintA', ts: 1000, slot: 42n, creator: 'alice' }));

    const token = getToken(s1, 'mintA');
    expect(token.creator).toBe('alice');
    expect(token.venue).toBe('curve');
    expect(token.creatorWallets.has('alice')).toBe(true);
    expect(token.createdAtMs).toBe(1000);
    expect(token.createdAtSlot).toBe(42n);
  });

  it('não muta o estado anterior (função pura)', () => {
    const s0 = createEmptyMarketState();
    const s1 = applyEvent(s0, tokenCreated({ mint: 'mintA', ts: 1000 }));
    expect(s0.tokens.size).toBe(0);
    expect(s1.tokens.size).toBe(1);
    expect(s0).not.toBe(s1);
  });
});

describe('applyEvent — trade na bonding curve', () => {
  it('atualiza reservas, saldo do comprador e firstBuyers', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, tokenCreated({ mint: 'mintA', ts: 1000 }));
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 1100, side: 'buy', trader: 'bob', tokenAmount: 500n, virtualTokenReserves: 999n }),
    );

    const token = getToken(state, 'mintA');
    expect(token.holderBalances.get('bob')).toBe(500n);
    expect(token.firstBuyers).toEqual(['bob']);
    expect(token.curveReserves?.virtualToken).toBe(999n);
    expect(token.trades).toHaveLength(1);
  });

  it('guarda no TradeRecord as reservas virtuais pós-trade emitidas no evento', () => {
    let state = createEmptyMarketState();
    state = applyEvent(
      state,
      curveTrade({ mint: 'mintA', ts: 1100, side: 'buy', trader: 'bob', virtualQuoteReserves: 31n, virtualTokenReserves: 999n }),
    );
    const record = getToken(state, 'mintA').trades[0];
    expect(record?.virtualQuoteAfter).toBe(31n);
    expect(record?.virtualTokenAfter).toBe(999n);
  });

  it('venda reduz o saldo inferido e nunca fica negativo', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1000, side: 'buy', trader: 'bob', tokenAmount: 100n }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1100, side: 'sell', trader: 'bob', tokenAmount: 40n }));
    expect(getToken(state, 'mintA').holderBalances.get('bob')).toBe(60n);

    // vende mais do que o saldo conhecido (ex.: tinha saldo pré-existente fora da nossa visão).
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1200, side: 'sell', trader: 'bob', tokenAmount: 1000n }));
    expect(getToken(state, 'mintA').holderBalances.get('bob')).toBe(0n);
  });

  it('firstBuyers só adiciona compradores únicos, na ordem de chegada', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1000, side: 'buy', trader: 'bob' }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1001, side: 'sell', trader: 'carol' }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1002, side: 'buy', trader: 'carol' }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1003, side: 'buy', trader: 'bob' }));
    state = applyEvent(state, curveTrade({ mint: 'mintA', ts: 1004, side: 'buy', trader: 'dave' }));

    expect(getToken(state, 'mintA').firstBuyers).toEqual(['bob', 'carol', 'dave']);
  });
});

describe('applyEvent — PumpSwap', () => {
  it('ignora trade com pool não resolvida e sem pool_created conhecido', () => {
    const state = applyEvent(createEmptyMarketState(), pumpSwapTrade({ pool: 'poolA', ts: 1000, side: 'buy', trader: 'bob' }));
    expect(state.tokens.size).toBe(0);
  });

  it('resolve mint via pool_created mesmo se o trade vier com mint vazio', () => {
    let state = createEmptyMarketState();
    state = applyEvent(state, poolCreated({ pool: 'poolA', mint: 'mintA', ts: 900 }));
    state = applyEvent(state, pumpSwapTrade({ pool: 'poolA', ts: 1000, side: 'buy', trader: 'bob', mint: '' }));

    const token = getToken(state, 'mintA');
    expect(token.venue).toBe('pumpswap');
    expect(token.pumpSwapReserves?.pool).toBe('poolA');
    expect(token.holderBalances.get('bob')).toBe(1_000_000_000n);
  });

  it('usa o mint do próprio evento quando já resolvido', () => {
    const state = applyEvent(
      createEmptyMarketState(),
      pumpSwapTrade({ pool: 'poolA', ts: 1000, side: 'buy', trader: 'bob', mint: 'mintA', poolUnresolved: false }),
    );
    expect(state.tokens.has('mintA')).toBe(true);
  });
});

describe('applyEvent — curve_completed', () => {
  it('marca curveCompleted sem mudar o venue (a migração só vem com pool_created)', () => {
    let state = applyEvent(createEmptyMarketState(), tokenCreated({ mint: 'mintA', ts: 1000 }));
    expect(getToken(state, 'mintA').curveCompleted).toBe(false);
    state = applyEvent(state, {
      kind: 'curve_completed',
      mint: 'mintA',
      bondingCurve: 'curve-1',
      slot: 2n,
      ts: 2000,
      sig: 'sig-complete',
      eventIndex: 0,
      receivedAtMs: 2000,
      recvSeq: 0,
      rawB64: '',
    });
    const token = getToken(state, 'mintA');
    expect(token.curveCompleted).toBe(true);
    expect(token.venue).toBe('curve');
  });
});

describe('replay determinístico', () => {
  it('a mesma sequência de eventos produz exatamente o mesmo estado', () => {
    const events = [
      tokenCreated({ mint: 'mintA', ts: 1000, creator: 'alice' }),
      curveTrade({ mint: 'mintA', ts: 1100, side: 'buy', trader: 'bob', tokenAmount: 100n }),
      curveTrade({ mint: 'mintA', ts: 1200, side: 'sell', trader: 'bob', tokenAmount: 40n }),
    ];

    const run = () => events.reduce((s, e) => applyEvent(s, e), createEmptyMarketState());
    const r1 = run();
    const r2 = run();

    expect(getToken(r1, 'mintA').holderBalances).toEqual(getToken(r2, 'mintA').holderBalances);
    expect(getToken(r1, 'mintA').trades).toEqual(getToken(r2, 'mintA').trades);
    expect(getToken(r1, 'mintA').firstBuyers).toEqual(getToken(r2, 'mintA').firstBuyers);
  });
});
