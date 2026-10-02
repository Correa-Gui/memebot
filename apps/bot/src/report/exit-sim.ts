import type { Lamports } from '@memebot/core';
import { bondingCurveSell } from '@memebot/curve-math';
import type { CurveFeeBps, CurveReserves } from '@memebot/curve-math';
import type { DataCoverage, MintMarketData, MintTradePoint } from './analysis.ts';
import { marginal } from './analysis.ts';
import type { Operation, OperationMetrics, ReportFill } from './compute.ts';
import { maxDrawdown, percentile } from './compute.ts';

/**
 * Pós-saída e simulação de regras de saída alternativas (PURO). Caminho de preço = trades de curva do
 * mint (`v_trades`) depois da entrada; mesmas regras de "sem dados"/"graduou" de analysis.ts.
 */

const MINUTE = 60_000;

function minuteCovered(c: DataCoverage, t: number): boolean {
  return t <= c.endMs && c.minutes.has(Math.floor(t / MINUTE) * MINUTE);
}

/** Primeiro instante em (fromMs, toMs] sem cobertura de dados (ou `null` se tudo coberto). */
export function firstUncovered(c: DataCoverage, fromMs: number, toMs: number): number | null {
  if (fromMs > c.endMs) return fromMs;
  for (let m = Math.floor(fromMs / MINUTE) * MINUTE; m <= toMs; m += MINUTE) {
    const t = Math.max(m, fromMs);
    if (!minuteCovered(c, t)) return t;
  }
  return toMs > c.endMs ? c.endMs : null;
}

function graduationAt(points: readonly MintTradePoint[], completedAt: number | null): number | null {
  let g = completedAt;
  for (const p of points) {
    if (p.venue === 'pumpswap') {
      if (g === null || p.ts < g) g = p.ts;
      break;
    }
  }
  return g;
}

function reservesOf(p: MintTradePoint): CurveReserves | null {
  return p.venue === 'curve' && p.virtualQuote !== null && p.virtualToken !== null ? { virtualQuote: p.virtualQuote, virtualToken: p.virtualToken } : null;
}

/** Reservas do último trade de curva com ts ≤ t (e ts < graduação). */
function reservesAt(points: readonly MintTradePoint[], t: number, gradAt: number | null): { reserves: CurveReserves; ts: number } | null {
  let last: { reserves: CurveReserves; ts: number } | null = null;
  for (const p of points) {
    if (p.ts > t || (gradAt !== null && p.ts >= gradAt)) break;
    const r = reservesOf(p);
    if (r) last = { reserves: r, ts: p.ts };
  }
  return last;
}

// ---------- 1 e 2. depois de cada venda: máx/mín na janela e upside deixado na mesa ----------

export const POST_EXIT_WINDOWS_MIN = [15, 60, 240] as const;

export interface PostExitWindow {
  minutes: number;
  status: 'ok' | 'graduated' | 'no_data';
  /** Máx./mín. preço marginal na janela (até graduar, se graduou), em % do preço marginal na venda. */
  maxRatio: number | null;
  minRatio: number | null;
  /** Segurar a fração vendida até o máximo da janela / até o fim da janela, menos o que a venda real rendeu (lamports). */
  upsideAtMaxLamports: Lamports | null;
  holdToEndLamports: Lamports | null;
}

export interface PostExitRow {
  mint: string;
  sellTs: number;
  reason: string;
  tokensSold: bigint;
  proceedsLamports: Lamports;
  windows: PostExitWindow[];
}

/**
 * Para cada venda `filled`: preço máximo/mínimo nas janelas após a venda e o resultado de ter segurado a
 * MESMA quantidade até o máximo / até o fim da janela, calculado com bondingCurveSell nas reservas
 * daquele trade (as taxas da curva e o impacto do nosso tamanho entram; os custos de tx da saída são
 * iguais aos da venda real, então se cancelam). "no_data": algum minuto da janela sem dados gravados ou
 * a janela passa do fim dos dados. "graduated": o token saiu da curva na janela — máx./mín. só até lá
 * e sem valor no fim da janela.
 */
