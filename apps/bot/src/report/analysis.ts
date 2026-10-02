import type { Lamports } from '@memebot/core';
import { bondingCurveSell } from '@memebot/curve-math';
import type { CurveFeeBps } from '@memebot/curve-math';
import { mulberry32Next, seedFromString } from '@memebot/execution';
import type { Operation, OperationMetrics, ReportFill } from './compute.ts';
import { fillCash, percentile } from './compute.ts';
import { aggregatePostExit, alternativeRules, compareExitRules, postExitAnalysis } from './exit-sim.ts';
import type { ExitRulesComparison, PostExitAggregate, PostExitRow } from './exit-sim.ts';

/**
 * Análises de "por que a estratégia perde" (funções PURAS; o I/O fica em report.ts).
 *
 * Fonte de preço depois da operação: trades de `v_trades` do próprio mint. Preço marginal da curva =
 * virtualQuote / virtualToken do ÚLTIMO trade de curva com ts ≤ t (lamports por unidade mínima, mesma
 * unidade de `marginalPrice`). Regras para não inventar dado:
 * - **sem dados**: o instante t passa do fim dos dados gravados, ou algum minuto entre a saída e t não
 *   tem nenhum trade gravado (de nenhum mint) — o gravador estava parado e o "último trade" seria velho;
 * - **graduou**: houve trade no PumpSwap (ou `curve_completed`) do mint até t — depois disso não há
 *   reservas virtuais da curva; o preço não é comparável e não é calculado.
 */

export interface MintTradePoint {
  ts: number;
  venue: 'curve' | 'pumpswap';
  /** Reservas virtuais da curva após o trade (null no PumpSwap). */
  virtualQuote: bigint | null;
  virtualToken: bigint | null;
}

/** Cobertura de gravação: minutos (início do minuto, ms UTC) com pelo menos um trade de qualquer mint. */
export interface DataCoverage {
  minutes: ReadonlySet<number>;
  endMs: number;
}

const MINUTE = 60_000;
const floorMinute = (ms: number): number => Math.floor(ms / MINUTE) * MINUTE;

/** true se todos os minutos de [fromMs, toMs] têm dados e toMs ≤ fim dos dados. */
export function covered(c: DataCoverage, fromMs: number, toMs: number): boolean {
  if (toMs > c.endMs) return false;
  for (let m = floorMinute(fromMs); m <= floorMinute(toMs); m += MINUTE) if (!c.minutes.has(m)) return false;
  return true;
}

export type PriceLookup =
  | { status: 'ok'; price: number; lastTradeTs: number }
  | { status: 'graduated' }
  | { status: 'no_data' };

export function marginal(vq: bigint, vt: bigint): number {
  return vt > 0n ? Number(vq) / Number(vt) : Number.NaN;
}

/**
 * Preço marginal em t. `points` ordenados por ts. `completedAtMs`: curve_completed do mint (se houver).
 * `sinceMs`: início do trecho que precisa estar coberto (ex.: a saída).
 */
export function priceAt(points: readonly MintTradePoint[], t: number, sinceMs: number, coverage: DataCoverage, completedAtMs: number | null): PriceLookup {
  if (!covered(coverage, sinceMs, t)) return { status: 'no_data' };
  if (completedAtMs !== null && completedAtMs <= t) return { status: 'graduated' };
  let last: MintTradePoint | null = null;
  for (const p of points) {
    if (p.ts > t) break;
    if (p.venue === 'pumpswap') return { status: 'graduated' };
    if (p.virtualQuote !== null && p.virtualToken !== null) last = p;
  }
  if (!last || last.virtualQuote === null || last.virtualToken === null) return { status: 'no_data' };
  return { status: 'ok', price: marginal(last.virtualQuote, last.virtualToken), lastTradeTs: last.ts };
}

// ---------- 1. stops: tempo até o stop, MFE e o que aconteceu depois ----------

export const AFTER_STOP_HORIZONS_MIN = [5, 15, 60] as const;

