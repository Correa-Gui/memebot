import type { Lamports } from '@memebot/core';
import { bondingCurveBuy, bondingCurveSell } from '@memebot/curve-math';
import type { CurveFeeBps } from '@memebot/curve-math';
import { estimateOneCost } from '@memebot/execution';
import { quoteInForBudget } from '@memebot/risk';
import { gapInterval, overlaps, runQuality } from './quality.ts';
import type { ReportGap, RunQuality } from './quality.ts';

/**
 * Cálculos do `pnpm report --run=<id>` — funções PURAS sobre as linhas de `decisions`/`fills` já
 * lidas (o I/O fica em `report.ts`). Testadas com fixtures, sem ClickHouse.
 *
 * Definições (documentadas também no próprio relatório):
 * - Operação = uma posição: começa num fill de compra `filled` e termina no fill de venda que zera a
 *   quantidade; vendas falhas/expiradas no meio entram como custo da operação. Compra `failed`/
 *   `expired` não é operação: é "entrada não executada" e o custo dela (priority + taxa base) entra no
 *   PnL líquido do run e na curva de drawdown.
 * - PnL líquido da operação = Σ fluxo de caixa dos fills (solOut + rentRefund − solIn − priority −
 *   tip − taxa base − rent). PnL BRUTO = só o SOL que entrou/saiu da curva SEM taxas da curva e sem
 *   custos de transação (inclui o slippage/impacto). bruto − líquido = taxas da curva + priority + tip
 *   + taxa base + rent líquido.
 * - Só operações FECHADAS entram em acerto, PnL, retornos e drawdown; as abertas são listadas à parte
 *   (sem preço de marcação no relatório).
 * - Drawdown máximo = maior queda pico→vale da curva de PnL realizado acumulado (fechamentos de
 *   operação e custos de entradas não executadas, em ordem de tempo; pico inicial = 0). Em % do
 *   capital alocado = maxOpenPositions × tamanho por operação (config).
 * - Slippage (SOL) = diferença entre o preço esperado na decisão e o realizado no fill × quantidade,
 *   positivo = pior que o esperado (compra mais cara / venda mais barata); só fills `filled`.
 *   Já está DENTRO do bruto/líquido (não é somado de novo): é informativo.
 */

export interface ReportFill {
  ts: number;
  decisionId: string;
  mint: string;
  side: 'buy' | 'sell';
  status: 'filled' | 'failed' | 'expired';
  solIn: Lamports;
  solOut: Lamports;
  tokenDelta: bigint;
  protocolFee: Lamports;
  creatorFee: Lamports;
  priorityFee: Lamports;
  jitoTip: Lamports;
  baseFee: Lamports;
  rent: Lamports;
  rentRefund: Lamports;
  expectedPrice: number;
  realizedPrice: number;
  venueUnverified: boolean;
  /** Coluna legada (006): 'tx_costs_median' só se os dois tipos vieram da mediana. */
  costEstimateSource: string;
  /** Origem por tipo (007): tx_costs_median | tx_costs_p75 | fallback (linhas antigas: a legada). */
  priorityFeeSource: string;
  jitoTipSource: string;
  /** 0 = desconhecido. */
  virtualQuoteBefore: bigint;
  virtualTokenBefore: bigint;
}

export interface ReportDecision {
  ts: number;
  decisionId: string;
  mint: string;
  type: 'enter' | 'exit' | 'reject';
  reason: string;
}

export interface Operation {
  mint: string;
  entry: ReportFill;
  sells: ReportFill[];
  /** Todos os fills da operação (entrada + vendas, inclusive falhas), em ordem. */
  fills: ReportFill[];
  closed: boolean;
  closeTs: number | null;
  /** Motivo da venda que fechou (de `decisions`), se fechada. */
  exitReason: string | null;
}

export function fillCash(f: ReportFill): Lamports {
  return f.solOut + f.rentRefund - f.solIn - f.priorityFee - f.jitoTip - f.baseFee - f.rent;
}