export function postExitAnalysis(
  sells: readonly { fill: ReportFill; reason: string }[],
  market: MintMarketData,
  fees: CurveFeeBps,
): PostExitRow[] {
  return sells.map(({ fill, reason }) => {
    const pts = market.points.get(fill.mint) ?? [];
    const gradAt = graduationAt(pts, market.completedAt.get(fill.mint) ?? null);
    const tokens = -fill.tokenDelta;
    const exitPrice = marginal(fill.virtualQuoteBefore, fill.virtualTokenBefore);
    const windows = POST_EXIT_WINDOWS_MIN.map((minutes): PostExitWindow => {
      const end = fill.ts + minutes * MINUTE;
      const graduated = gradAt !== null && gradAt <= end;
      const until = gradAt !== null && gradAt <= end ? gradAt : end;
      if (firstUncovered(market.coverage, fill.ts, until) !== null) {
        return { minutes, status: 'no_data', maxRatio: null, minRatio: null, upsideAtMaxLamports: null, holdToEndLamports: null };
      }
      let maxP: number | null = null;
      let minP: number | null = null;
      let maxR: CurveReserves | null = null;
      for (const p of pts) {
        if (p.ts <= fill.ts) continue;
        if (p.ts > until || (gradAt !== null && p.ts >= gradAt)) break;
        const r = reservesOf(p);
        if (!r) continue;
        const price = marginal(r.virtualQuote, r.virtualToken);
        if (maxP === null || price > maxP) {
          maxP = price;
          maxR = r;
        }
        if (minP === null || price < minP) minP = price;
      }
      const proceeds = (r: CurveReserves): Lamports => bondingCurveSell(r, tokens, fees).netQuoteOut - fill.solOut;
      const endRes = graduated ? null : reservesAt(pts, end, gradAt);
      return {
        minutes,
        status: graduated ? 'graduated' : 'ok',
        maxRatio: maxP !== null && exitPrice > 0 ? maxP / exitPrice - 1 : null,
        minRatio: minP !== null && exitPrice > 0 ? minP / exitPrice - 1 : null,
        upsideAtMaxLamports: maxR ? proceeds(maxR) : null,
        holdToEndLamports: endRes ? proceeds(endRes.reserves) : null,
      };
    });
    return { mint: fill.mint, sellTs: fill.ts, reason, tokensSold: tokens, proceedsLamports: fill.solOut, windows };
  });
}

export interface PostExitAggregate {
  minutes: number;
  withData: number;
  graduated: number;
  noData: number;
  medianMaxRatio: number;
  medianMinRatio: number;
  upsideAtMaxLamports: Lamports;
  holdToEndLamports: Lamports;
  /** Vendas com valor no fim da janela (base de holdToEnd). */
  withEndValue: number;
}

export function aggregatePostExit(rows: readonly PostExitRow[]): PostExitAggregate[] {
  return POST_EXIT_WINDOWS_MIN.map((minutes, i) => {
    const ws = rows.flatMap((r) => (r.windows[i] ? [r.windows[i]] : []));
    const sorted = (xs: number[]): number[] => xs.sort((a, b) => a - b);
    return {
      minutes,
      withData: ws.filter((w) => w.status === 'ok').length,
      graduated: ws.filter((w) => w.status === 'graduated').length,
      noData: ws.filter((w) => w.status === 'no_data').length,
      medianMaxRatio: percentile(sorted(ws.flatMap((w) => (w.maxRatio === null ? [] : [w.maxRatio]))), 0.5),
      medianMinRatio: percentile(sorted(ws.flatMap((w) => (w.minRatio === null ? [] : [w.minRatio]))), 0.5),
      upsideAtMaxLamports: ws.reduce((acc, w) => acc + (w.upsideAtMaxLamports ?? 0n), 0n),
      holdToEndLamports: ws.reduce((acc, w) => acc + (w.holdToEndLamports ?? 0n), 0n),
      withEndValue: ws.filter((w) => w.holdToEndLamports !== null).length,
    };
  });
}

// ---------- 3. regras de saída alternativas ----------

export interface ExitRule {
  key: string;
  label: string;
  /** Degraus de TP: ganho líquido → fração da quantidade INICIAL (da parte ativa). */
  takeProfit: readonly { gainPct: number; sellFraction: number }[];
  /** Trailing sobre o valor líquido do restante; null = sem trailing. */
  trailingPct: number | null;
  /** true = trailing ativo desde a entrada; false = só depois do TP1 (regra atual). */
  trailingFromEntry: boolean;
  stopLossPct: number;
  /** Time stop: vende tudo se nenhum TP foi atingido até aqui (como positions). */
  timeStopSec: number;
  /** Fração da posição guardada sem stop/trailing/TP até o fim do horizonte. */
  moonbagFraction: number;
}