export interface StopAnalysisRow {
  mint: string;
  entryTs: number;
  exitTs: number;
  holdMs: number;
  /** PnL líquido realizado da operação / custo de entrada. */
  returnRatio: number;
  /**
   * MFE líquido: maior `netPnlRatio` que a posição teria tido em algum trade de curva entre a entrada e
   * o stop — mesma base de `packages/positions` (liquidar o restante com bondingCurveSell nas reservas
   * daquele trade, menos os custos de tx da saída real, mais o rent devolvido, mais o já realizado).
   * `null` sem trades no intervalo.
   */
  mfeNetRatio: number | null;
  /** Mesma medida em preço marginal: máx. preço marginal no intervalo / preço marginal na entrada − 1. */
  mfePriceRatio: number | null;
  /** Preço marginal na saída (reservas antes do fill do stop). */
  exitPrice: number;
  /** Por horizonte: preço / preço de saída − 1, ou o motivo de não haver número. */
  after: { minutes: number; ratio: number | null; status: PriceLookup['status'] }[];
}

export interface StopAnalysis {
  rows: StopAnalysisRow[];
  medianHoldMs: number;
  medianMfeNetRatio: number;
  horizons: { minutes: number; withData: number; medianRatio: number; aboveExit: number; graduated: number; noData: number }[];
}

function sellFillCosts(f: ReportFill): Lamports {
  return f.priorityFee + f.jitoTip + f.baseFee;
}

/** `netPnlRatio` em cada trade de curva entre a entrada e a última venda (base de positions). */
function mfeNet(op: Operation, metrics: OperationMetrics, points: readonly MintTradePoint[], fees: CurveFeeBps): number | null {
  const lastSell = op.sells.at(-1);
  if (!lastSell) return null;
  const exitCosts = sellFillCosts(lastSell);
  const end = op.closeTs ?? lastSell.ts;
  let best: number | null = null;
  for (const p of points) {
    if (p.ts <= op.entry.ts) continue;
    if (p.ts > end) break;
    if (p.venue !== 'curve' || p.virtualQuote === null || p.virtualToken === null) continue;
    // estado da posição nesse instante: vendas preenchidas com ts < p.ts já realizadas
    let held = op.entry.tokenDelta;
    let realized = 0n;
    for (const f of op.fills) {
      if (f === op.entry || f.ts >= p.ts) continue;
      realized += f.side === 'sell' ? fillCash(f) : 0n;
      if (f.side === 'sell' && f.status === 'filled') held += f.tokenDelta;
    }
    if (held <= 0n) continue;
    const net = bondingCurveSell({ virtualQuote: p.virtualQuote, virtualToken: p.virtualToken }, held, fees).netQuoteOut;
    const liquidation = net - exitCosts + op.entry.rent;
    const ratio = Number(realized + liquidation - metrics.entryCost) / Number(metrics.entryCost);
    if (best === null || ratio > best) best = ratio;
  }
  return best;
}

function mfePrice(op: Operation, points: readonly MintTradePoint[]): number | null {
  const entryPrice = marginal(op.entry.virtualQuoteBefore, op.entry.virtualTokenBefore);
  const end = op.closeTs ?? op.sells.at(-1)?.ts ?? op.entry.ts;
  let max: number | null = null;
  for (const p of points) {
    if (p.ts <= op.entry.ts || p.ts > end) continue;
    if (p.venue !== 'curve' || p.virtualQuote === null || p.virtualToken === null) continue;
    const price = marginal(p.virtualQuote, p.virtualToken);
    if (max === null || price > max) max = price;
  }
  return max === null || !(entryPrice > 0) ? null : max / entryPrice - 1;
}

export interface MintMarketData {
  points: ReadonlyMap<string, readonly MintTradePoint[]>;
  completedAt: ReadonlyMap<string, number>;
  coverage: DataCoverage;
}