/** Reconstrói operações a partir dos fills (ordenados por ts, estável). */
export function buildOperations(
  fills: readonly ReportFill[],
  exitReasonByDecision: ReadonlyMap<string, string>,
): { operations: Operation[]; failedEntries: ReportFill[]; orphanSells: ReportFill[] } {
  const sorted = fills.map((f, i) => ({ f, i })).sort((a, b) => a.f.ts - b.f.ts || a.i - b.i).map((x) => x.f);
  const open = new Map<string, { op: Operation; tokens: bigint }>();
  const operations: Operation[] = [];
  const failedEntries: ReportFill[] = [];
  const orphanSells: ReportFill[] = [];
  for (const f of sorted) {
    if (f.side === 'buy') {
      if (f.status !== 'filled') {
        failedEntries.push(f);
        continue;
      }
      const op: Operation = { mint: f.mint, entry: f, sells: [], fills: [f], closed: false, closeTs: null, exitReason: null };
      operations.push(op);
      open.set(f.mint, { op, tokens: f.tokenDelta });
      continue;
    }
    const cur = open.get(f.mint);
    if (!cur) {
      orphanSells.push(f);
      continue;
    }
    cur.op.fills.push(f);
    if (f.status !== 'filled') continue;
    cur.op.sells.push(f);
    cur.tokens += f.tokenDelta; // negativo na venda
    if (cur.tokens <= 0n) {
      cur.op.closed = true;
      cur.op.closeTs = f.ts;
      cur.op.exitReason = exitReasonByDecision.get(f.decisionId) ?? 'unknown';
      open.delete(f.mint);
    }
  }
  return { operations, failedEntries, orphanSells };
}

export interface OperationMetrics {
  net: Lamports;
  gross: Lamports;
  entryCost: Lamports;
  returnRatio: number;
  curveFees: Lamports;
  priorityFee: Lamports;
  jitoTip: Lamports;
  baseFee: Lamports;
  rentNet: Lamports;
  slippage: Lamports;
}

function slippageLamports(f: ReportFill): Lamports {
  if (f.status !== 'filled' || !(f.expectedPrice > 0)) return 0n;
  const tokens = f.tokenDelta < 0n ? -f.tokenDelta : f.tokenDelta;
  const expectedQuote = BigInt(Math.round(Number(tokens) * f.expectedPrice));
  return f.side === 'buy' ? f.solIn - expectedQuote : expectedQuote - f.solOut;
}

export function operationMetrics(op: Operation): OperationMetrics {
  let net = 0n;
  let gross = 0n;
  let curveFees = 0n;
  let priorityFee = 0n;
  let jitoTip = 0n;
  let baseFee = 0n;
  let rentNet = 0n;
  let slippage = 0n;
  for (const f of op.fills) {
    net += fillCash(f);
    priorityFee += f.priorityFee;
    jitoTip += f.jitoTip;
    baseFee += f.baseFee;
    rentNet += f.rent - f.rentRefund;
    if (f.status === 'filled') {
      curveFees += f.protocolFee + f.creatorFee;
      gross += f.side === 'buy' ? -(f.solIn - f.protocolFee - f.creatorFee) : f.solOut + f.protocolFee + f.creatorFee;
      slippage += slippageLamports(f);
    }
  }
  const e = op.entry;
  const entryCost = e.solIn + e.priorityFee + e.jitoTip + e.baseFee + e.rent;
  return { net, gross, entryCost, returnRatio: entryCost > 0n ? Number(net) / Number(entryCost) : 0, curveFees, priorityFee, jitoTip, baseFee, rentNet, slippage };
}

