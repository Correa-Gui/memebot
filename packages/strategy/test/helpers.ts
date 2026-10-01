import type { CurveTradeEvent, OnchainEventBase, PoolCreatedEvent, PumpEvent, TokenCreatedEvent } from '@memebot/core';
import { applyEvent, createEmptyMarketState } from '@memebot/state';
import type { CurveInitialParams } from '@memebot/curve-math';
import type { MarketState } from '@memebot/state';

/** Valores da conta `Global` gravados em `protocol_config` (snapshot 2026-09-29), só para testes. */
export const CURVE_PARAMS: CurveInitialParams = {
  initialVirtualQuote: 30_000_000_000n,
  initialVirtualToken: 1_073_000_000_000_000n,
  initialRealToken: 793_100_000_000_000n,
};
import type { StrategyV0Config } from '../src/config.ts';

export const NATIVE_SOL_QUOTE_MINT = '11111111111111111111111111111111';

/** Instante "agora" fixo usado por todos os cenários (clock de teste, nunca `Date.now()`). */
export const NOW = 1_000_000_000;
export const CREATED_AT_SLOT = 100n;
export const OTHER_SLOT = 101n;

let seq = 0;

function base(ts: number, slot = OTHER_SLOT): OnchainEventBase {
  seq++;
  return { slot, ts, sig: `sig-${String(seq)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: seq, rawB64: '' };
}

function tokenCreated(partial: Partial<TokenCreatedEvent> & { mint: string; ts: number }): TokenCreatedEvent {
  return {
    kind: 'token_created',
    ...base(partial.ts, partial.slot ?? CREATED_AT_SLOT),
    creator: 'creator-1',
    name: 'Test',
    symbol: 'TST',
    uri: 'https://example.com',
    bondingCurve: 'curve-1',
    quoteMint: NATIVE_SOL_QUOTE_MINT,
    tokenTotalSupply: 1_000_000n,
    ...partial,
  };
}

function curveTrade(
  partial: Partial<CurveTradeEvent> & { mint: string; ts: number; side: 'buy' | 'sell'; trader: string },
): CurveTradeEvent {
  return {
    kind: 'trade',
    venue: 'curve',
    ...base(partial.ts, partial.slot),
    quoteMint: NATIVE_SOL_QUOTE_MINT,
    quoteAmount: 1_000_000n,
    tokenAmount: 1_000_000n,
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

function poolCreated(partial: Partial<PoolCreatedEvent> & { pool: string; mint: string; ts: number }): PoolCreatedEvent {
  return {
    kind: 'pool_created',
    ...base(partial.ts),
    quoteMint: 'So11111111111111111111111111111111111111112',
    creator: 'creator-1',
    ...partial,
  };
}

/** Config base usada em todos os testes de `evaluate` — limiares fixos, só o cenário varia. */
export function baseStrategyConfig(): StrategyV0Config {
  return {
    version: 'v0-test',
    entry: {
      minAgeSec: 60,
      maxAgeSec: 600,
      minBuySellVolumeRatio60s: 1.5,
      minUniqueBuyers60s: 3,
      requirePriceAboveMean120s: true,
      maxSingleSellPctSupply60s: 0.03,
    },
    filters: {
      allowedVenues: ['curve'],
      allowedQuoteMints: [NATIVE_SOL_QUOTE_MINT],
      maxTop10PctSupply: 0.3,
      maxSameSlotAsCreatePct: 0.1,
      maxCreatorHoldingPct: 0.05,
      maxCreatorTokens24h: 3,
      minUniqueHolders: 3,
      minVolume60sSol: 1,
      maxRiskScore: 0.3,
    },
    sizing: { sizeSol: 0.1, maxOwnPriceImpactPct: 0.02 },
    exits: {
      takeProfit: [{ gainPct: 0.4, sellFraction: 0.5 }],
      trailingStopPct: 0.25,
      stopLossPct: 0.2,
      timeStopSec: 600,
      emergency: { singleSellPctSupply: 0.05, exitOnCreatorSell: true },
    },
    signals: {
      riskModel: { enabled: false, path: 'packages/signals/models/risk.onnx' },
      narrative: { enabled: false, minMatch: 0.7 },
      smartMoney: { enabled: false, minWallets: 2 },
    },
    risk: { maxOpenPositions: 3, maxDailyLossSol: 0.2 },
  };
}

export interface ScenarioOverrides {
  tokenTotalSupply?: bigint;
  ageSec?: number;
  venue?: 'curve' | 'pumpswap';
  quoteMint?: string;
  creator?: string;
  /** Saldo de um holder isolado (fora da janela), controla `top10HolderPct`. Default: 50_000n (5%). */
  topHolderAmount?: bigint;
  /** Quantos holders extras com saldo residual (1 token cada) — controla `uniqueHolderCount`. Default: 2. */
  extraHolderCount?: number;
  /** Compra no mesmo slot da criação — controla `sameSlotBuyPct`. Default: 0n. */
  sameSlotAmount?: bigint;
  /** Compra do próprio criador — controla `creatorHoldingPct`. Default: 0n. */
  creatorHoldingAmount?: bigint;
  /** Nº de outros tokens do mesmo criador criados nas últimas 24h — controla `creatorTokensCreated24h`. Default: 0. */
  creatorOtherTokens24h?: number;
  /** Quote (lamports) de cada compra na janela de 60s. Default: 2_000_000_000n (2 SOL). */
  windowBuyQuoteEach?: bigint;
  /** Quote (lamports) de cada venda na janela de 60s (mesmo comprador vende tudo de volta). Default: 300_000_000n. */
  windowSellQuoteEach?: bigint;
  /** Tokens comprados/vendidos por cada participante da janela. Default: 10_000n. */
  windowTokenEach?: bigint;
  /** Nº de compradores distintos na janela de 60s. Default: 3. */
  numWindowBuyers?: number;
  /** Reservas virtuais do último trade (definem o "preço atual" via preço marginal). */
  finalVirtualQuote?: bigint;
  finalVirtualToken?: bigint;
}

export interface Scenario {
  state: MarketState;
  mint: string;
  nowMs: number;
  config: StrategyV0Config;
}

/**
 * Monta um `MarketState` sintético controlável por metro (uma opção por feature), de forma que
 * cada teste de `evaluate` precise alterar só UM parâmetro para reprovar só o filtro
 * correspondente (os demais continuam no valor "padrão que passa"). Sem overrides, o cenário
 * passa em todos os filtros de `docs/STRATEGY.md` §3 e no gatilho §4.
 */
export function buildScenario(overrides: ScenarioOverrides = {}): Scenario {
  const mint = 'mintA';
  const tokenTotalSupply = overrides.tokenTotalSupply ?? 1_000_000n;
  const ageSec = overrides.ageSec ?? 300;
  const quoteMint = overrides.quoteMint ?? NATIVE_SOL_QUOTE_MINT;
  const creator = overrides.creator ?? 'creator-1';
  const createdAtMs = NOW - ageSec * 1000;
  const setupTs = createdAtMs + 1;

  const events: PumpEvent[] = [];
  events.push(tokenCreated({ mint, ts: createdAtMs, slot: CREATED_AT_SLOT, creator, quoteMint, tokenTotalSupply }));

  const topHolderAmount = overrides.topHolderAmount ?? 50_000n;
  if (topHolderAmount > 0n) {
    events.push(curveTrade({ mint, ts: setupTs, slot: OTHER_SLOT, side: 'buy', trader: 'top-holder', tokenAmount: topHolderAmount, quoteAmount: 1_000n }));
  }

  const extraHolderCount = overrides.extraHolderCount ?? 2;
  for (let i = 0; i < extraHolderCount; i++) {
    events.push(curveTrade({ mint, ts: setupTs, slot: OTHER_SLOT, side: 'buy', trader: `extra-holder-${String(i)}`, tokenAmount: 1n, quoteAmount: 1n }));
  }

  const sameSlotAmount = overrides.sameSlotAmount ?? 0n;
  if (sameSlotAmount > 0n) {
    events.push(curveTrade({ mint, ts: setupTs, slot: CREATED_AT_SLOT, side: 'buy', trader: 'bundler', tokenAmount: sameSlotAmount, quoteAmount: 1_000n }));
  }

  const creatorHoldingAmount = overrides.creatorHoldingAmount ?? 0n;
  if (creatorHoldingAmount > 0n) {
    events.push(curveTrade({ mint, ts: setupTs, slot: OTHER_SLOT, side: 'buy', trader: creator, tokenAmount: creatorHoldingAmount, quoteAmount: 1_000n }));
  }

  const creatorOtherTokens24h = overrides.creatorOtherTokens24h ?? 0;
  for (let i = 0; i < creatorOtherTokens24h; i++) {
    events.push(
      tokenCreated({ mint: `other-mint-${String(i)}`, ts: NOW - 1_000, slot: 999n, creator, quoteMint, tokenTotalSupply }),
    );
  }

  const windowBuyQuoteEach = overrides.windowBuyQuoteEach ?? 2_000_000_000n;
  const windowSellQuoteEach = overrides.windowSellQuoteEach ?? 300_000_000n;
  const windowTokenEach = overrides.windowTokenEach ?? 10_000n;
  const numWindowBuyers = overrides.numWindowBuyers ?? 3;
  const finalVirtualQuote = overrides.finalVirtualQuote ?? 300_000_000_000n;
  const finalVirtualToken = overrides.finalVirtualToken ?? 1_000_000n;

  // Espalha as compras em [NOW - 50 s, NOW - 2 s) para qualquer `numWindowBuyers` caber na janela de 60 s.
  const stepMs = Math.floor(48_000 / Math.max(1, numWindowBuyers));
  for (let i = 0; i < numWindowBuyers; i++) {
    const trader = `window-buyer-${String(i)}`;
    const buyTs = NOW - 50_000 + i * stepMs;
    const sellTs = buyTs + 1_000;
    const isLast = i === numWindowBuyers - 1;
    events.push(
      curveTrade({ mint, ts: buyTs, slot: OTHER_SLOT, side: 'buy', trader, tokenAmount: windowTokenEach, quoteAmount: windowBuyQuoteEach }),
    );
    events.push(
      curveTrade({
        mint,
        ts: sellTs,
        slot: OTHER_SLOT,
        side: 'sell',
        trader,
        tokenAmount: windowTokenEach,
        quoteAmount: windowSellQuoteEach,
        ...(isLast ? { virtualQuoteReserves: finalVirtualQuote, virtualTokenReserves: finalVirtualToken } : {}),
      }),
    );
  }

  if (overrides.venue === 'pumpswap') {
    events.push(poolCreated({ pool: 'pool-x', mint, ts: NOW }));
  }

  const state = events.reduce<MarketState>((acc, ev) => applyEvent(acc, ev), createEmptyMarketState());
  return { state, mint, nowMs: NOW, config: baseStrategyConfig() };
}
