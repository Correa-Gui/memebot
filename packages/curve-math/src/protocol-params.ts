import { z } from 'zod';
import type { CurveFeeBps, CurveInitialParams } from './bonding-curve.ts';
import type { FeeBps, FeeConfigAccount, FeeTier } from './fees.ts';

const u64String = z
  .string()
  .regex(/^\d+$/, 'u64 deve vir como string decimal')
  .transform((s) => BigInt(s));

/**
 * Campos da conta `Global` do Pump.fun usados pela matemática da curva.
 * Fonte: IDL oficial `packages/ingest/src/idl/pump.json`, tipo `Global` (struct), campos u64
 * `initial_virtual_token_reserves`, `initial_virtual_sol_reserves`, `initial_real_token_reserves`.
 * O `config_json` gravado em `protocol_config` (account_type = 'Global') serializa u64 como string.
 */
const GlobalCurveFieldsSchema = z.object({
  initial_virtual_token_reserves: u64String,
  initial_virtual_sol_reserves: u64String,
  initial_real_token_reserves: u64String,
});

/**
 * Converte o `config_json` da conta `Global` (linha de `protocol_config`) nos parâmetros iniciais
 * da curva **cotada em SOL** (usa `initial_virtual_sol_reserves`; curvas com quote whitelisted usam
 * `initial_virtual_quote_reserves`, fora do universo da v0 — `filters.allowedQuoteMints`).
 */
export function parseCurveInitialParams(globalConfigJson: unknown): CurveInitialParams {
  const parsed = GlobalCurveFieldsSchema.parse(globalConfigJson);
  if (parsed.initial_real_token_reserves <= 0n || parsed.initial_real_token_reserves > parsed.initial_virtual_token_reserves) {
    throw new RangeError('Global: initial_real_token_reserves fora do intervalo (0, initial_virtual_token_reserves]');
  }
  return {
    initialVirtualQuote: parsed.initial_virtual_sol_reserves,
    initialVirtualToken: parsed.initial_virtual_token_reserves,
    initialRealToken: parsed.initial_real_token_reserves,
  };
}

const FeeBpsSchema = z.object({
  lp_fee_bps: u64String,
  protocol_fee_bps: u64String,
  creator_fee_bps: u64String,
});

const FeeTierSchema = z.object({
  market_cap_lamports_threshold: u64String,
  fees: FeeBpsSchema,
});

/**
 * Campos da conta `FeeConfig` (programa de taxas `pfeeUxB6…`) usados no cálculo de taxas.
 * Fonte: IDL oficial `packages/ingest/src/idl/pump_fees.json`, tipo `FeeConfig` (`flat_fees`,
 * `fee_tiers`, `stable_fee_tiers`, `exotic_flat_fees`); `config_json` em `protocol_config`
 * (account_type = 'FeeConfig') serializa u64 como string.
 */
const FeeConfigSchema = z.object({
  flat_fees: FeeBpsSchema,
  fee_tiers: z.array(FeeTierSchema),
  stable_fee_tiers: z.array(FeeTierSchema),
  exotic_flat_fees: FeeBpsSchema,
});

function toFeeBps(f: z.infer<typeof FeeBpsSchema>): FeeBps {
  return { lpFeeBps: f.lp_fee_bps, protocolFeeBps: f.protocol_fee_bps, creatorFeeBps: f.creator_fee_bps };
}

function toTier(t: z.infer<typeof FeeTierSchema>): FeeTier {
  return { marketCapLamportsThreshold: t.market_cap_lamports_threshold, fees: toFeeBps(t.fees) };
}

/** Converte o `config_json` de uma linha `FeeConfig` de `protocol_config` (validado com zod). */
export function parseFeeConfigAccount(feeConfigJson: unknown): FeeConfigAccount {
  const parsed = FeeConfigSchema.parse(feeConfigJson);
  return {
    flatFees: toFeeBps(parsed.flat_fees),
    feeTiers: parsed.fee_tiers.map(toTier),
    stableFeeTiers: parsed.stable_fee_tiers.map(toTier),
    exoticFlatFees: toFeeBps(parsed.exotic_flat_fees),
  };
}

/**
 * Taxas da bonding curve (cotada em SOL, quote não-stable) para um run inteiro do paper, que usa um
 * único `CurveFeeBps`: o tier de `fee_tiers` (ou `flat_fees`, se não houver tiers) com a MAIOR soma
 * protocolo + criador — pessimista (ARCHITECTURE §5) quando os tiers por market cap diferem. Em
 * 2026-09-29 todos os tiers do FeeConfig do Pump.fun eram iguais (95/30 bps), então o resultado é
 * exatamente a taxa cobrada. O lookup exato por market cap (`resolveFees`) continua disponível.
 */
export function worstCaseCurveFees(config: FeeConfigAccount): CurveFeeBps {
  const candidates = config.feeTiers.length > 0 ? config.feeTiers.map((t) => t.fees) : [config.flatFees];
  let worst = candidates[0] ?? config.flatFees;
  for (const fees of candidates) {
    if (fees.protocolFeeBps + fees.creatorFeeBps > worst.protocolFeeBps + worst.creatorFeeBps) worst = fees;
  }
  return { protocolFeeBps: worst.protocolFeeBps, creatorFeeBps: worst.creatorFeeBps };
}