/** Percentil (interpolação linear) de valores já ordenados. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] ?? Number.NaN;
  const b = sorted[hi] ?? Number.NaN;
  return a + (b - a) * (idx - lo);
}

export const HISTOGRAM_EDGES = [-0.5, -0.2, -0.1, 0, 0.1, 0.2, 0.5, 1];

export function histogram(values: readonly number[], edges: readonly number[] = HISTOGRAM_EDGES): { label: string; count: number }[] {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const buckets = [`≤ ${pct(edges[0] ?? 0)}`];
  for (let i = 1; i < edges.length; i++) buckets.push(`${pct(edges[i - 1] ?? 0)} a ${pct(edges[i] ?? 0)}`);
  buckets.push(`> ${pct(edges[edges.length - 1] ?? 0)}`);
  const counts = buckets.map(() => 0);
  for (const v of values) {
    let k = edges.findIndex((e) => v <= e);
    if (k === -1) k = edges.length;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return buckets.map((label, i) => ({ label, count: counts[i] ?? 0 }));
}

/** Maior queda pico→vale da curva acumulada (pico inicial 0). */
export function maxDrawdown(points: readonly { ts: number; delta: Lamports }[]): Lamports {
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  let equity = 0n;
  let peak = 0n;
  let dd = 0n;
  for (const p of sorted) {
    equity += p.delta;
    if (equity > peak) peak = equity;
    if (peak - equity > dd) dd = peak - equity;
  }
  return dd;
}

export interface SensitivityRow {
  sizeLamports: Lamports;
  operations: number;
  skipped: number;
  netLamports: Lamports;
  expectancyLamports: Lamports;
  /** Tamanho acima do hard limit de posição: só análise, nunca operável. */
  hypothetical: boolean;
}

/**
 * Recalcula as operações FECHADAS com outro tamanho (ver limitações no relatório):
 * compra = bondingCurveBuy(reservas antes do fill de entrada, quoteInForBudget(tamanho));
 * cada venda vende a mesma fração da quantidade INICIAL que a venda real vendeu (a que fecha vende o
 * resto), com bondingCurveSell(reservas antes daquele fill); taxas da curva e impacto recalculados
 * pela curve-math; custos fixos (priority, tip, taxa base, rent líquido) iguais aos reais, inclusive
 * os das vendas falhas; custos das entradas não executadas somados como estão.
 */
export function sensitivity(
  operations: readonly Operation[],
  failedEntries: readonly ReportFill[],
  sizeLamports: Lamports,
  fees: CurveFeeBps,
  hardLimitLamports: Lamports,
): SensitivityRow {
  let net = 0n;
  let counted = 0;
  let skipped = 0;
  for (const f of failedEntries) net += fillCash(f);
  for (const op of operations) {
    if (!op.closed) continue;
    const e = op.entry;
    if (e.virtualQuoteBefore <= 0n || e.virtualTokenBefore <= 0n || op.sells.some((s) => s.virtualQuoteBefore <= 0n || s.virtualTokenBefore <= 0n)) {
      skipped++;
      continue;
    }
    const quoteIn = quoteInForBudget(sizeLamports, fees);
    if (quoteIn <= 0n) {
      skipped++;
      continue;
    }
    const buy = bondingCurveBuy({ virtualQuote: e.virtualQuoteBefore, virtualToken: e.virtualTokenBefore }, quoteIn, fees);
    const initialReal = e.tokenDelta;
    let remaining = buy.tokenOut;
    let proceeds = 0n;
    op.sells.forEach((s, i) => {
      const soldReal = -s.tokenDelta;
      const last = i === op.sells.length - 1;
      let tokens = last ? remaining : (buy.tokenOut * soldReal) / initialReal;
      if (tokens > remaining) tokens = remaining;
      remaining -= tokens;
      if (tokens > 0n) proceeds += bondingCurveSell({ virtualQuote: s.virtualQuoteBefore, virtualToken: s.virtualTokenBefore }, tokens, fees).netQuoteOut;
    });
    let fixed = 0n;
    for (const f of op.fills) fixed += f.priorityFee + f.jitoTip + f.baseFee + f.rent - f.rentRefund;
    net += proceeds - buy.totalQuoteCost - fixed;
    counted++;
  }
  return {
    sizeLamports,
    operations: counted,
    skipped,
    netLamports: net,
    expectancyLamports: counted > 0 ? net / BigInt(counted) : 0n,
    hypothetical: sizeLamports > hardLimitLamports,
  };
}

