import { z } from 'zod';
import type { MintTradePoint } from './analysis.ts';
import type { ReportDecision, ReportFill } from './compute.ts';

/** Parse (zod) das linhas lidas do ClickHouse para o relatório. u64/Int64 chegam como string. */

const big = z.union([z.string().regex(/^-?\d+$/), z.number().int()]).transform((v) => BigInt(v));
const ms = big.transform((v) => Number(v));

const RunRow = z.object({
  run_id: z.string(),
  mode: z.string(),
  started_ms: ms,
  // migração 009 (ausentes antes dela)
  discarded: z.number().optional(),
  discard_reason: z.string().optional(),
});

export function parseRunRow(row: unknown): { runId: string; mode: string; startedMs: number; discardReason: string | null } {
  const p = RunRow.parse(row);
  return { runId: p.run_id, mode: p.mode, startedMs: p.started_ms, discardReason: p.discarded === 1 ? (p.discard_reason ?? '') : null };
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
  // migração 007; ausentes/'unknown' em fills anteriores → cai na coluna legada cost_estimate_source
  priority_fee_source: z.string().optional(),
  jito_tip_source: z.string().optional(),
  virtual_quote_before: big,
  virtual_token_before: big,
});

function sourceOrLegacy(perType: string | undefined, legacy: string): string {
  return perType === undefined || perType === '' || perType === 'unknown' ? legacy : perType;
}

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
      priorityFeeSource: sourceOrLegacy(p.priority_fee_source, p.cost_estimate_source),
      jitoTipSource: sourceOrLegacy(p.jito_tip_source, p.cost_estimate_source),
      virtualQuoteBefore: p.virtual_quote_before,
      virtualTokenBefore: p.virtual_token_before,
    };
  });
}

const GapRow = z.object({ detected_ms: ms, duration_ms: ms, detail: z.string() });

export function parseGapRows(rows: unknown[]): { detectedAtMs: number; durationMs: number; detail: string }[] {
  return rows.map((r) => {
    const p = GapRow.parse(r);
    return { detectedAtMs: p.detected_ms, durationMs: p.duration_ms, detail: p.detail };
  });
}

const HealthRow = z.object({ uptime_ms: ms, stream_gap_ms: ms });

export function parseRunHealthRow(row: unknown): { uptimeMs: number; streamGapMs: number } {
  const p = HealthRow.parse(row);
  return { uptimeMs: p.uptime_ms, streamGapMs: p.stream_gap_ms };
}

const CostRow = z.object({ priority_fee: big, jito_tip: big.nullable() });

export function parseCostRows(rows: unknown[]): { priorityFee: bigint; jitoTip: bigint | null }[] {
  return rows.map((r) => {
    const p = CostRow.parse(r);
    return { priorityFee: p.priority_fee, jitoTip: p.jito_tip };
  });
}

const TradePointRow = z.object({
  mint: z.string(),
  ts_ms: ms,
  venue: z.enum(['curve', 'pumpswap']),
  vq: big.nullable(),
  vt: big.nullable(),
});

/** Trades por mint, na ordem recebida (a query ordena por mint, ts, slot, recv_seq). */
export function parseTradePointRows(rows: unknown[]): Map<string, MintTradePoint[]> {
  const out = new Map<string, MintTradePoint[]>();
  for (const r of rows) {
    const p = TradePointRow.parse(r);
    const list = out.get(p.mint) ?? [];
    list.push({ ts: p.ts_ms, venue: p.venue, virtualQuote: p.vq, virtualToken: p.vt });
    out.set(p.mint, list);
  }
  return out;
}

const CompletedRow = z.object({ mint: z.string(), ts_ms: ms });

export function parseCompletedRows(rows: unknown[]): Map<string, number> {
  return new Map(rows.map((r) => {
    const p = CompletedRow.parse(r);
    return [p.mint, p.ts_ms] as [string, number];
  }));
}

const MinuteRow = z.object({ m: ms });

export function parseMinuteRows(rows: unknown[]): Set<number> {
  return new Set(rows.map((r) => MinuteRow.parse(r).m));
}
