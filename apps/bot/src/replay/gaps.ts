/**
 * Lacunas de gravação no replay (Fase 4). Puro.
 *
 * Fonte das lacunas: (1) segundos consecutivos SEM nenhum trade de curva gravado (o mercado tem ~30–60
 * trades de curva por segundo; 4+ segundos vazios seguidos só acontecem com o stream parado/reiniciando) e
 * (2) `ingest_gaps` do tipo `reconnect` (intervalo [detecção − duração, detecção]). As duas são unidas.
 *
 * Tokens afetados: se uma lacuna cai em [criação, criação + maxAgeSec] (a janela em que o token pode ser
 * avaliado), as features dele (holders, volume, compradores) seriam calculadas sobre trades faltando →
 * o token NÃO é elegível para entrada no replay de hipóteses (vira só esqueleto, para o filtro de criador).
 * Operações abertas durante uma lacuna (entrada → saída) não são excluídas: são marcadas no resumo.
 */
export interface Interval {
  fromMs: number;
  toMs: number;
}

/** Une intervalos sobrepostos/encostados; devolve ordenado. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].filter((i) => i.toMs >= i.fromMs).sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, i.toMs);
    else out.push({ ...i });
  }
  return out;
}

/**
 * Lacunas a partir dos segundos (unix, em s) que tiveram pelo menos um trade de curva, dentro de
 * [fromMs, toMs). Lacuna = `minMissingSec` ou mais segundos seguidos sem trade; o intervalo vai do último
 * segundo com dado até o próximo (exclusivos). Também cobre o começo/fim da janela sem dado.
 */
export function silenceGaps(secondsWithData: readonly number[], fromMs: number, toMs: number, minMissingSec = 4): Interval[] {
  const secs = [...secondsWithData].sort((a, b) => a - b);
  const out: Interval[] = [];
  let prev = Math.floor(fromMs / 1000) - 1;
  const last = Math.ceil(toMs / 1000);
  for (const s of [...secs, last]) {
    if (s - prev - 1 >= minMissingSec) out.push({ fromMs: (prev + 1) * 1000, toMs: s * 1000 });
    if (s > prev) prev = s;
  }
  return out;
}

/** `ingest_gaps` (reconnect) → intervalo sem stream. */
export function reconnectIntervals(rows: readonly { detectedAtMs: number; durationMs: number }[]): Interval[] {
  return rows.filter((r) => r.durationMs > 0).map((r) => ({ fromMs: r.detectedAtMs - r.durationMs, toMs: r.detectedAtMs }));
}

/** Uma lacuna intersecta [fromMs, toMs]? (`gaps` ordenado e unido.) */
export function overlapsAny(gaps: readonly Interval[], fromMs: number, toMs: number): boolean {
  for (const g of gaps) {
    if (g.fromMs > toMs) return false;
    if (g.toMs >= fromMs) return true;
  }
  return false;
}

/** Token criado em `createdAtMs` é afetado se uma lacuna cai na janela em que pode ser avaliado. */
export function tokenAffectedByGap(gaps: readonly Interval[], createdAtMs: number, maxAgeSec: number): boolean {
  return overlapsAny(gaps, createdAtMs, createdAtMs + maxAgeSec * 1000);
}