export interface SimParams {
  fees: CurveFeeBps;
  latencyMs: number;
  /** Horizonte máximo a partir da entrada (ex.: 4 h); o que sobrar é vendido no fim. */
  horizonMs: number;
}

export interface SimInput {
  mint: string;
  entryTs: number;
  entryTokens: bigint;
  entryCost: Lamports;
  rentPaid: Lamports;
  /** Custos de tx (priority + tip + taxa base) de cada venda simulada = os da venda real. */
  exitTxCost: Lamports;
}

export interface SimResult {
  net: Lamports;
  closeTs: number;
  /** Motivos das vendas simuladas, na ordem. */
  exits: string[];
  /** 'dados' = caminho truncado por falta de dados; 'graduou' = fechada no último preço da curva. */
  endedBy: 'regra' | 'horizonte' | 'dados' | 'graduou';
}

const ppm = (x: number): bigint => BigInt(Math.round(x * 1_000_000));

/**
 * Simula UMA operação com uma regra (mesma base do `netPnlRatio` de positions):
 *   pnl = (realizado + L − custoAlocado) / custoAlocado,  L = netQuoteOut(bondingCurveSell(reservas, restante)) − custos de tx + rent
 * sobre a parte ATIVA (posição − moonbag). Gatilhos avaliados a cada trade de curva (e no prazo do time
 * stop); a venda preenche nas reservas do último trade com ts ≤ gatilho + latência (sem falha sorteada,
 * sem limite de slippage). Graduação: fecha tudo no último preço da curva. Falta de dados: fecha no
 * último preço conhecido e marca. Emergências (criador vendendo, venda > 5%) NÃO são modeladas.
 */
