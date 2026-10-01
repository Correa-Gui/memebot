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
  out.push('== Tokens rejeitados por filtro (mints distintos) ==');
  out.push(r.rejectedTokensByReason.length > 0 ? table(['motivo', 'tokens'], r.rejectedTokensByReason.map((e) => [e.reason, String(e.tokens)]), ['l', 'r']) : '(nenhum)');
  out.push('');
  out.push(`== Custo médio por operação fechada (tamanho médio da entrada = ${sol(r.avgEntrySizeLamports)} SOL) ==`);
  out.push(table(['categoria', 'SOL', '% do tamanho'], r.costs.map((c) => [c.category, sol(c.avgLamports), pct(c.pctOfSize)]), ['l', 'r', 'r']));
  out.push(`fills com custo de fallback (cost_estimate_source ≠ tx_costs_median): ${String(r.fallbackFills)} de ${String(r.totalFills)}`);
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
