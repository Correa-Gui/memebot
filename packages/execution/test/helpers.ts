import type { CurveCompletedEvent, CurveTradeEvent, PoolCreatedEvent, PumpEvent, TokenCreatedEvent } from '@memebot/core';
import type { CurveFeeBps } from '@memebot/curve-math';
import { LAMPORTS_PER_SIGNATURE } from '@memebot/ingest';
import { HARD_LIMITS } from '@memebot/risk';
import type { EffectiveRiskLimits } from '@memebot/risk';
import { applyEvent, createEmptyMarketState } from '@memebot/state';
import type { MarketState } from '@memebot/state';
import type { TxCostEstimate } from '../src/costs.ts';
import type { PaperExecutorParams } from '../src/paper.ts';

/** Taxas flat reais (FeeConfig do Pump.fun em protocol_config, 2026-09-29). */
export const FEES: CurveFeeBps = { protocolFeeBps: 95n, creatorFeeBps: 30n };
/** Conta Global real (protocol_config 2026-09-29). */
export const INITIAL_VIRTUAL_QUOTE = 30_000_000_000n;
export const INITIAL_VIRTUAL_TOKEN = 1_073_000_000_000_000n;
export const INITIAL_REAL_TOKEN = 793_100_000_000_000n;
/**
 * FIXTURE de teste (não é valor de produção): rent-exempt da ATA Token-2022 do mint do Pump.fun
 * (170 bytes — `GetAccountDataSize` devolve 170 em `packages/ingest/test/fixtures/curve-create.json`),
 * igual ao saldo pós das ATAs criadas nessa tx real (1 513 840) e a
 * `getMinimumBalanceForRentExemption(170)` na mainnet em 2026-10-01. Em produção o adaptador de
 * borda (`fetchTokenAccountRent`) lê via RPC.
 */
export const RENT_FIXTURE = 1_513_840n;
/** Taxa base por assinatura: a mesma constante que o orquestrador injeta (fonte em `onchain.ts`). */
export const BASE_FEE = LAMPORTS_PER_SIGNATURE;

export const T0 = 1_759_300_000_000;
export const MINT = 'mintA';

export function limits(overrides: Partial<EffectiveRiskLimits> = {}): EffectiveRiskLimits {
  return {
    sizeLamports: HARD_LIMITS.maxPositionLamports,
    maxPositionLamports: HARD_LIMITS.maxPositionLamports,
    maxOpenPositions: HARD_LIMITS.maxOpenPositions,
    maxDailyLossLamports: HARD_LIMITS.maxDailyLossLamports,
    maxHotWalletLamports: HARD_LIMITS.maxHotWalletLamports,
    maxSlippageBps: HARD_LIMITS.maxSlippageBps,
    maxPriorityFeeLamports: HARD_LIMITS.maxPriorityFeeLamports,
    maxJitoTipLamports: HARD_LIMITS.maxJitoTipLamports,
    maxOwnPriceImpactPct: 0.02,
    minSizeFraction: 0.5,
    ...overrides,
  };
}

export function costs(priority = 225_000n, tip = 300_000n): TxCostEstimate {
  return {
    priorityFeeLamports: priority,
    jitoTipLamports: tip,
    priorityFeeSource: 'tx_costs_median',
    jitoTipSource: 'tx_costs_median',
    prioritySampleCount: 30,
    tipSampleCount: 30,
  };
}

export function params(overrides: Partial<PaperExecutorParams> = {}): PaperExecutorParams {
  return {
    runId: 'run-test',
    latencyMs: 800,
    failRate: 0,
    fees: FEES,
    tokenAccountRentLamports: RENT_FIXTURE,
    baseFeeLamportsPerSignature: BASE_FEE,
    costs: costs(),
    limits: limits(),
    ...overrides,
  };
}

let seq = 0;
function base(ts: number): { slot: bigint; ts: number; sig: string; eventIndex: number; receivedAtMs: number; recvSeq: number; rawB64: string } {
  seq++;
  return { slot: BigInt(ts), ts, sig: `sig-${String(seq)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: seq, rawB64: '' };
}

export function created(mint: string, ts: number, creator = 'creator-1'): TokenCreatedEvent {
  return {
    kind: 'token_created', ...base(ts), mint, creator, name: 'T', symbol: 'T', uri: 'https://x', bondingCurve: 'bc',
    quoteMint: '11111111111111111111111111111111', tokenTotalSupply: 1_000_000_000_000_000n,
  };
}

/** Trade de terceiro com as reservas virtuais pós-trade dadas (o que importa para o executor). */
export function trade(mint: string, ts: number, virtualQuote: bigint, virtualToken: bigint, side: 'buy' | 'sell' = 'buy', trader = 'other', tokenAmount = 1n): CurveTradeEvent {
  return {
    kind: 'trade', venue: 'curve', ...base(ts), mint, trader, side, quoteMint: '11111111111111111111111111111111',
    quoteAmount: 1n, tokenAmount, virtualQuoteReserves: virtualQuote, virtualTokenReserves: virtualToken,
    realQuoteReserves: 0n, realTokenReserves: 0n, protocolFee: 0n, creatorFee: 0n, ixName: side,
  };
}

export function completed(mint: string, ts: number): CurveCompletedEvent {
  return { kind: 'curve_completed', ...base(ts), mint, bondingCurve: 'bc' };
}

export function poolCreated(mint: string, ts: number): PoolCreatedEvent {
  return { kind: 'pool_created', ...base(ts), pool: 'pool-1', mint, quoteMint: 'So11111111111111111111111111111111111111112', creator: 'c' };
}

export function applyAll(events: readonly PumpEvent[], market: MarketState = createEmptyMarketState()): MarketState {
  return events.reduce(applyEvent, market);
}

/** Mercado com `MINT` criado e um trade deixando as reservas virtuais iniciais. */
export function initialMarket(mint = MINT, vq = INITIAL_VIRTUAL_QUOTE, vt = INITIAL_VIRTUAL_TOKEN): MarketState {
  return applyAll([created(mint, T0 - 120_000), trade(mint, T0 - 1_000, vq, vt)]);
}
