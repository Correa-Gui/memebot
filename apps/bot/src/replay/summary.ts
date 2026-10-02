import type { Lamports } from '@memebot/core';
import type { Fill } from '@memebot/execution';
import type { DecisionRecord } from '@memebot/recorder';
import { buildEffectiveRiskLimits } from '@memebot/risk';
import { bootstrapExpectancy } from '../report/analysis.ts';
import { buildOperations, computeReport, operationMetrics } from '../report/compute.ts';
import type { ReportDecision, ReportFill } from '../report/compute.ts';
import { overlapsAny, type Interval } from './gaps.ts';
import type { VariantRun } from './run.ts';

/**
 * Resumo de um run de replay com as MESMAS funções puras do `pnpm report` (report/compute.ts e o
 * bootstrap de report/analysis.ts) — assim um número da tabela de hipóteses é o mesmo que o relatório
 * do run gravado mostraria.
 */

export function toReportFill(f: Fill): ReportFill {
  return {
    ts: f.ts, decisionId: f.decisionId, mint: f.mint, side: f.side, status: f.status, solIn: f.solIn, solOut: f.solOut, tokenDelta: f.tokenDelta,
    protocolFee: f.protocolFee, creatorFee: f.creatorFee, priorityFee: f.priorityFee, jitoTip: f.jitoTip, baseFee: f.baseFee, rent: f.rent,
    rentRefund: f.rentRefund, expectedPrice: f.expectedPriceLamportsPerUnit, realizedPrice: f.realizedPriceLamportsPerUnit,
    venueUnverified: f.venueUnverified, costEstimateSource: f.costEstimateSource, priorityFeeSource: f.priorityFeeSource, jitoTipSource: f.jitoTipSource,
    virtualQuoteBefore: f.virtualQuoteBefore ?? 0n, virtualTokenBefore: f.virtualTokenBefore ?? 0n,
  };
}

export function toReportDecision(d: DecisionRecord): ReportDecision {
  return { ts: d.ts, decisionId: d.decisionId, mint: d.mint, type: d.type, reason: d.reason };
}

export interface VariantSummary {
  label: string;
  runId: string;
  closed: number;
  open: number;
  failedEntries: number;
  hitRate: number;
  grossLamports: Lamports;
  /** PnL líquido do run (fechadas + custo das entradas não executadas). */
  netLamports: Lamports;
  /** Média do PnL líquido por operação fechada + IC 95% (bootstrap 10.000 réplicas, seed fixa) e P(média > 0). */
  expectancyLamports: number;
  ci95: [number, number];
  probPositive: number;
  maxDrawdownLamports: Lamports;
  maxDrawdownPct: number;
  netWithoutTop3Lamports: Lamports;
  exitReasons: { reason: string; count: number }[];
  /** Operações cuja vida (entrada → saída) cruza uma lacuna de gravação, e o PnL líquido sem elas. */
  gapOperations: number;
  netWithoutGapOpsLamports: Lamports;
  enters: number;
}

export function summarizeVariant(run: VariantRun, gaps: readonly Interval[]): VariantSummary {
  const limits = buildEffectiveRiskLimits(run.config);
  const fills = run.fills.map(toReportFill);
  const decisions = run.decisions.map(toReportDecision);
  const r = computeReport({
    runId: run.runId, mode: 'replay', startedAtMs: null, decisions, fills, fees: { protocolFeeBps: 0n, creatorFeeBps: 0n },
    sizeLamports: limits.sizeLamports, maxOpenPositions: limits.maxOpenPositions, hardLimitPositionLamports: limits.sizeLamports,
    sensitivitySizesLamports: [], stopLossPct: run.config.exits.stopLossPct,
  });
  const exitReasonByDecision = new Map(decisions.filter((d) => d.type === 'exit').map((d) => [d.decisionId, d.reason]));
  const { operations } = buildOperations(fills, exitReasonByDecision);
  const closed = operations.filter((o) => o.closed);
  const nets = closed.map((o) => operationMetrics(o).net);
  const boot = bootstrapExpectancy(nets);
  const gapOps = closed.filter((o) => overlapsAny(gaps, o.entry.ts, o.closeTs ?? o.entry.ts));
  const gapNet = gapOps.reduce((acc, o) => acc + operationMetrics(o).net, 0n);
  return {
    label: run.label, runId: run.runId, closed: r.operations.closed, open: r.operations.open, failedEntries: r.operations.failedEntries,
    hitRate: r.hitRate, grossLamports: r.grossLamports, netLamports: r.netLamports, expectancyLamports: boot.meanLamports, ci95: boot.ci95,
    probPositive: boot.probPositive, maxDrawdownLamports: r.maxDrawdownLamports, maxDrawdownPct: r.maxDrawdownPct,
    netWithoutTop3Lamports: r.netWithoutTop3Lamports, exitReasons: r.exitReasons, gapOperations: gapOps.length,
    netWithoutGapOpsLamports: r.netLamports - gapNet, enters: run.decisions.filter((d) => d.type === 'enter').length,
  };
}

const sol = (v: Lamports | number): string => (Number(v) / 1e9).toFixed(4);
const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/d');

/** Linha curta (texto) de um resumo. */
export function formatSummaryLine(s: VariantSummary): string {
  return [
    `ops ${String(s.closed)} (+${String(s.open)} abertas, ${String(s.failedEntries)} entradas não executadas)`,
    `acerto ${pct(s.hitRate)}`,
    `bruto ${sol(s.grossLamports)}`,
    `líquido ${sol(s.netLamports)} SOL`,
    `exp/op ${sol(s.expectancyLamports)} [${sol(s.ci95[0])}; ${sol(s.ci95[1])}] P>0 ${pct(s.probPositive)}`,
    `DD ${sol(s.maxDrawdownLamports)} (${pct(s.maxDrawdownPct)})`,
  ].join(' · ');
}
