import type { ReportResult } from './compute.ts';

const sol = (v: bigint): string => (Number(v) / 1e9).toFixed(6);
const pct = (r: number): string => (Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : 'n/d');

/** Tabela com colunas alinhadas (texto puro). `align`: 'l' | 'r' por coluna. */
export function table(header: readonly string[], rows: readonly (readonly string[])[], align: readonly ('l' | 'r')[] = []): string {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => (r[c] ?? '').length)));
  const fmt = (r: readonly string[]): string =>
    r.map((cell, c) => ((align[c] ?? 'l') === 'r' ? cell.padStart(widths[c] ?? 0) : cell.padEnd(widths[c] ?? 0))).join('  ').trimEnd();
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
}

export function formatReportText(r: ReportResult): string {
  const out: string[] = [];
  out.push(`Relatório do run ${r.runId} (modo ${r.mode}${r.startedAtMs !== null ? `, início ${new Date(r.startedAtMs).toISOString()}` : ''})`);
  out.push(`capital alocado (maxOpenPositions × tamanho) = ${sol(r.capitalLamports)} SOL`);
  const q = r.quality;
  out.push(
    `qualidade medida do stream: ${q.quality} — sem stream ${(q.streamGapMs / 1000).toFixed(1)} s de ${(q.uptimeMs / 1000).toFixed(0)} s (${pct(q.ratio)}; limite 1%)` +
      (q.source === 'run_health' ? ' [v_run_quality]' : ` [estimado de ingest_gaps: duração = "desconectado por N ms" + 30 s de heartbeat em ${String(q.estimatedGaps)} lacuna(s) sem duration_ms]`),
  );
  out.push('');
  out.push('== Operações ==');
  out.push(table(['item', 'valor'], [
    ['operações (abertas + fechadas)', String(r.operations.total)],
    ['fechadas', String(r.operations.closed)],
    ['abertas (fora do PnL)', String(r.operations.open)],
    ['entradas não executadas (failed/expired)', String(r.operations.failedEntries)],
    ['taxa de acerto (PnL líquido > 0)', pct(r.hitRate)],
    ['PnL bruto (SOL, fechadas)', sol(r.grossLamports)],
    ['PnL líquido (SOL, fechadas)', sol(r.netClosedLamports)],
    ['custo das entradas não executadas (SOL)', sol(r.failedEntriesCostLamports)],
    ['PnL líquido do run (SOL)', sol(r.netLamports)],
    ['drawdown máximo', `${sol(r.maxDrawdownLamports)} SOL (${pct(r.maxDrawdownPct)} do capital)`],
  ], ['l', 'r']));
  if (r.operations.orphanSells > 0) out.push(`ATENÇÃO: ${String(r.operations.orphanSells)} fill(s) de venda sem compra correspondente no run.`);
  out.push('');
  out.push('== Critério de sucesso (docs/STRATEGY.md §7) ==');
  out.push(table(['', 'critério', 'valor'], r.criteria.map((c) => [c.ok ? '✓' : '✗', c.label, c.value]), ['l', 'l', 'r']));
  out.push('');
  out.push('== Distribuição de retornos (PnL líquido / custo de entrada, operações fechadas) ==');
  out.push(table(['p5', 'p25', 'mediana', 'p75', 'p95', 'média'], [[r.returns.p05, r.returns.p25, r.returns.p50, r.returns.p75, r.returns.p95, r.returns.mean].map(pct)], ['r', 'r', 'r', 'r', 'r', 'r']));
  const maxCount = Math.max(1, ...r.histogram.map((h) => h.count));
  out.push(table(['faixa', 'n', ''], r.histogram.map((h) => [h.label, String(h.count), '#'.repeat(Math.round((h.count / maxCount) * 40))]), ['l', 'r', 'l']));
  out.push('');
  out.push('== Motivo de saída (operações fechadas) ==');
  out.push(r.exitReasons.length > 0 ? table(['motivo', 'n'], r.exitReasons.map((e) => [e.reason, String(e.count)]), ['l', 'r']) : '(nenhuma)');
  out.push('');
  out.push('== 2.1 Stops ==');
  out.push(table(['métrica', 'valor'], [
    ['stops acionados', String(r.stopLosses.count)],
    ['perda média nos stops', r.stopLosses.losingCount > 0 ? `${sol(r.stopLosses.averageLossLamports)} SOL (${pct(r.stopLosses.averageLossPct)})` : 'n/d'],
    [`nº de stops com perda > 1,5× stop configurado (${pct(r.stopLosses.configuredStopPct)}; limite ${pct(r.stopLosses.configuredStopPct * 1.5)})`, String(r.stopLosses.overOneAndHalfConfiguredStop)],
  ], ['l', 'r']));
  out.push('');
  out.push('== Tokens rejeitados por filtro (mints distintos) ==');
  out.push(r.rejectedTokensByReason.length > 0 ? table(['motivo', 'tokens'], r.rejectedTokensByReason.map((e) => [e.reason, String(e.tokens)]), ['l', 'r']) : '(nenhum)');
  out.push('');
  out.push(`== Custo médio por operação fechada (tamanho médio da entrada = ${sol(r.avgEntrySizeLamports)} SOL) ==`);
  out.push(table(['categoria', 'SOL', '% do tamanho'], r.costs.map((c) => [c.category, sol(c.avgLamports), pct(c.pctOfSize)]), ['l', 'r', 'r']));
  out.push(`fills com custo de fallback (cost_estimate_source ≠ tx_costs_median): ${String(r.fallbackFills)} de ${String(r.totalFills)}`);
  const srcs = ['tx_costs_median', 'tx_costs_p75', 'fallback'];
  const extra = (m: Record<string, number>): string[] => Object.keys(m).filter((k) => !srcs.includes(k));
  const cols = [...srcs, ...new Set([...extra(r.costSources.priority), ...extra(r.costSources.tip)])];
  out.push('origem dos custos nos fills (por tipo; fills anteriores à 007 usam a coluna legada):');
  out.push(table(['tipo', ...cols], [
    ['priority fee', ...cols.map((c) => String(r.costSources.priority[c] ?? 0))],
    ['tip Jito', ...cols.map((c) => String(r.costSources.tip[c] ?? 0))],
  ], ['l', ...cols.map(() => 'r' as const)]));
  const cmp = r.realMedianComparison;
  if (cmp) {
    out.push('');
    out.push(
      `== Como rodou × com a mediana real de tx_costs (× 1,5; priority ${cmp.priorityFeeLamports === null ? 'sem amostras' : `${sol(cmp.priorityFeeLamports)} SOL`}, ` +
        `tip ${cmp.jitoTipLamports === null ? 'sem amostras' : `${sol(cmp.jitoTipLamports)} SOL`}; ${String(cmp.recostedFills)} fill(s) recalculados) ==`,
    );
    const rows: string[][] = [
      ['PnL líquido do run (SOL)', sol(cmp.asRun.netLamports), sol(cmp.realMedian.netLamports)],
      ['expectativa por operação (SOL)', sol(cmp.asRun.expectancyLamports), sol(cmp.realMedian.expectancyLamports)],
      ...cmp.asRun.costs.map((c, i) => [`custo médio: ${c.category}`, `${sol(c.avgLamports)} (${pct(c.pctOfSize)})`, `${sol(cmp.realMedian.costs[i]?.avgLamports ?? 0n)} (${pct(cmp.realMedian.costs[i]?.pctOfSize ?? Number.NaN)})`]),
      ...cmp.asRun.criteria.map((c, i) => {
        const alt = cmp.realMedian.criteria[i];
        return [`§7: ${c.label}`, `${c.ok ? '✓' : '✗'} ${c.value}`, alt ? `${alt.ok ? '✓' : '✗'} ${alt.value}` : ''];
      }),
    ];
    out.push(table(['', 'como rodou', 'com mediana real'], rows, ['l', 'r', 'r']));
    out.push('Só os custos com origem ≠ mediana foram trocados (priority em todo fill; tip só em fill executado). Não muda');
    out.push('quando as saídas dispararam (os gatilhos usaram a estimativa da época).');
  }
  out.push('');
  out.push('== Sensibilidade ao tamanho (mesmas operações fechadas) ==');
  out.push(table(['tamanho (SOL)', 'operações', 'ignoradas', 'PnL líquido (SOL)', 'expectativa/op (SOL)', ''], r.sensitivity.map((s) => [
    sol(s.sizeLamports), String(s.operations), String(s.skipped), sol(s.netLamports), sol(s.expectancyLamports), s.hypothetical ? 'HIPOTÉTICO (> hard limit)' : '',
  ]), ['r', 'r', 'r', 'r', 'r', 'l']));
  out.push([
    'Limitações da sensibilidade: compra = bondingCurveBuy(reservas antes do fill de entrada, tamanho); cada venda vende a',
    'mesma fração da quantidade inicial que a venda real (a última vende o resto), sobre as reservas antes daquele fill;',
    'taxas da curva e impacto recalculados; priority, tip, taxa base e rent líquido iguais aos reais. NÃO modela o efeito',
    'do nosso tamanho maior nos trades de terceiros, nem muda quando os gatilhos de saída disparariam (stop/TP dependem do',
    'PnL, que muda com o tamanho). Tamanhos acima do hard limit de posição são hipotéticos: só análise, nunca operáveis.',
    'Operações sem reservas gravadas (virtual_*_before = 0) ficam de fora ("ignoradas").',
  ].join('\n'));
  out.push('');
  const g = r.gapOperations;
  out.push(`== Operações abertas durante lacunas do stream (${String(g.gaps)} lacuna(s) reconnect) ==`);
  if (g.operations.length === 0) out.push('(nenhuma)');
  else {
    out.push(table(['mint', 'entrada', 'saída', 'PnL líquido (SOL)'], g.operations.map((o) => [
      o.mint, new Date(o.entryTs).toISOString(), o.closeTs === null ? '(aberta)' : new Date(o.closeTs).toISOString(), o.netLamports === null ? '-' : sol(o.netLamports),
    ]), ['l', 'l', 'l', 'r']));
  }
  out.push(`PnL líquido do run: com elas ${sol(g.netWithLamports)} SOL; sem elas ${sol(g.netWithoutLamports)} SOL (${String(g.operations.length)} marcada(s))`);
  if (r.openOperations.length > 0) {
    out.push('');
    out.push('== Operações abertas (não entram no PnL) ==');
    out.push(table(['mint', 'entrada', 'decision_id'], r.openOperations.map((o) => [o.mint, new Date(o.entryTs).toISOString(), o.entryDecisionId])));
  }
  out.push('');
  out.push('Definições: bruto = SOL que entrou/saiu da curva sem taxas da curva nem custos de tx; líquido = fluxo de caixa');
  out.push('dos fills (taxas da curva, priority, tip, taxa base e rent líquido descontados). Drawdown = maior queda pico→vale');
  out.push('do PnL realizado acumulado (fechamentos + custos de entradas não executadas), pico inicial 0.');
  return out.join('\n');
}

/** JSON com bigint como string. */
export function formatReportJson(r: ReportResult): string {
  return JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