export function analyzeStops(ops: readonly { op: Operation; metrics: OperationMetrics }[], market: MintMarketData, fees: CurveFeeBps): StopAnalysis {
  const rows: StopAnalysisRow[] = [];
  for (const { op, metrics } of ops) {
    if (!op.closed || op.exitReason !== 'stop_loss' || op.closeTs === null) continue;
    const pts = market.points.get(op.mint) ?? [];
    const stopFill = op.sells.at(-1);
    const exitPrice = stopFill ? marginal(stopFill.virtualQuoteBefore, stopFill.virtualTokenBefore) : Number.NaN;
    const completed = market.completedAt.get(op.mint) ?? null;
    const exitTs = op.closeTs;
    rows.push({
      mint: op.mint,
      entryTs: op.entry.ts,
      exitTs: op.closeTs,
      holdMs: op.closeTs - op.entry.ts,
      returnRatio: metrics.returnRatio,
      mfeNetRatio: mfeNet(op, metrics, pts, fees),
      mfePriceRatio: mfePrice(op, pts),
      exitPrice,
      after: AFTER_STOP_HORIZONS_MIN.map((minutes) => {
        const look = priceAt(pts, exitTs + minutes * MINUTE, exitTs, market.coverage, completed);
        return { minutes, status: look.status, ratio: look.status === 'ok' && exitPrice > 0 ? look.price / exitPrice - 1 : null };
      }),
    });
  }
  const sorted = (xs: number[]): number[] => xs.sort((a, b) => a - b);
  return {
    rows,
    medianHoldMs: percentile(sorted(rows.map((r) => r.holdMs)), 0.5),
    medianMfeNetRatio: percentile(sorted(rows.flatMap((r) => (r.mfeNetRatio === null ? [] : [r.mfeNetRatio]))), 0.5),
    horizons: AFTER_STOP_HORIZONS_MIN.map((minutes, i) => {
      const cells = rows.map((r) => r.after[i]);
      const ratios = cells.flatMap((c) => (c && c.ratio !== null ? [c.ratio] : []));
      return {
        minutes,
        withData: ratios.length,
        medianRatio: percentile(sorted(ratios), 0.5),
        aboveExit: ratios.filter((x) => x > 0).length,
        graduated: cells.filter((c) => c?.status === 'graduated').length,
        noData: cells.filter((c) => c?.status === 'no_data').length,
      };
    }),
  };
}

// ---------- 2. token vivo 1 h depois da entrada ----------

/** Definição: houve trade (qualquer venue) em [entrada+55 min, entrada+65 min] E preço marginal 1 h depois ≥ 10% do de entrada. */
export const ALIVE_WINDOW_MIN = [55, 65] as const;
export const ALIVE_MIN_PRICE_RATIO = 0.1;

export type AliveStatus = 'vivo' | 'morto' | 'graduou' | 'sem_dados';

export function aliveAfterHour(op: Operation, market: MintMarketData): AliveStatus {
  const pts = market.points.get(op.mint) ?? [];
  const from = op.entry.ts + ALIVE_WINDOW_MIN[0] * MINUTE;
  const to = op.entry.ts + ALIVE_WINDOW_MIN[1] * MINUTE;
  if (!covered(market.coverage, op.entry.ts, to)) return 'sem_dados';
  const look = priceAt(pts, op.entry.ts + 60 * MINUTE, op.entry.ts, market.coverage, market.completedAt.get(op.mint) ?? null);
  if (look.status === 'graduated') return 'graduou';
  const traded = pts.some((p) => p.ts >= from && p.ts <= to);
  if (!traded || look.status !== 'ok') return 'morto';
  const entryPrice = marginal(op.entry.virtualQuoteBefore, op.entry.virtualTokenBefore);
  return entryPrice > 0 && look.price >= ALIVE_MIN_PRICE_RATIO * entryPrice ? 'vivo' : 'morto';
}

export interface AliveTable {
  /** linhas: resultado da operação (ganho / perda / aberta); colunas: status. */
  rows: { outcome: string; counts: Record<AliveStatus, number>; total: number }[];
}

export function aliveTable(ops: readonly { op: Operation; metrics: OperationMetrics | null }[], market: MintMarketData): AliveTable {
  const groups = new Map<string, Record<AliveStatus, number>>();
  const empty = (): Record<AliveStatus, number> => ({ vivo: 0, morto: 0, graduou: 0, sem_dados: 0 });
  for (const { op, metrics } of ops) {
    const outcome = !op.closed || !metrics ? 'aberta' : metrics.net > 0n ? 'ganho' : 'perda';
    const g = groups.get(outcome) ?? empty();
    g[aliveAfterHour(op, market)]++;
    groups.set(outcome, g);
  }
  const all = empty();
  const rows = ['ganho', 'perda', 'aberta'].flatMap((outcome) => {
    const c = groups.get(outcome);
    if (!c) return [];
    for (const k of Object.keys(all) as AliveStatus[]) all[k] += c[k];
    return [{ outcome, counts: c, total: c.vivo + c.morto + c.graduou + c.sem_dados }];
  });
  rows.push({ outcome: 'todas', counts: all, total: all.vivo + all.morto + all.graduou + all.sem_dados });
  return { rows };
}