export interface CostBreakdownLine {
  category: string;
  avgLamports: Lamports;
  /** % do tamanho médio da posição (solIn médio das entradas). */
  pctOfSize: number;
}

export interface CriteriaLine {
  label: string;
  value: string;
  ok: boolean;
}

export interface CostSourceCounts {
  priority: Record<string, number>;
  tip: Record<string, number>;
}

/** Bloco comparável "como rodou" × "com a mediana real" (pedido 2). */
export interface ComparableSummary {
  netLamports: Lamports;
  expectancyLamports: Lamports;
  costs: CostBreakdownLine[];
  criteria: CriteriaLine[];
}

export interface RealMedianComparison {
  priorityFeeLamports: Lamports | null;
  jitoTipLamports: Lamports | null;
  recostedFills: number;
  asRun: ComparableSummary;
  realMedian: ComparableSummary;
}

export interface GapOperations {
  gaps: number;
  estimatedGaps: number;
  operations: { mint: string; entryTs: number; closeTs: number | null; netLamports: Lamports | null }[];
  /** PnL líquido do run com e sem as operações FECHADAS marcadas. */
  netWithLamports: Lamports;
  netWithoutLamports: Lamports;
}

export interface ReportResult {
  runId: string;
  endMs: number;
  quality: RunQuality;
  expectancyLamports: Lamports;
  costSources: CostSourceCounts;
  realMedianComparison: RealMedianComparison | null;
  gapOperations: GapOperations;
  mode: string;
  startedAtMs: number | null;
  capitalLamports: Lamports;
  operations: { total: number; closed: number; open: number; failedEntries: number; orphanSells: number };
  hitRate: number;
  grossLamports: Lamports;
  netLamports: Lamports;
  netClosedLamports: Lamports;
  failedEntriesCostLamports: Lamports;
  netWithoutTop3Lamports: Lamports;
  returns: { p05: number; p25: number; p50: number; p75: number; p95: number; mean: number };
  histogram: { label: string; count: number }[];
  maxDrawdownLamports: Lamports;
  maxDrawdownPct: number;
  exitReasons: { reason: string; count: number }[];
  stopLosses: {
    count: number;
    losingCount: number;
    averageLossLamports: Lamports;
    averageLossPct: number;
    overOneAndHalfConfiguredStop: number;
    configuredStopPct: number;
  };
  rejectedTokensByReason: { reason: string; tokens: number }[];
  costs: CostBreakdownLine[];
  avgEntrySizeLamports: Lamports;
  fallbackFills: number;
  totalFills: number;
  criteria: CriteriaLine[];
  sensitivity: SensitivityRow[];
  openOperations: { mint: string; entryTs: number; entryDecisionId: string }[];
}

export interface ReportInput {
  runId: string;
  mode: string;
  startedAtMs: number | null;
  decisions: readonly ReportDecision[];
  fills: readonly ReportFill[];
  fees: CurveFeeBps;
  sizeLamports: Lamports;
  maxOpenPositions: number;
  hardLimitPositionLamports: Lamports;
  sensitivitySizesLamports: readonly Lamports[];
  minOperations?: number;
  maxDrawdownPct?: number;
  /** Stop loss da estratégia usada neste run; padrão compatível com strategy.v0.yaml. */
  stopLossPct?: number;
  /** Lacunas `reconnect` do run (ingest_gaps). */
  gaps?: readonly ReportGap[];
  /** Linha de `v_run_quality` do run, se houver run_health. */
  runHealth?: { uptimeMs: number; streamGapMs: number } | null;
  /**
   * Mediana real × 1,5 de `tx_costs` (sampled_at ≤ fim do run; tip só > 0), já limitada pelos limites
   * de custo; `null` por tipo = sem amostras. Ausente = não recalcula.
   */
  realMedianCosts?: { priorityFeeLamports: Lamports | null; jitoTipLamports: Lamports | null } | null;
}

/**
 * Mediana real × 1,5 por tipo a partir das amostras de `tx_costs` (priority: todas; tip: só > 0),
 * limitada pelos limites de custo (como o executor). `null` = sem amostras daquele tipo.
 */
