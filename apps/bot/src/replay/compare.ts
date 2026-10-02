import type { Lamports } from '@memebot/core';
import { buildOperations, operationMetrics } from '../report/compute.ts';
import type { ReportDecision, ReportFill } from '../report/compute.ts';

/**
 * Replay × paper real do mesmo período (ROADMAP Fase 4: "comparar backtest × paper"). Puro.
 * Entrada em comum = mesmo mint com |Δt| ≤ `toleranceMs` entre as decisões `enter` (pareamento guloso pelo
 * menor |Δt|). Para cada entrada sem par, o "porquê" vem da ÚLTIMA decisão do outro lado para o mesmo mint
 * até o instante da entrada (+ tolerância): rejeição (motivo), entrada em outro horário ou nenhum registro.
 */
export interface SideData {
  decisions: readonly ReportDecision[];
  fills: readonly ReportFill[];
}

export interface EntryMatch {
  mint: string;
  paperTs: number;
  replayTs: number;
  paperNetLamports: Lamports | null;
  replayNetLamports: Lamports | null;
  paperExit: string | null;
  replayExit: string | null;
}

export interface UnmatchedEntry {
  mint: string;
  ts: number;
  netLamports: Lamports | null;
  /** O que o OUTRO lado fez com o mint (ex.: `reject:maxOpenPositions`, `enter em +42 s`, `sem registro`). */
  otherSide: string;
}

export interface Comparison {
  toleranceMs: number;
  paperEnters: number;
  replayEnters: number;
  matched: EntryMatch[];
  onlyPaper: UnmatchedEntry[];
  onlyReplay: UnmatchedEntry[];
  /** Contagem por explicação (`otherSide` agrupado pelo prefixo). */
  onlyPaperWhy: { why: string; count: number }[];
  onlyReplayWhy: { why: string; count: number }[];
}

function netByEntryDecision(side: SideData): Map<string, { net: Lamports | null; exit: string | null }> {
  const exitReason = new Map(side.decisions.filter((d) => d.type === 'exit').map((d) => [d.decisionId, d.reason]));
  const { operations } = buildOperations(side.fills, exitReason);
  return new Map(operations.map((o) => [o.entry.decisionId, { net: o.closed ? operationMetrics(o).net : null, exit: o.exitReason }]));
}

function explain(other: SideData, mint: string, ts: number, toleranceMs: number): string {
  const ds = other.decisions.filter((d) => d.mint === mint);
  const enters = ds.filter((d) => d.type === 'enter');
  const nearestEnter = enters.reduce<ReportDecision | null>((best, d) => (best === null || Math.abs(d.ts - ts) < Math.abs(best.ts - ts) ? d : best), null);
  const before = ds.filter((d) => d.ts <= ts + toleranceMs && d.type !== 'exit').at(-1);
  if (before?.type === 'reject') return `reject:${before.reason}`;
  if (nearestEnter) {
    const dt = Math.round((nearestEnter.ts - ts) / 1000);
    return `enter em outro horário (${dt >= 0 ? '+' : ''}${String(dt)} s)`;
  }
  if (ds.length === 0) return 'sem registro (nunca avaliado)';
  return `outro: ${ds.at(-1)?.type ?? '?'}:${ds.at(-1)?.reason ?? '?'}`;
}

function group(items: readonly UnmatchedEntry[]): { why: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of items) {
    const key = it.otherSide.startsWith('enter em outro horário') ? 'enter em outro horário (> tolerância)' : it.otherSide;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m].map(([why, count]) => ({ why, count })).sort((a, b) => b.count - a.count || a.why.localeCompare(b.why));
}

export function compareEntries(paper: SideData, replay: SideData, toleranceMs = 10_000): Comparison {
  const pEnters = paper.decisions.filter((d) => d.type === 'enter');
  const rEnters = replay.decisions.filter((d) => d.type === 'enter');
  const pNet = netByEntryDecision(paper);
  const rNet = netByEntryDecision(replay);
  // pares candidatos ordenados por |Δt| (guloso, determinístico)
  const pairs: { p: number; r: number; dt: number }[] = [];
  pEnters.forEach((p, i) => {
    rEnters.forEach((r, j) => {
      if (r.mint === p.mint && Math.abs(r.ts - p.ts) <= toleranceMs) pairs.push({ p: i, r: j, dt: Math.abs(r.ts - p.ts) });
    });
  });
  pairs.sort((a, b) => a.dt - b.dt || a.p - b.p || a.r - b.r);
  const usedP = new Set<number>();
  const usedR = new Set<number>();
  const matched: EntryMatch[] = [];
  for (const { p, r } of pairs) {
    if (usedP.has(p) || usedR.has(r)) continue;
    usedP.add(p);
    usedR.add(r);
    const pd = pEnters[p];
    const rd = rEnters[r];
    if (!pd || !rd) continue;
    const pn = pNet.get(pd.decisionId);
    const rn = rNet.get(rd.decisionId);
    matched.push({ mint: pd.mint, paperTs: pd.ts, replayTs: rd.ts, paperNetLamports: pn?.net ?? null, replayNetLamports: rn?.net ?? null, paperExit: pn?.exit ?? null, replayExit: rn?.exit ?? null });
  }
  matched.sort((a, b) => a.paperTs - b.paperTs);
  const onlyPaper = pEnters.flatMap((d, i) => (usedP.has(i) ? [] : [{ mint: d.mint, ts: d.ts, netLamports: pNet.get(d.decisionId)?.net ?? null, otherSide: explain(replay, d.mint, d.ts, toleranceMs) }]));
  const onlyReplay = rEnters.flatMap((d, j) => (usedR.has(j) ? [] : [{ mint: d.mint, ts: d.ts, netLamports: rNet.get(d.decisionId)?.net ?? null, otherSide: explain(paper, d.mint, d.ts, toleranceMs) }]));
  return {
    toleranceMs, paperEnters: pEnters.length, replayEnters: rEnters.length, matched, onlyPaper, onlyReplay,
    onlyPaperWhy: group(onlyPaper), onlyReplayWhy: group(onlyReplay),
  };
}