export function simulateExitRule(input: SimInput, pathAll: readonly MintTradePoint[], completedAt: number | null, coverage: DataCoverage, rule: ExitRule, p: SimParams): SimResult {
  const gradAt = graduationAt(pathAll, completedAt);
  const horizonEnd = input.entryTs + p.horizonMs;
  const uncovered = firstUncovered(coverage, input.entryTs, horizonEnd);
  const stopAt = Math.min(horizonEnd, uncovered ?? Number.POSITIVE_INFINITY, gradAt ?? Number.POSITIVE_INFINITY);
  const endedByLimit: SimResult['endedBy'] =
    gradAt !== null && gradAt <= stopAt ? 'graduou' : uncovered !== null && uncovered <= stopAt ? 'dados' : 'horizonte';
  const path = pathAll.filter((q) => q.ts > input.entryTs && q.ts < stopAt && reservesOf(q) !== null);

  const activeInitial = (input.entryTokens * (1_000_000n - ppm(rule.moonbagFraction))) / 1_000_000n;
  const bag = input.entryTokens - activeInitial;
  const activeCost = (input.entryCost * activeInitial) / (input.entryTokens > 0n ? input.entryTokens : 1n);
  const activeRent = (input.rentPaid * activeInitial) / (input.entryTokens > 0n ? input.entryTokens : 1n);
  let held = activeInitial;
  let realized = 0n; // da parte ativa, líquido de custos de tx
  let tpDone = 0;
  let peak: Lamports | null = null;
  interface Pending { tokens: bigint; dueTs: number; reason: string; tp: number | null }
  // caixa mutável: as funções internas alteram a ordem pendente (evita o estreitamento do TS para `null`)
  const box: { pending: Pending | null } = { pending: null };
  const exits: string[] = [];
  let closeTs = input.entryTs;
  let cursor = 0; // índice no path: último trade aplicado = path[cursor-1]
  let current: CurveReserves | null = null;
  const entryRes = reservesAt(pathAll, input.entryTs, gradAt);
  current = entryRes?.reserves ?? null;

  const sellAt = (r: CurveReserves | null, tokens: bigint): Lamports =>
    r && tokens > 0n ? bondingCurveSell(r, tokens, p.fees).netQuoteOut - input.exitTxCost : -input.exitTxCost;
  const liquidation = (r: CurveReserves): Lamports => sellAt(r, held) + activeRent;

  const fillPending = (): void => {
    if (!box.pending) return;
    const tokens = box.pending.tokens > held ? held : box.pending.tokens;
    realized += sellAt(current, tokens);
    held -= tokens;
    exits.push(box.pending.reason);
    closeTs = box.pending.dueTs;
    if (box.pending.tp !== null) tpDone = box.pending.tp;
    peak = null;
    box.pending = null;
  };

  const evaluate = (t: number): void => {
    if (box.pending || held <= 0n || !current || activeCost <= 0n) return;
    const L = liquidation(current);
    const pnl = Number(realized + L - activeCost) / Number(activeCost);
    const trailingActive = rule.trailingPct !== null && (rule.trailingFromEntry || tpDone >= 1);
    if (trailingActive && (peak === null || L > peak)) peak = L;
    const sellAll = (reason: string): void => {
      box.pending = { tokens: held, dueTs: t + p.latencyMs, reason, tp: null };
    };
    if (pnl <= -rule.stopLossPct) { sellAll('stop_loss'); return; }
    if (trailingActive && rule.trailingPct !== null && peak !== null && peak > 0n && L * 10_000n <= peak * (10_000n - BigInt(Math.round(rule.trailingPct * 10_000)))) {
      sellAll('trailing_stop'); return;
    }
    if (tpDone === 0 && t - input.entryTs >= rule.timeStopSec * 1000) { sellAll('time_stop'); return; }
    let reached = tpDone;
    while (reached < rule.takeProfit.length && (rule.takeProfit[reached]?.gainPct ?? Number.POSITIVE_INFINITY) <= pnl) reached++;
    if (reached > tpDone) {
      let frac = 0;
      for (let i = tpDone; i < reached; i++) frac += rule.takeProfit[i]?.sellFraction ?? 0;
      const tokens = (activeInitial * ppm(Math.min(frac, 1))) / 1_000_000n;
      const all = tokens >= held || held - tokens <= activeInitial / 1_000_000n;
      box.pending = { tokens: all ? held : tokens, dueTs: t + p.latencyMs, reason: `take_profit_${String(reached)}`, tp: reached };
    }
  };

  const timeStopAt = input.entryTs + rule.timeStopSec * 1000;
  let timeStopChecked = false;
  // laço de eventos: trades do caminho + prazo do time stop + vencimento da venda pendente
  for (;;) {
    if (held <= 0n && !box.pending) break;
    const nextTrade = path[cursor];
    const candidates: number[] = [];
    if (nextTrade) candidates.push(nextTrade.ts);
    if (box.pending) candidates.push(box.pending.dueTs);
    if (!timeStopChecked && tpDone === 0) candidates.push(timeStopAt);
    const t = Math.min(...candidates);
    if (candidates.length === 0 || t >= stopAt) break;
    // venda pendente vence antes do próximo trade: preenche no estado atual (todos os trades ≤ vencimento aplicados)
    if (box.pending && box.pending.dueTs <= t && (!nextTrade || nextTrade.ts > box.pending.dueTs)) {
      fillPending();
      continue;
    }
    if (nextTrade && nextTrade.ts === t) {
      current = reservesOf(nextTrade) ?? current;
      cursor++;
      if (box.pending && box.pending.dueTs < t) fillPending();
      evaluate(t);
      continue;
    }
    if (t === timeStopAt) {
      timeStopChecked = true;
      evaluate(t);
      continue;
    }
    break;
  }
  // fim: venda pendente, restante ativo e moonbag no último preço conhecido antes do limite
  if (box.pending) fillPending();
  let endedBy: SimResult['endedBy'] = 'regra';
  const remaining = held + bag;
  if (remaining > 0n) {
    endedBy = endedByLimit;
    const last = reservesAt(pathAll, stopAt - 1, gradAt)?.reserves ?? current;
    realized += sellAt(last, remaining);
    held = 0n;
    exits.push(endedBy === 'graduou' ? 'graduated' : 'horizon_end');
    closeTs = Math.min(stopAt, horizonEnd);
  }
  const bagRent = input.rentPaid - activeRent;
  return { net: realized + activeRent + bagRent - input.entryCost, closeTs, exits, endedBy };
}