export function realMedianCostsFrom(
  samples: readonly { priorityFee: Lamports; jitoTip: Lamports | null }[],
  caps: { maxPriorityFeeLamports: Lamports; maxJitoTipLamports: Lamports },
): { priorityFeeLamports: Lamports | null; jitoTipLamports: Lamports | null } {
  const cap = (v: Lamports, max: Lamports): Lamports => (v < max ? v : max);
  const pri = samples.map((x) => x.priorityFee);
  const tip = samples.flatMap((x) => (x.jitoTip !== null && x.jitoTip > 0n ? [x.jitoTip] : []));
  return {
    priorityFeeLamports: pri.length > 0 ? cap(estimateOneCost(pri, 1, 0n).lamports, caps.maxPriorityFeeLamports) : null,
    jitoTipLamports: tip.length > 0 ? cap(estimateOneCost(tip, 1, 0n).lamports, caps.maxJitoTipLamports) : null,
  };
}

/** Fim do run = último ts de decisions/fills (ou o início, se não houver nada). */
export function runEndMs(input: Pick<ReportInput, 'decisions' | 'fills' | 'startedAtMs'>): number {
  let end = input.startedAtMs ?? 0;
  for (const d of input.decisions) if (d.ts > end) end = d.ts;
  for (const f of input.fills) if (f.ts > end) end = f.ts;
  return end;
}

/**
 * Troca os custos ESTIMADOS de forma não-mediana (origem ≠ tx_costs_median, por tipo) pela mediana
 * real: priority em todo fill (toda tx paga); tip só em `filled` (failed/expired não pagam tip — mesma
 * regra do executor). Tipo sem amostras reais (`null`) fica como rodou. Puro.
 */
export function recostWithRealMedian(
  fills: readonly ReportFill[],
  real: { priorityFeeLamports: Lamports | null; jitoTipLamports: Lamports | null },
): { fills: ReportFill[]; changed: number } {
  let changed = 0;
  const out = fills.map((f) => {
    let next = f;
    if (f.priorityFeeSource !== 'tx_costs_median' && real.priorityFeeLamports !== null) {
      next = { ...next, priorityFee: real.priorityFeeLamports };
    }
    if (f.jitoTipSource !== 'tx_costs_median' && real.jitoTipLamports !== null) {
      next = { ...next, jitoTip: f.status === 'filled' ? real.jitoTipLamports : 0n };
    }
    if (next !== f) changed++;
    return next;
  });
  return { fills: out, changed };
}

function countSources(fills: readonly ReportFill[]): CostSourceCounts {
  const priority: Record<string, number> = {};
  const tip: Record<string, number> = {};
  for (const f of fills) {
    priority[f.priorityFeeSource] = (priority[f.priorityFeeSource] ?? 0) + 1;
    tip[f.jitoTipSource] = (tip[f.jitoTipSource] ?? 0) + 1;
  }
  return { priority, tip };
}

function summary(r: Omit<ReportResult, 'quality' | 'costSources' | 'realMedianComparison' | 'gapOperations' | 'endMs'>): ComparableSummary {
  return { netLamports: r.netLamports, expectancyLamports: r.expectancyLamports, costs: r.costs, criteria: r.criteria };
}