// ---------- 3. retorno por faixa de idade e de volume na entrada ----------

export interface Bucket {
  label: string;
  min: number;
  max: number;
}

export const AGE_BUCKETS_SEC: Bucket[] = [
  { label: '1–3 min', min: 60, max: 180 },
  { label: '3–6 min', min: 180, max: 360 },
  { label: '6–10 min', min: 360, max: Number.POSITIVE_INFINITY },
];

export const VOLUME_BUCKETS_SOL: Bucket[] = [
  { label: '5–10 SOL', min: 0, max: 10 },
  { label: '10–25 SOL', min: 10, max: 25 },
  { label: '25–50 SOL', min: 25, max: 50 },
  { label: '> 50 SOL', min: 50, max: Number.POSITIVE_INFINITY },
];

export interface BucketStats {
  label: string;
  n: number;
  hitRate: number;
  meanReturn: number;
  medianReturn: number;
  netLamports: Lamports;
}

/**
 * Agrupa operações FECHADAS por uma feature do snapshot do `enter` (intervalo [min, max)). Operações
 * sem a feature caem em "sem dado".
 */
export function bucketize(
  ops: readonly { metrics: OperationMetrics; features: Readonly<Record<string, unknown>> | undefined }[],
  feature: string,
  buckets: readonly Bucket[],
): BucketStats[] {
  const groups = new Map<string, OperationMetrics[]>();
  for (const { metrics, features } of ops) {
    const raw = features?.[feature];
    const v = typeof raw === 'number' ? raw : Number.NaN;
    const b = Number.isFinite(v) ? buckets.find((x) => v >= x.min && v < x.max) : undefined;
    const label = b?.label ?? 'sem dado';
    groups.set(label, [...(groups.get(label) ?? []), metrics]);
  }
  return [...buckets.map((b) => b.label), 'sem dado'].flatMap((label) => {
    const ms = groups.get(label);
    if (!ms || ms.length === 0) return label === 'sem dado' ? [] : [{ label, n: 0, hitRate: Number.NaN, meanReturn: Number.NaN, medianReturn: Number.NaN, netLamports: 0n }];
    const rets = ms.map((m) => m.returnRatio).sort((a, b) => a - b);
    return [{
      label,
      n: ms.length,
      hitRate: ms.filter((m) => m.net > 0n).length / ms.length,
      meanReturn: rets.reduce((a, b) => a + b, 0) / rets.length,
      medianReturn: percentile(rets, 0.5),
      netLamports: ms.reduce((acc, m) => acc + m.net, 0n),
    }];
  });
}

// ---------- 4. bootstrap da expectativa ----------

export interface BootstrapResult {
  n: number;
  replicas: number;
  seed: string;
  meanLamports: number;
  ci95: [number, number];
  probPositive: number;
}

/**
 * Expectativa (média do PnL líquido por operação fechada) com IC 95% por bootstrap: `replicas`
 * reamostragens com reposição, PRNG mulberry32 semeado (`seed`) → determinístico. IC = percentis
 * 2,5/97,5 das médias; probabilidade = fração das réplicas com média > 0.
 */
export function bootstrapExpectancy(netsLamports: readonly bigint[], replicas = 10_000, seed = 'report-bootstrap'): BootstrapResult {
  const xs = netsLamports.map((v) => Number(v));
  const n = xs.length;
  const mean = n > 0 ? xs.reduce((a, b) => a + b, 0) / n : Number.NaN;
  if (n === 0) return { n, replicas, seed, meanLamports: Number.NaN, ci95: [Number.NaN, Number.NaN], probPositive: Number.NaN };
  let state = seedFromString(seed);
  const means: number[] = new Array<number>(replicas);
  for (let r = 0; r < replicas; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = mulberry32Next(state);
      state = d.state;
      sum += xs[Math.floor(d.value * n)] ?? 0;
    }
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  return { n, replicas, seed, meanLamports: mean, ci95: [percentile(means, 0.025), percentile(means, 0.975)], probPositive: means.filter((m) => m > 0).length / replicas };
}

