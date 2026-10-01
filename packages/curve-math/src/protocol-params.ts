import { z } from 'zod';
import type { CurveInitialParams } from './bonding-curve.ts';

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