export function computeReport(input: ReportInput): ReportResult {
  const core = computeCore(input);
  const endMs = runEndMs(input);
  const gaps = input.gaps ?? [];
  const quality = runQuality(input.runHealth ?? null, gaps, input.startedAtMs ?? endMs, endMs);

  // operações abertas durante alguma lacuna do stream
  const exitReasonByDecision = new Map<string, string>();
  const { operations } = buildOperations(input.fills, exitReasonByDecision);
  const intervals = gaps.map(gapInterval);
  const flagged = operations.filter((o) => intervals.some((g) => overlaps({ fromMs: o.entry.ts, toMs: o.closeTs ?? endMs }, g)));
  const flaggedClosedNet = flagged.filter((o) => o.closed).reduce((acc, o) => acc + operationMetrics(o).net, 0n);
  const gapOperations: GapOperations = {
    gaps: gaps.length,
    estimatedGaps: quality.estimatedGaps,
    operations: flagged.map((o) => ({ mint: o.mint, entryTs: o.entry.ts, closeTs: o.closeTs, netLamports: o.closed ? operationMetrics(o).net : null })),
    netWithLamports: core.netLamports,
    netWithoutLamports: core.netLamports - flaggedClosedNet,
  };

  let realMedianComparison: RealMedianComparison | null = null;
  const nonMedian = input.fills.some((f) => f.priorityFeeSource !== 'tx_costs_median' || f.jitoTipSource !== 'tx_costs_median');
  if (nonMedian && input.realMedianCosts) {
    const recost = recostWithRealMedian(input.fills, input.realMedianCosts);
    const alt = computeCore({ ...input, fills: recost.fills });
    realMedianComparison = {
      priorityFeeLamports: input.realMedianCosts.priorityFeeLamports,
      jitoTipLamports: input.realMedianCosts.jitoTipLamports,
      recostedFills: recost.changed,
      asRun: summary(core),
      realMedian: summary(alt),
    };
  }
  return { ...core, endMs, quality, costSources: countSources(input.fills), realMedianComparison, gapOperations };
}