// ---------- 5. slippage por lado ----------

export interface SlippageSide {
  side: 'buy' | 'sell';
  fills: number;
  totalLamports: Lamports;
  /** Σ slippage / Σ valor esperado (preço esperado × tokens). */
  pctOfExpected: number;
  /** média por fill de (slippage / valor esperado) × 10 000. */
  meanBps: number;
}

/**
 * Slippage por lado (só fills `filled` com preço esperado > 0), positivo = PIOR que o esperado na
 * decisão: compra = solIn − preço_esperado × tokens; venda = preço_esperado × tokens − solOut, com o
 * preço esperado já líquido das taxas da curva (mesma convenção do executor).
 */
export function slippageBySide(fills: readonly ReportFill[]): SlippageSide[] {
  return (['buy', 'sell'] as const).map((side) => {
    let total = 0n;
    let expectedTotal = 0;
    const bps: number[] = [];
    for (const f of fills) {
      if (f.side !== side || f.status !== 'filled' || !(f.expectedPrice > 0)) continue;
      const tokens = f.tokenDelta < 0n ? -f.tokenDelta : f.tokenDelta;
      const expected = Number(tokens) * f.expectedPrice;
      const slip = side === 'buy' ? Number(f.solIn) - expected : expected - Number(f.solOut);
      total += BigInt(Math.round(slip));
      expectedTotal += expected;
      if (expected > 0) bps.push((slip / expected) * 10_000);
    }
    return {
      side,
      fills: bps.length,
      totalLamports: total,
      pctOfExpected: expectedTotal > 0 ? Number(total) / expectedTotal : Number.NaN,
      meanBps: bps.length > 0 ? bps.reduce((a, b) => a + b, 0) / bps.length : Number.NaN,
    };
  });
}

// ---------- agregado ----------

export interface ExitAnalysisOptions {
  /** Saídas da config (TP, trailing, stop, time stop) para as regras alternativas. */
  exits: { takeProfit: readonly { gainPct: number; sellFraction: number }[]; trailingStopPct: number; stopLossPct: number; timeStopSec: number };
  latencyMs: number;
  horizonMs: number;
  /** decision_id da venda → motivo (decisions type exit). */
  exitReasonByDecision: ReadonlyMap<string, string>;
}

export interface Analysis {
  postExit: { rows: PostExitRow[]; aggregate: PostExitAggregate[] };
  exitRules: ExitRulesComparison;
  stops: StopAnalysis;
  alive: AliveTable;
  byAge: BucketStats[];
  byVolume: BucketStats[];
  bootstrap: BootstrapResult;
  slippage: SlippageSide[];
}

export function computeAnalysis(
  operations: readonly { op: Operation; metrics: OperationMetrics | null }[],
  fills: readonly ReportFill[],
  enterFeatures: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  market: MintMarketData,
  fees: CurveFeeBps,
  exitOpts: ExitAnalysisOptions,
): Analysis {
  const closed = operations.flatMap((o) => (o.op.closed && o.metrics ? [{ op: o.op, metrics: o.metrics }] : []));
  const withFeatures = closed.map((c) => ({ metrics: c.metrics, features: enterFeatures.get(c.op.entry.decisionId) }));
  const sells = operations.flatMap((o) => o.op.sells.map((fill) => ({ fill, reason: exitOpts.exitReasonByDecision.get(fill.decisionId) ?? 'unknown' })));
  const postRows = postExitAnalysis(sells, market, fees);
  return {
    postExit: { rows: postRows, aggregate: aggregatePostExit(postRows) },
    exitRules: compareExitRules(closed, market, alternativeRules(exitOpts.exits), { fees, latencyMs: exitOpts.latencyMs, horizonMs: exitOpts.horizonMs }),
    stops: analyzeStops(closed, market, fees),
    alive: aliveTable(operations, market),
    byAge: bucketize(withFeatures, 'ageSec', AGE_BUCKETS_SEC),
    byVolume: bucketize(withFeatures, 'volume60sSol', VOLUME_BUCKETS_SOL),
    bootstrap: bootstrapExpectancy(closed.map((c) => c.metrics.net)),
    slippage: slippageBySide(fills),
  };
}
