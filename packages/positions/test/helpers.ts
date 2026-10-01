import { fileURLToPath } from 'node:url';
import type { CurveTradeEvent, PumpEvent, TokenCreatedEvent } from '@memebot/core';
import { bondingCurveBuy } from '@memebot/curve-math';
import type { CurveFeeBps } from '@memebot/curve-math';
import type { Fill } from '@memebot/execution';
import { quoteInForBudget } from '@memebot/risk';
import { applyEvent, createEmptyMarketState } from '@memebot/state';
import type { MarketState, TokenState } from '@memebot/state';
import { loadStrategyConfig } from '@memebot/strategy';
import type { StrategyV0Config } from '@memebot/strategy';
import type { ExitContext } from '../src/index.ts';

export const FEES: CurveFeeBps = { protocolFeeBps: 95n, creatorFeeBps: 30n };
export const INITIAL_VIRTUAL_QUOTE = 30_000_000_000n;
export const INITIAL_VIRTUAL_TOKEN = 1_073_000_000_000_000n;
export const K = INITIAL_VIRTUAL_QUOTE * INITIAL_VIRTUAL_TOKEN;
/** FIXTURE de teste: rent-exempt de conta SPL (165 bytes); produção lê via RPC no adaptador. */
export const RENT_FIXTURE = 2_039_280n;
export const SUPPLY = 1_000_000_000_000_000n;
export const T0 = 1_759_300_000_000;
export const MINT = 'mintA';
export const CREATOR = 'creator-1';

export const CTX: ExitContext = { fees: FEES, exitPriorityFeeLamports: 225_000n, exitJitoTipLamports: 300_000n };

export function realConfig(): StrategyV0Config {
  return loadStrategyConfig(fileURLToPath(new URL('../../../config/strategy.v0.yaml', import.meta.url)));
}

let seq = 0;
function base(ts: number): { slot: bigint; ts: number; sig: string; eventIndex: number; receivedAtMs: number; recvSeq: number; rawB64: string } {
  seq++;
  return { slot: BigInt(ts), ts, sig: `sig-${String(seq)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: seq, rawB64: '' };
}

export function created(mint: string, ts: number): TokenCreatedEvent {
  return {
    kind: 'token_created', ...base(ts), mint, creator: CREATOR, name: 'T', symbol: 'T', uri: 'https://x', bondingCurve: 'bc',
    quoteMint: '11111111111111111111111111111111', tokenTotalSupply: SUPPLY,
  };
}

export function trade(mint: string, ts: number, virtualQuote: bigint, opts: { side?: 'buy' | 'sell'; trader?: string; tokenAmount?: bigint } = {}): CurveTradeEvent {
  const side = opts.side ?? 'buy';
  return {
    kind: 'trade', venue: 'curve', ...base(ts), mint, trader: opts.trader ?? 'other', side,
    quoteMint: '11111111111111111111111111111111', quoteAmount: 1n, tokenAmount: opts.tokenAmount ?? 1n,
    virtualQuoteReserves: virtualQuote, virtualTokenReserves: K / virtualQuote,
    realQuoteReserves: 0n, realTokenReserves: 0n, protocolFee: 0n, creatorFee: 0n, ixName: side,
  };
}

export function applyAll(events: readonly PumpEvent[], market: MarketState = createEmptyMarketState()): MarketState {
  return events.reduce(applyEvent, market);
}

export function tokenOf(market: MarketState, mint = MINT): TokenState {
  const t = market.tokens.get(mint);
  if (!t) throw new Error('token ausente');
  return t;
}

/** Token com as reservas `vq` (vt = K/vq) e os eventos extras. */
export function tokenAt(vq: bigint, extra: readonly PumpEvent[] = []): TokenState {
  return tokenOf(applyAll([created(MINT, T0 - 120_000), trade(MINT, T0 - 1_000, vq), ...extra]));
}

const ZERO_FILL: Omit<Fill, 'side' | 'decisionId' | 'ts'> = {
  runId: 'run-test', mint: MINT, solIn: 0n, solOut: 0n, tokenDelta: 0n, protocolFee: 0n, creatorFee: 0n,
  priorityFee: 0n, jitoTip: 0n, rent: 0n, rentRefund: 0n, expectedPriceSol: 0, realizedPriceSol: 0, slippageBps: 0,
  landedSlot: null, status: 'filled', error: null, venueUnverified: false, costEstimateSource: 'tx_costs_median',
  costCappedByHardLimit: false,
};

/** Fill de compra de 0,05 SOL (total com taxas) nas reservas iniciais reais. */
export function buyFill(ts = T0): Fill {
  const sim = bondingCurveBuy({ virtualQuote: INITIAL_VIRTUAL_QUOTE, virtualToken: INITIAL_VIRTUAL_TOKEN }, quoteInForBudget(50_000_000n, FEES), FEES);
  return {
    ...ZERO_FILL, side: 'buy', decisionId: 'd-buy', ts, solIn: sim.totalQuoteCost, tokenDelta: sim.tokenOut,
    protocolFee: sim.protocolFee, creatorFee: sim.creatorFee, priorityFee: 225_000n, jitoTip: 300_000n, rent: RENT_FIXTURE,
  };
}

export function sellFill(partial: Partial<Fill>): Fill {
  return { ...ZERO_FILL, side: 'sell', decisionId: 'd-sell', ts: T0 + 1, ...partial };
}