function countBy<T>(items: readonly T[], key: (t: T) => string): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function computeCore(input: ReportInput): Omit<ReportResult, 'quality' | 'costSources' | 'realMedianComparison' | 'gapOperations' | 'endMs'> {
  const exitReasonByDecision = new Map(input.decisions.filter((d) => d.type === 'exit').map((d) => [d.decisionId, d.reason]));
  const { operations, failedEntries, orphanSells } = buildOperations(input.fills, exitReasonByDecision);
  const closed = operations.filter((o) => o.closed);
  const metrics = closed.map(operationMetrics);
  const configuredStopPct = input.stopLossPct ?? 0.2;
  const stopLossRows = closed.flatMap((op, i) => op.exitReason === 'stop_loss' && metrics[i] ? [{ metrics: metrics[i] }] : []);
  const losingStops = stopLossRows.filter(({ metrics: m }) => m.net < 0n);
  const stopLosses = {
    count: stopLossRows.length,
    losingCount: losingStops.length,
    averageLossLamports: losingStops.length > 0
      ? losingStops.reduce((sum, { metrics: m }) => sum + m.net, 0n) / BigInt(losingStops.length)
      : 0n,
    averageLossPct: losingStops.length > 0
      ? losingStops.reduce((sum, { metrics: m }) => sum + m.returnRatio, 0) / losingStops.length
      : Number.NaN,
    overOneAndHalfConfiguredStop: stopLossRows.filter(({ metrics: m }) => m.returnRatio < -(configuredStopPct * 1.5)).length,
    configuredStopPct,
  };

  const sum = (f: (m: OperationMetrics) => Lamports): Lamports => metrics.reduce((acc, m) => acc + f(m), 0n);
  const netClosed = sum((m) => m.net);
  const failedCost = failedEntries.reduce((acc, f) => acc + fillCash(f), 0n);
  const net = netClosed + failedCost;
  const top3 = [...metrics.map((m) => m.net)].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)).slice(0, 3).reduce((a, b) => a + b, 0n);
  const returns = metrics.map((m) => m.returnRatio).sort((a, b) => a - b);
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : Number.NaN;

  const curve = [
    ...closed.map((o, i) => ({ ts: o.closeTs ?? 0, delta: metrics[i]?.net ?? 0n })),
    ...failedEntries.map((f) => ({ ts: f.ts, delta: fillCash(f) })),
  ];
  const dd = maxDrawdown(curve);
  const capital = BigInt(input.maxOpenPositions) * input.sizeLamports;
  const ddPct = capital > 0n ? Number(dd) / Number(capital) : Number.NaN;

  const n = BigInt(Math.max(closed.length, 1));
  const avgSize = closed.length > 0 ? closed.reduce((acc, o) => acc + o.entry.solIn, 0n) / n : 0n;
  const line = (category: string, total: Lamports): CostBreakdownLine => {
    const avg = closed.length > 0 ? total / n : 0n;
    return { category, avgLamports: avg, pctOfSize: avgSize > 0n ? Number(avg) / Number(avgSize) : Number.NaN };
  };
  const costs = [
    line('taxa da curva (protocolo + criador)', sum((m) => m.curveFees)),
    line('priority fee', sum((m) => m.priorityFee)),
    line('tip Jito', sum((m) => m.jitoTip)),
    line('taxa base (assinatura)', sum((m) => m.baseFee)),
    line('rent líquido (rent − devolvido)', sum((m) => m.rentNet)),
    line('slippage (esperado × realizado; já dentro do PnL)', sum((m) => m.slippage)),
  ];

  const rejects = input.decisions.filter((d) => d.type === 'reject');
  const rejectSets = new Map<string, Set<string>>();
  for (const d of rejects) {
    const s = rejectSets.get(d.reason) ?? new Set<string>();
    s.add(d.mint);
    rejectSets.set(d.reason, s);
  }
  const minOps = input.minOperations ?? 200;
  const maxDd = input.maxDrawdownPct ?? 0.3;
  const sol = (v: Lamports): string => `${(Number(v) / 1e9).toFixed(6)} SOL`;
  const netWithoutTop3 = net - top3;

  return {
    runId: input.runId,
    mode: input.mode,
    startedAtMs: input.startedAtMs,
    capitalLamports: capital,
    operations: { total: operations.length, closed: closed.length, open: operations.length - closed.length, failedEntries: failedEntries.length, orphanSells: orphanSells.length },
    hitRate: closed.length > 0 ? metrics.filter((m) => m.net > 0n).length / closed.length : Number.NaN,
    grossLamports: sum((m) => m.gross),
    netLamports: net,
    netClosedLamports: netClosed,
    failedEntriesCostLamports: failedCost,
    netWithoutTop3Lamports: netWithoutTop3,
    // expectativa por operação = PnL líquido do run (inclui custo das entradas não executadas) / fechadas
    expectancyLamports: closed.length > 0 ? net / BigInt(closed.length) : 0n,
    returns: { p05: percentile(returns, 0.05), p25: percentile(returns, 0.25), p50: percentile(returns, 0.5), p75: percentile(returns, 0.75), p95: percentile(returns, 0.95), mean },
    histogram: histogram(returns),
    maxDrawdownLamports: dd,
    maxDrawdownPct: ddPct,
    exitReasons: countBy(closed, (o) => o.exitReason ?? 'unknown').map((r) => ({ reason: r.key, count: r.count })),
    stopLosses,
    rejectedTokensByReason: [...rejectSets].map(([reason, s]) => ({ reason, tokens: s.size })).sort((a, b) => b.tokens - a.tokens || a.reason.localeCompare(b.reason)),
    costs,
    avgEntrySizeLamports: avgSize,
    fallbackFills: input.fills.filter((f) => f.costEstimateSource !== 'tx_costs_median').length,
    totalFills: input.fills.length,
    criteria: [
      { label: `≥ ${String(minOps)} operações (fechadas)`, value: String(closed.length), ok: closed.length >= minOps },
      { label: 'PnL líquido > 0', value: sol(net), ok: net > 0n },
      { label: 'PnL líquido sem as 3 melhores > 0', value: sol(netWithoutTop3), ok: netWithoutTop3 > 0n },
      { label: `drawdown máx. ≤ ${(maxDd * 100).toFixed(0)}% do capital`, value: Number.isFinite(ddPct) ? `${(ddPct * 100).toFixed(1)}% (${sol(dd)})` : 'n/d', ok: Number.isFinite(ddPct) && ddPct <= maxDd },
    ],
    sensitivity: input.sensitivitySizesLamports.map((s) => sensitivity(operations, failedEntries, s, input.fees, input.hardLimitPositionLamports)),
    openOperations: operations.filter((o) => !o.closed).map((o) => ({ mint: o.mint, entryTs: o.entry.ts, entryDecisionId: o.entry.decisionId })),
  };
}
