/**
 * Program IDs e PDAs do Pump.fun e do PumpSwap (mainnet).
 *
 * Fonte dos program IDs: campo `address` dos IDLs oficiais em
 * https://github.com/pump-fun/pump-public-docs/tree/main/idl
 * (pump.json, pump_amm.json, pump_fees.json; commit e0687ae, 2026-09-12).
 * PDAs: os IDLs não trazem endereço fixo; derivados localmente com
 * `getProgramDerivedAddress` (@solana/kit) a partir das seeds indicadas.
 * Conferido em 2026-09-29.
 *
 * Taxas e parâmetros da curva NÃO ficam aqui: são lidos on-chain na inicialização
 * (ver CLAUDE.md §7 e tabela `protocol_config`), nunca hardcoded.
 */

export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** PDA global do Pump.fun, seeds ["global"]. */
export const PUMP_FUN_GLOBAL_PDA = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';

export const PUMP_SWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** PDA de configuração global do PumpSwap, seeds ["global_config"]. */
export const PUMP_SWAP_GLOBAL_CONFIG_PDA = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';

/** Programa de taxas compartilhado entre Pump.fun e PumpSwap. */
export const PUMP_FEES_PROGRAM_ID = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

/**
 * Mints de cotação que representam SOL. Observado nas fixtures gravadas em 2026-09-29
 * (packages/ingest/test/fixtures): na curva, SOL nativo aparece como `quote_mint` = System Program
 * (com `quote_amount` == `sol_amount`); no PumpSwap a cotação é WSOL (também fixo no IDL, conta
 * `wsol_mint` da instrução `migrate`).
 */
export const NATIVE_SOL_QUOTE_MINT = '11111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_QUOTE_MINTS: readonly string[] = [NATIVE_SOL_QUOTE_MINT, WSOL_MINT];

export const PROTOCOL_PROGRAM_IDS = [
  PUMP_FUN_PROGRAM_ID,
  PUMP_SWAP_PROGRAM_ID,
] as const;
