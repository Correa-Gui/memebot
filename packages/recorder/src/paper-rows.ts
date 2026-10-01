import { z } from 'zod';
import { chTime, type Row } from './rows.ts';

/**
 * Linhas de `decisions` e `fills` (paper/live) e o parse das leituras que o paper faz na partida.
 * O recorder depende só de `core` (ARCHITECTURE §3): os tipos abaixo são estruturais — o `Fill` de
 * `packages/execution` é aceito diretamente por `fillToRow` sem o recorder importar `execution`.
 */

export interface DecisionRecord {
  runId: string;
  ts: number;
  decisionId: string;
  mint: string;
  type: 'enter' | 'exit' | 'reject';
  /** Chave do filtro/limite/regra (ex.: 'minUniqueHolders', 'kill_switch:stop_file', 'take_profit_1'). */
  reason: string;
  /** Snapshot das features/parâmetros usados na decisão (vira JSON; NaN/Infinity viram null). */
  features: Readonly<Record<string, number | string | boolean | null>>;
}

/** Campos do `Fill` (packages/execution/src/fill.ts) gravados em `fills` (migrações 001 + 006). */
export interface FillRecord {
  runId: string;
  ts: number;
  decisionId: string;
  mint: string;
  side: 'buy' | 'sell';
  solIn: bigint;
  solOut: bigint;
  tokenDelta: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  priorityFee: bigint;
  jitoTip: bigint;
  rent: bigint;
  rentRefund: bigint;
  baseFee: bigint;
  expectedPriceLamportsPerUnit: number;
  realizedPriceLamportsPerUnit: number;
  slippageBps: number;
  landedSlot: bigint | null;
  status: 'filled' | 'failed' | 'expired';
  error: string | null;
  venueUnverified: boolean;
  costEstimateSource: 'tx_costs_median' | 'fallback';
  costCappedByHardLimit: boolean;
  virtualQuoteBefore: bigint | null;
  virtualTokenBefore: bigint | null;
}

const u = (v: bigint): string => v.toString();

/** Float64 não aceita NaN em JSON: grava 0 (documentado: preço 0 = indefinido, ex. fill `failed`). */
function finiteOrZero(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export function decisionToRow(d: DecisionRecord): Row {
  return {
    run_id: d.runId,
    ts: chTime(d.ts),
    decision_id: d.decisionId,
    mint: d.mint,
    type: d.type,
    reason: d.reason,
    features_json: JSON.stringify(d.features),
  };
}

export function fillToRow(f: FillRecord): Row {
  return {
    run_id: f.runId,
    ts: chTime(f.ts),
    decision_id: f.decisionId,
    mint: f.mint,
    side: f.side,
    sol_in: u(f.solIn),
    sol_out: u(f.solOut),
    token_delta: u(f.tokenDelta),
    protocol_fee: u(f.protocolFee),
    creator_fee: u(f.creatorFee),
    priority_fee: u(f.priorityFee),
    jito_tip: u(f.jitoTip),
    rent: u(f.rent),
    expected_price_lamports_per_unit: finiteOrZero(f.expectedPriceLamportsPerUnit),
    realized_price_lamports_per_unit: finiteOrZero(f.realizedPriceLamportsPerUnit),
    slippage_bps: Number.isFinite(f.slippageBps) ? Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(f.slippageBps))) : 0,
    landed_slot: f.landedSlot === null ? null : u(f.landedSlot),
    status: f.status,
    error: f.error,
    venue_unverified: f.venueUnverified ? 1 : 0,
    cost_estimate_source: f.costEstimateSource,
    cost_capped: f.costCappedByHardLimit ? 1 : 0,
    rent_refund: u(f.rentRefund),
    base_fee: u(f.baseFee),
    virtual_quote_before: u(f.virtualQuoteBefore ?? 0n),
    virtual_token_before: u(f.virtualTokenBefore ?? 0n),
  };
}

/** Colunas que o paper grava em `fills` e que só existem depois da migração 006. */
export const FILLS_REQUIRED_COLUMNS = [
  'base_fee',
  'expected_price_lamports_per_unit',
  'realized_price_lamports_per_unit',
  'virtual_quote_before',
  'virtual_token_before',
  'venue_unverified',
  'cost_estimate_source',
  'cost_capped',
  'rent_refund',
] as const;

// ---- leituras (fronteira externa: validadas com zod) ----

/** UInt64/Int64 chegam como string no JSONEachRow (output_format_json_quote_64bit_integers). */
const bigintField = z.union([z.string().regex(/^-?\d+$/), z.number().int()]).transform((v) => BigInt(v));
const msField = bigintField.transform((v) => Number(v));

const TokenCreationRow = z.object({
  mint: z.string().min(1),
  creator: z.string().min(1),
  ts_ms: msField,
  slot: bigintField,
  quote_mint: z.string(),
  token_total_supply: bigintField,
});

export interface TokenCreationRecord {
  mint: string;
  creator: string;
  createdAtMs: number;
  createdAtSlot: bigint;
  quoteMint: string | null;
  tokenTotalSupply: bigint;
}

export function parseTokenCreationRows(rows: unknown[]): TokenCreationRecord[] {
  return rows.map((r) => {
    const p = TokenCreationRow.parse(r);
    return {
      mint: p.mint,
      creator: p.creator,
      createdAtMs: p.ts_ms,
      createdAtSlot: p.slot,
      quoteMint: p.quote_mint === '' ? null : p.quote_mint,
      tokenTotalSupply: p.token_total_supply,
    };
  });
}

const TxCostRow = z.object({ priority_fee: bigintField, jito_tip: bigintField.nullable() });

export function parseTxCostRows(rows: unknown[]): { priorityFee: bigint; jitoTip: bigint | null }[] {
  return rows.map((r) => {
    const p = TxCostRow.parse(r);
    return { priorityFee: p.priority_fee, jitoTip: p.jito_tip };
  });
}

const ProtocolConfigRow = z.object({ config_json: z.string(), config_hash: z.string(), ts_ms: msField });

export interface ProtocolConfigRecord {
  configJson: unknown;
  configHash: string;
  tsMs: number;
}

export function parseProtocolConfigRow(row: unknown): ProtocolConfigRecord {
  const p = ProtocolConfigRow.parse(row);
  return { configJson: JSON.parse(p.config_json) as unknown, configHash: p.config_hash, tsMs: p.ts_ms };
}
