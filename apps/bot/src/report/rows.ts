import { z } from 'zod';
import type { ReportDecision, ReportFill } from './compute.ts';

/** Parse (zod) das linhas lidas do ClickHouse para o relatório. u64/Int64 chegam como string. */

const big = z.union([z.string().regex(/^-?\d+$/), z.number().int()]).transform((v) => BigInt(v));
const ms = big.transform((v) => Number(v));

const RunRow = z.object({ run_id: z.string(), mode: z.string(), started_ms: ms });

export function parseRunRow(row: unknown): { runId: string; mode: string; startedMs: number } {
  const p = RunRow.parse(row);
  return { runId: p.run_id, mode: p.mode, startedMs: p.started_ms };
}

const DecisionRow = z.object({
  ts_ms: ms,
  decision_id: z.string(),
  mint: z.string(),
  type: z.enum(['enter', 'exit', 'reject']),
  reason: z.string(),
  features_json: z.string(),
});

export function parseDecisionRows(rows: unknown[]): { decisions: ReportDecision[]; features: Map<string, Record<string, unknown>> } {
  const features = new Map<string, Record<string, unknown>>();
  const decisions = rows.map((r) => {
    const p = DecisionRow.parse(r);
    try {
      const f: unknown = JSON.parse(p.features_json);
      if (f !== null && typeof f === 'object') features.set(p.decision_id, f as Record<string, unknown>);
    } catch {
      // features_json ilegível: a decisão continua valendo; só o snapshot fica de fora
    }
    return { ts: p.ts_ms, decisionId: p.decision_id, mint: p.mint, type: p.type, reason: p.reason };
  });
  return { decisions, features };
}

const FillRow = z.object({
  ts_ms: ms,
  decision_id: z.string(),
  mint: z.string(),
  side: z.enum(['buy', 'sell']),
  status: z.enum(['filled', 'failed', 'expired']),
  sol_in: big,
  sol_out: big,
  token_delta: big,
  protocol_fee: big,
  creator_fee: big,
  priority_fee: big,
  jito_tip: big,
  base_fee: big,
  rent: big,
  rent_refund: big,
  expected_price_lamports_per_unit: z.number(),
  realized_price_lamports_per_unit: z.number(),
  venue_unverified: z.number(),
  cost_estimate_source: z.string(),
  virtual_quote_before: big,
  virtual_token_before: big,
});

export function parseFillRows(rows: unknown[]): ReportFill[] {
  return rows.map((r) => {
    const p = FillRow.parse(r);
    return {
      ts: p.ts_ms,
      decisionId: p.decision_id,
      mint: p.mint,
      side: p.side,
      status: p.status,
      solIn: p.sol_in,
      solOut: p.sol_out,
      tokenDelta: p.token_delta,
      protocolFee: p.protocol_fee,
      creatorFee: p.creator_fee,
      priorityFee: p.priority_fee,
      jitoTip: p.jito_tip,
      baseFee: p.base_fee,
      rent: p.rent,
      rentRefund: p.rent_refund,
      expectedPrice: p.expected_price_lamports_per_unit,
      realizedPrice: p.realized_price_lamports_per_unit,
      venueUnverified: p.venue_unverified === 1,
      costEstimateSource: p.cost_estimate_source,
      virtualQuoteBefore: p.virtual_quote_before,
      virtualTokenBefore: p.virtual_token_before,
    };
  });
}