export interface RuleSummary {
  key: string;
  label: string;
  operations: number;
  netLamports: Lamports;
  expectancyLamports: Lamports;
  hitRate: number;
  maxDrawdownLamports: Lamports;
  endedBy: Record<SimResult['endedBy'], number>;
}

export function summarizeRule(key: string, label: string, results: readonly SimResult[]): RuleSummary {
  const net = results.reduce((a, r) => a + r.net, 0n);
  const endedBy: Record<SimResult['endedBy'], number> = { regra: 0, horizonte: 0, dados: 0, graduou: 0 };
  for (const r of results) endedBy[r.endedBy]++;
  return {
    key,
    label,
    operations: results.length,
    netLamports: net,
    expectancyLamports: results.length > 0 ? net / BigInt(results.length) : 0n,
    hitRate: results.length > 0 ? results.filter((r) => r.net > 0n).length / results.length : Number.NaN,
    maxDrawdownLamports: maxDrawdown(results.map((r) => ({ ts: r.closeTs, delta: r.net }))),
    endedBy,
  };
}

/** Regras comparadas (a partir da config real). Ver a definição de (c), (d), (e) no report. */
export function alternativeRules(base: { takeProfit: readonly { gainPct: number; sellFraction: number }[]; trailingStopPct: number; stopLossPct: number; timeStopSec: number }): ExitRule[] {
  const common = { stopLossPct: base.stopLossPct, timeStopSec: base.timeStopSec, moonbagFraction: 0 };
  const current: ExitRule = { key: 'd', label: '(d) regra atual simulada: TP escalonado + trailing 25% após TP1', takeProfit: base.takeProfit, trailingPct: base.trailingStopPct, trailingFromEntry: false, ...common };
  return [
    { key: 'a', label: '(a) vende tudo em +40%', takeProfit: [{ gainPct: 0.4, sellFraction: 1 }], trailingPct: null, trailingFromEntry: false, ...common },
    { key: 'b', label: '(b) vende tudo em +100%', takeProfit: [{ gainPct: 1, sellFraction: 1 }], trailingPct: null, trailingFromEntry: false, ...common },
    { key: 'c', label: '(c) só trailing 25% desde a entrada, sem alvos', takeProfit: [], trailingPct: 0.25, trailingFromEntry: true, ...common },
    current,
    { ...current, key: 'e', label: '(e) regra atual com trailing 40%', trailingPct: 0.4 },
    ...[0.2, 0.4, 0.6].map((m) => ({ ...current, key: `f${String(m * 100)}`, label: `(f) regra atual + moonbag ${String(m * 100)}% até o horizonte`, moonbagFraction: m })),
  ];
}

export interface ExitRulesComparison {
  real: RuleSummary;
  rules: RuleSummary[];
  horizonMs: number;
  latencyMs: number;
}

export function compareExitRules(
  ops: readonly { op: Operation; metrics: OperationMetrics }[],
  market: MintMarketData,
  rules: readonly ExitRule[],
  p: SimParams,
): ExitRulesComparison {
  const inputs = ops.map(({ op, metrics }) => {
    const firstSell = op.sells[0];
    return {
      sim: {
        mint: op.mint,
        entryTs: op.entry.ts,
        entryTokens: op.entry.tokenDelta,
        entryCost: metrics.entryCost,
        rentPaid: op.entry.rent,
        exitTxCost: firstSell ? firstSell.priorityFee + firstSell.jitoTip + firstSell.baseFee : op.entry.priorityFee + op.entry.baseFee,
      },
      real: { net: metrics.net, closeTs: op.closeTs ?? op.entry.ts, exits: [op.exitReason ?? 'unknown'], endedBy: 'regra' as const },
    };
  });
  return {
    real: summarizeRule('real', 'regra real (como rodou)', inputs.map((i) => i.real)),
    rules: rules.map((rule) =>
      summarizeRule(rule.key, rule.label, inputs.map((i) => simulateExitRule(i.sim, market.points.get(i.sim.mint) ?? [], market.completedAt.get(i.sim.mint) ?? null, market.coverage, rule, p))),
    ),
    horizonMs: p.horizonMs,
    latencyMs: p.latencyMs,
  };
}
