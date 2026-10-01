import type { Lamports } from '@memebot/core';

/**
 * Taxas em basis points (1 bps = 0,01%), no formato devolvido pelo programa de taxas
 * compartilhado `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` (ver `get_fees_with_quote_mint`
 * no IDL `packages/ingest/src/idl/pump_fees.json`) e gravado em `protocol_config`
 * (account_type `FeeConfig`, campos `flat_fees` / `fee_tiers[].fees` / `stable_fee_tiers[].fees`).
 */
export interface FeeBps {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

export interface FeeTier {
  marketCapLamportsThreshold: bigint;
  fees: FeeBps;
}

/** Forma relevante da conta `FeeConfig` para o lookup de tier (ver `protocol_config.config_json`). */
export interface FeeConfigAccount {
  flatFees: FeeBps;
  feeTiers: readonly FeeTier[];
  stableFeeTiers: readonly FeeTier[];
  exoticFlatFees: FeeBps;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor deve ser positivo');
  if (a < 0n) throw new RangeError('ceilDiv: dividendo não pode ser negativo');
  return (a + b - 1n) / b;
}

/**
 * Taxa em lamports para um valor e uma taxa em bps, arredondada para cima.
 *
 * Confirmado com trades reais da bonding curve (ver `scripts/extract-golden-fixtures.ts` e os
 * fixtures em `test/fixtures/golden/curve.json`): `protocol_fee`/`creator_fee` gravados batem
 * exatamente com `ceil(quoteAmount * bps / 10000)` para os bps lidos de `protocol_config`
 * (Pump.fun FeeConfig, conta `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`, flat 95/30 bps
 * em 2026-09-29). Floor NÃO bate (testado e descartado).
 */
export function feeFromBps(amount: Lamports, bps: bigint): Lamports {
  if (bps === 0n) return 0n;
  return ceilDiv(amount * bps, 10000n);
}

/**
 * Escolhe o tier aplicável: o de maior `marketCapLamportsThreshold` que seja `<=` o market cap
 * atual. Os tiers vêm ordenados crescente em `protocol_config`; o primeiro tier tem threshold 0
 * e serve de piso (sempre há um tier aplicável).
 *
 * Validado contra um trade real do PumpSwap (ver STRATEGY/relatório da Fase 2): market cap =
 * `poolQuoteReservesAntes * tokenTotalSupply / poolBaseReservesAntes` reproduziu exatamente o
 * tier de `creator_fee_bps = 90` observado num trade real (fixture `pumpswap.json`).
 */
export function lookupFeeTier(tiers: readonly FeeTier[], marketCapLamports: bigint): FeeBps {
  if (tiers.length === 0) throw new RangeError('lookupFeeTier: lista de tiers vazia');
  const sorted = [...tiers].sort((a, b) => Number(a.marketCapLamportsThreshold - b.marketCapLamportsThreshold));
  const first = sorted[0];
  if (!first) throw new RangeError('lookupFeeTier: lista de tiers vazia');
  let chosen = first;
  for (const tier of sorted) {
    if (tier.marketCapLamportsThreshold <= marketCapLamports) chosen = tier;
    else break;
  }
  return chosen.fees;
}

/** `isStableQuote` reflete se o quote mint está em `whitelisted_quote_mints` (Global) — usa `stableFeeTiers`. */
export function resolveFees(config: FeeConfigAccount, marketCapLamports: bigint, isStableQuote: boolean): FeeBps {
  const tiers = isStableQuote ? config.stableFeeTiers : config.feeTiers;
  if (tiers.length === 0) return config.flatFees;
  return lookupFeeTier(tiers, marketCapLamports);
}
