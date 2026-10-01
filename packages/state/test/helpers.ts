import type {
  CurveTradeEvent,
  OnchainEventBase,
  PoolCreatedEvent,
  PumpSwapTradeEvent,
  TokenCreatedEvent,
} from '@memebot/core';
import type { MarketState, TokenState } from '../src/types.ts';

/** Busca o token no estado e lança (em vez de `!`, banido pelo eslint) se ele não existir. */
export function getToken(state: MarketState, mint: string): TokenState {
  const token = state.tokens.get(mint);
  if (!token) throw new Error(`token ${mint} não encontrado no estado`);
  return token;
}

let seq = 0;

function base(ts: number, slot = 1n): OnchainEventBase {
  seq++;
  return { slot, ts, sig: `sig-${String(seq)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: seq, rawB64: '' };
}

export function tokenCreated(partial: Partial<TokenCreatedEvent> & { mint: string; ts: number }): TokenCreatedEvent {
  return {
    kind: 'token_created',
    ...base(partial.ts),
    creator: 'creator-1',
    name: 'Test',
    symbol: 'TST',
    uri: 'https://example.com',
    bondingCurve: 'curve-1',
    quoteMint: '11111111111111111111111111111111',
    tokenTotalSupply: 1_000_000_000_000_000n,
    ...partial,
  };
}

export function curveTrade(
  partial: Partial<CurveTradeEvent> & { mint: string; ts: number; side: 'buy' | 'sell'; trader: string },
): CurveTradeEvent {
  return {
    kind: 'trade',
    venue: 'curve',
    ...base(partial.ts, partial.slot),
    quoteMint: '11111111111111111111111111111111',
    quoteAmount: 1_000_000n,
    tokenAmount: 1_000_000_000n,
    virtualQuoteReserves: 30_000_000_000n,
    virtualTokenReserves: 1_073_000_000_000_000n,
    realQuoteReserves: 0n,
    realTokenReserves: 793_100_000_000_000n,
    protocolFee: 9_500n,
    creatorFee: 3_000n,
    ixName: partial.side,
    ...partial,
  };
}

export function pumpSwapTrade(
  partial: Partial<PumpSwapTradeEvent> & { pool: string; ts: number; side: 'buy' | 'sell'; trader: string },
): PumpSwapTradeEvent {
  return {
    kind: 'trade',
    venue: 'pumpswap',
    ...base(partial.ts, partial.slot),
    mint: '',
    quoteMint: 'So11111111111111111111111111111111111111112',
    poolUnresolved: true,
    tokenAmount: 1_000_000_000n,
    quoteAmount: 1_000_000n,
    userQuoteAmount: 990_000n,
    poolBaseReserves: 900_000_000_000_000n,
    poolQuoteReserves: 100_000_000_000n,
    lpFee: 2_000n,
    protocolFee: 500n,
    creatorFee: 9_000n,
    ixName: partial.side === 'buy' ? 'buy_exact_quote_in' : null,
    ...partial,
  };
}

export function poolCreated(partial: Partial<PoolCreatedEvent> & { pool: string; mint: string; ts: number }): PoolCreatedEvent {
  return {
    kind: 'pool_created',
    ...base(partial.ts),
    quoteMint: 'So11111111111111111111111111111111111111112',
    creator: 'creator-1',
    ...partial,
  };
}
