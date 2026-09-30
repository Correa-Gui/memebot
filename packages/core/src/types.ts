/** Lamports: menor unidade de SOL (1 SOL = 1_000_000_000n lamports). */
export type Lamports = bigint;

/** Menor unidade de um token SPL (depende dos decimals do mint). */
export type TokenAmount = bigint;

export interface Clock {
  nowMs(): number;
  slot(): bigint;
}
