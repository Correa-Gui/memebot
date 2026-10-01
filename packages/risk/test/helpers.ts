import { fileURLToPath } from 'node:url';
import type { Clock, CurveTradeEvent, TokenCreatedEvent } from '@memebot/core';
import type { CurveFeeBps } from '@memebot/curve-math';
import { applyEvent, createEmptyMarketState } from '@memebot/state';
import type { MarketState, TokenState } from '@memebot/state';
import { loadStrategyConfig } from '@memebot/strategy';
import type { EnterDecision, StrategyV0Config } from '@memebot/strategy';

/** Taxas flat da FeeConfig do Pump.fun lidas em protocol_config (2026-09-29): 95 bps protocolo / 30 bps criador. */
export const FEES: CurveFeeBps = { protocolFeeBps: 95n, creatorFeeBps: 30n };

/** Parâmetros iniciais reais da curva (conta Global, protocol_config 2026-09-29). */
export const INITIAL_VIRTUAL_QUOTE = 30_000_000_000n;
export const INITIAL_VIRTUAL_TOKEN = 1_073_000_000_000_000n;

export const NOW = 1_759_300_000_000; // 2025-10-01T06:26:40Z — instante fixo de teste

export function realConfig(): StrategyV0Config {
  return loadStrategyConfig(fileURLToPath(new URL('../../../config/strategy.v0.yaml', import.meta.url)));
}

export function fixedClock(nowMs: number): Clock {
  return { nowMs: () => nowMs, slot: () => 0n };
}

export function enterDecision(mint: string): EnterDecision {
  return { outcome: 'enter', mint, reason: 'momentum_trigger', features: {} };
}

let seq = 0;

/** Mercado com um token na curva com as reservas virtuais dadas. */
export function marketWithToken(mint: string, virtualQuote = INITIAL_VIRTUAL_QUOTE, virtualToken = INITIAL_VIRTUAL_TOKEN): MarketState {
  seq++;
  const created: TokenCreatedEvent = {
    kind: 'token_created', slot: 1n, ts: NOW - 120_000, sig: `c-${String(seq)}`, eventIndex: 0, receivedAtMs: NOW - 120_000,
    recvSeq: seq, rawB64: '', mint, creator: 'creator-1', name: 'T', symbol: 'T', uri: 'https://x', bondingCurve: 'bc',
    quoteMint: '11111111111111111111111111111111', tokenTotalSupply: 1_000_000_000_000_000n,
  };
  const trade: CurveTradeEvent = {
    kind: 'trade', venue: 'curve', slot: 2n, ts: NOW - 1_000, sig: `t-${String(seq)}`, eventIndex: 0, receivedAtMs: NOW - 1_000,
    recvSeq: seq, rawB64: '', mint, trader: 'w1', side: 'buy', quoteMint: '11111111111111111111111111111111',
    quoteAmount: 1n, tokenAmount: 1n, virtualQuoteReserves: virtualQuote, virtualTokenReserves: virtualToken,
    realQuoteReserves: 0n, realTokenReserves: 0n, protocolFee: 0n, creatorFee: 0n, ixName: 'buy',
  };
  return applyEvent(applyEvent(createEmptyMarketState(), created), trade);
}

export function tokenOf(market: MarketState, mint: string): TokenState {
  const token = market.tokens.get(mint);
  if (!token) throw new Error(`token ${mint} ausente`);
  return token;
}
