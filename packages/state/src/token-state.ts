import type { TokenAmount } from '@memebot/core';
import type { CurveTradeEvent, PumpSwapTradeEvent, TokenCreatedEvent } from '@memebot/core';
import { FIRST_BUYERS_LIMIT, TRADE_HISTORY_LIMIT } from './types.ts';
import type { PumpSwapReservesSnapshot, TokenState, TradeRecord } from './types.ts';

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
    graduatedAtMs: null,
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

/** Reservas DEPOIS do trade, a partir das reservas ANTES (evento) e do delta do próprio trade. */
export function pumpSwapReservesAfter(event: PumpSwapTradeEvent): PumpSwapReservesSnapshot {
  let base: bigint;
  let quote: bigint;
  if (event.side === 'sell') {
    base = event.poolBaseReserves + event.tokenAmount;
    quote = event.poolQuoteReserves - (event.quoteAmount - event.lpFee);
  } else {
    const net = event.quoteAmount < event.userQuoteAmount ? event.quoteAmount : event.userQuoteAmount;
    base = event.poolBaseReserves - event.tokenAmount;
    quote = event.poolQuoteReserves + net + event.lpFee;
  }
  const d = event.swapDetails;
  return {
    pool: event.pool,
    base: base < 0n ? 0n : base,
    quote: quote < 0n ? 0n : quote,
    virtualQuote: d ? d.virtualQuoteReserves : null,
    // bps EFETIVOS: pool sem criador traz bps do criador > 0 mas não cobra (taxa do criador = 0 no
    // evento ⇔ sem criador; ver `effectivePumpSwapFeeBps` em curve-math)
    feeBps: d
      ? { lpFeeBps: d.lpFeeBps, protocolFeeBps: d.protocolFeeBps, creatorFeeBps: event.creatorFee === 0n ? 0n : d.creatorFeeBps, cashbackFeeBps: d.cashbackFeeBps }
      : null,
    baseSupply: d ? d.baseSupply : null,
    lastSlot: event.slot,
  };
}

export function applyPumpSwapTrade(state: TokenState, event: PumpSwapTradeEvent): TokenState {
  const reserves = pumpSwapReservesAfter(event);
  let next: TokenState = {
    ...state,
    venue: 'pumpswap',
    quoteMint: state.quoteMint ?? (event.quoteMint || null),
    // supply do evento do PumpSwap quando a criação não foi vista (token graduado antes do run)
    tokenTotalSupply: state.tokenTotalSupply ?? reserves.baseSupply,
    pumpSwapReserves: reserves,
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
    // constant product do PumpSwap: preço marginal = (vault de quote + virtual_quote_reserves) / base,
    // depois do trade — mesma semântica do par da curva (só com o offset conhecido)
    virtualQuoteAfter: reserves.virtualQuote === null ? null : reserves.quote + reserves.virtualQuote,
    virtualTokenAfter: reserves.virtualQuote === null ? null : reserves.base,
  });
  return next;
}

export function markCurveCompleted(state: TokenState, ts: number): TokenState {
  // A curva "completa" ainda não migrou de fato para o PumpSwap (isso acontece no pool_created +
  // primeiro trade na pool); só marcamos que não aceita mais trades de curva daqui em diante.
  // `graduatedAtMs` = primeiro `curve_completed` visto (a graduação do Pump.fun).
  return { ...state, curveCompleted: true, graduatedAtMs: state.graduatedAtMs ?? ts };
}

export function markPoolCreated(state: TokenState): TokenState {
  return { ...state, venue: 'pumpswap' };
}
