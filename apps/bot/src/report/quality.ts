/**
 * Lacunas do stream e qualidade medida do run (puro). Fonte: `ingest_gaps` (kind `reconnect`) e
 * `v_run_quality` (migração 007).
 *
 * Intervalo de uma lacuna `reconnect` = `[detected_at − duration_ms, detected_at]`. Linhas anteriores
 * à 007 têm `duration_ms = 0`: FALLBACK documentado = o número de ms de "desconectado por N ms" do
 * `detail` + 30 000 ms (heartbeat: o silêncio de até 30 s antes de a queda ser detectada). Sem número
 * no detail: só os 30 000 ms.
 */

export const HEARTBEAT_SILENCE_MS = 30_000;
/** Mesmo limite de `v_run_quality`: provisional quando o tempo sem stream passa de 1% do run. */
export const MAX_GAP_RATIO = 0.01;

export interface ReportGap {
  detectedAtMs: number;
  durationMs: number;
  detail: string;
}

export interface Interval {
  fromMs: number;
  toMs: number;
}

export function gapInterval(g: ReportGap): Interval & { estimated: boolean } {
  if (g.durationMs > 0) return { fromMs: g.detectedAtMs - g.durationMs, toMs: g.detectedAtMs, estimated: false };
  const m = /desconectado por (\d+)\s*ms/.exec(g.detail);
  const disconnected = m?.[1] !== undefined ? Number(m[1]) : 0;
  return { fromMs: g.detectedAtMs - disconnected - HEARTBEAT_SILENCE_MS, toMs: g.detectedAtMs, estimated: true };
}

/** Une intervalos sobrepostos (ordenados). */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.fromMs - b.fromMs);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, i.toMs);
    else out.push({ ...i });
  }
  return out;
}

/** Soma (ms) da parte dos intervalos dentro de [fromMs, toMs]. */
export function coveredMs(list: readonly Interval[], fromMs: number, toMs: number): number {
  let total = 0;
  for (const i of mergeIntervals(list)) {
    const a = Math.max(i.fromMs, fromMs);
    const b = Math.min(i.toMs, toMs);
    if (b > a) total += b - a;
  }
  return total;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.fromMs <= b.toMs && b.fromMs <= a.toMs;
}

export interface RunQuality {
  source: 'run_health' | 'ingest_gaps_fallback';
  uptimeMs: number;
  streamGapMs: number;
  ratio: number;
  quality: 'provisional' | 'production';
  /** Quantas lacunas usaram a duração estimada (linhas sem duration_ms). */
  estimatedGaps: number;
}

/**
 * Qualidade medida: a linha de `v_run_quality` se o run tem `run_health`; senão calcula com o
 * fallback acima sobre [startedAt, fim do run = último ts de decisions/fills].
 */
export function runQuality(
  fromView: { uptimeMs: number; streamGapMs: number } | null,
  gaps: readonly ReportGap[],
  startMs: number,
  endMs: number,
): RunQuality {
  const intervals = gaps.map(gapInterval);
  const estimatedGaps = intervals.filter((i) => i.estimated).length;
  const uptimeMs = fromView ? fromView.uptimeMs : Math.max(0, endMs - startMs);
  const streamGapMs = fromView ? fromView.streamGapMs : coveredMs(intervals, startMs, endMs);
  const ratio = uptimeMs > 0 ? streamGapMs / uptimeMs : 0;
  return {
    source: fromView ? 'run_health' : 'ingest_gaps_fallback',
    uptimeMs,
    streamGapMs,
    ratio,
    quality: ratio > MAX_GAP_RATIO ? 'provisional' : 'production',
    estimatedGaps,
  };
}
