import type {
  CurveTradeEvent,
  OnchainEventBase,
  TokenCreatedEvent,
} from '@memebot/core';
import type { CurveInitialParams } from '@memebot/curve-math';
import type { MarketState, TokenState } from '@memebot/state';

/** Valores da conta `Global` gravados em `protocol_config` (snapshot 2026-09-29), só para testes. */
export const CURVE_PARAMS: CurveInitialParams = {
  initialVirtualQuote: 30_000_000_000n,
  initialVirtualToken: 1_073_000_000_000_000n,
  initialRealToken: 793_100_000_000_000n,
};

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
    ...base(partial.ts, partial.slot),
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
