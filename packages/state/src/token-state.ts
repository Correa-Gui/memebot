import type { TokenAmount } from '@memebot/core';
import type { CurveTradeEvent, PumpSwapTradeEvent, TokenCreatedEvent } from '@memebot/core';
import { FIRST_BUYERS_LIMIT, TRADE_HISTORY_LIMIT } from './types.ts';
import type { TokenState, TradeRecord } from './types.ts';

export function emptyTokenState(mint: string): TokenState {
  return {
    mint,
    quoteMint: null,
    creator: null,
    tokenTotalSupply: null,
    createdAtMs: null,
    createdAtSlot: null,
    bondingCurve: null,
    venue: 'unknown',
    curveCompleted: false,
    curveReserves: null,
    pumpSwapReserves: null,
    holderBalances: new Map(),
    firstBuyers: [],
    creatorWallets: new Set(),
    trades: [],
  };
}

export function applyTokenCreated(state: TokenState, event: TokenCreatedEvent): TokenState {
  return {
    ...state,
    quoteMint: event.quoteMint,
    creator: event.creator,
    tokenTotalSupply: event.tokenTotalSupply,
    createdAtMs: event.ts,
    createdAtSlot: event.slot,
    bondingCurve: event.bondingCurve,
    venue: 'curve',
    creatorWallets: new Set([...state.creatorWallets, event.creator]),
  };
}

function addTrade(state: TokenState, record: TradeRecord): TokenState {
  const trades =
    state.trades.length >= TRADE_HISTORY_LIMIT ? [...state.trades.slice(1), record] : [...state.trades, record];
  return { ...state, trades };
}

/** Saldo inferido: compra soma, venda subtrai, nunca fica negativo (ver docstring de `holderBalances`). */
function applyBalanceDelta(
  balances: ReadonlyMap<string, TokenAmount>,
  trader: string,
  side: 'buy' | 'sell',
  tokenAmount: TokenAmount,
): ReadonlyMap<string, TokenAmount> {
  const current = balances.get(trader) ?? 0n;
  const next = side === 'buy' ? current + tokenAmount : current - tokenAmount;
  const clamped = next < 0n ? 0n : next;
  const updated = new Map(balances);
  updated.set(trader, clamped);
  return updated;
}

function addFirstBuyerIfNew(list: readonly string[], trader: string, side: 'buy' | 'sell'): readonly string[] {
  if (side !== 'buy') return list;
  if (list.includes(trader)) return list;
  if (list.length >= FIRST_BUYERS_LIMIT) return list;
  return [...list, trader];
}

export function applyCurveTrade(state: TokenState, event: CurveTradeEvent): TokenState {
  let next: TokenState = {
    ...state,
    venue: 'curve',
    quoteMint: state.quoteMint ?? event.quoteMint,
    curveReserves: {
      virtualQuote: event.virtualQuoteReserves,
      virtualToken: event.virtualTokenReserves,
      realQuote: event.realQuoteReserves,
      realToken: event.realTokenReserves,
    },
    holderBalances: applyBalanceDelta(state.holderBalances, event.trader, event.side, event.tokenAmount),
    firstBuyers: addFirstBuyerIfNew(state.firstBuyers, event.trader, event.side),
  };
  next = addTrade(next, {
    ts: event.ts,
    slot: event.slot,
    venue: 'curve',
    side: event.side,
    trader: event.trader,
    quoteAmount: event.quoteAmount,
    tokenAmount: event.tokenAmount,
    virtualQuoteAfter: event.virtualQuoteReserves,
    virtualTokenAfter: event.virtualTokenReserves,
  });
  return next;
}

export function applyPumpSwapTrade(state: TokenState, event: PumpSwapTradeEvent): TokenState {
  let next: TokenState = {
    ...state,
    venue: 'pumpswap',
    quoteMint: state.quoteMint ?? (event.quoteMint || null),
    pumpSwapReserves: { pool: event.pool, base: event.poolBaseReserves, quote: event.poolQuoteReserves },
    holderBalances: applyBalanceDelta(state.holderBalances, event.trader, event.side, event.tokenAmount),
    firstBuyers: addFirstBuyerIfNew(state.firstBuyers, event.trader, event.side),
  };
  next = addTrade(next, {
    ts: event.ts,
    slot: event.slot,
    venue: 'pumpswap',
    side: event.side,
    trader: event.trader,
    quoteAmount: event.quoteAmount,
    tokenAmount: event.tokenAmount,
    virtualQuoteAfter: null,
    virtualTokenAfter: null,
  });
  return next;
}

export function markCurveCompleted(state: TokenState): TokenState {
  // A curva "completa" ainda não migrou de fato para o PumpSwap (isso acontece no pool_created +
  // primeiro trade na pool); só marcamos que não aceita mais trades de curva daqui em diante.
  return { ...state, curveCompleted: true };
}

export function markPoolCreated(state: TokenState): TokenState {
  return { ...state, venue: 'pumpswap' };
}
