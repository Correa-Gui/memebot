import type { Analysis, AliveStatus } from './analysis.ts';
import { ALIVE_MIN_PRICE_RATIO, ALIVE_WINDOW_MIN } from './analysis.ts';
import type { ReportResult } from './compute.ts';

const sol = (v: bigint): string => (Number(v) / 1e9).toFixed(6);
const pct = (r: number): string => (Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : 'n/d');

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** "01/10 20:14:05 BRT (23:14:05 UTC)" — Brasília = UTC−3 fixo (sem horário de verão desde 2019). */
export function brt(ms: number): string {
  const b = new Date(ms - 3 * 3_600_000);
  const u = new Date(ms);
  return `${pad2(b.getUTCDate())}/${pad2(b.getUTCMonth() + 1)} ${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}:${pad2(b.getUTCSeconds())} BRT ` +
    `(${pad2(u.getUTCHours())}:${pad2(u.getUTCMinutes())}:${pad2(u.getUTCSeconds())} UTC)`;
}

const dur = (ms: number): string => (Number.isFinite(ms) ? `${String(Math.floor(ms / 60_000))}m${pad2(Math.round((ms % 60_000) / 1000))}s` : 'n/d');

/** Seções de "por que a estratégia perde". */
export function formatAnalysis(a: Analysis): string {
  const out: string[] = [];
  const pe = a.postExit;
  out.push('== Análise: depois de cada venda (todas as saídas) ==');
  out.push(table(['janela', 'com dados', 'graduou', 'sem dados', 'máx. mediano vs venda', 'mín. mediano vs venda', 'upside no máx. (SOL)', 'segurar até o fim (SOL)'], pe.aggregate.map((g) => [
    `${String(g.minutes)} min`, String(g.withData), String(g.graduated), String(g.noData), pct(g.medianMaxRatio), pct(g.medianMinRatio),
    sol(g.upsideAtMaxLamports), `${sol(g.holdToEndLamports)} (${String(g.withEndValue)} vendas)`,
  ]), ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r']));
  const w = (x: { status: string; maxRatio: number | null; minRatio: number | null; upsideAtMaxLamports: bigint | null; holdToEndLamports: bigint | null } | undefined): string =>
    !x ? '-' : x.status === 'no_data' ? 'sem dados'
      : `${pct(x.maxRatio ?? Number.NaN)}/${pct(x.minRatio ?? Number.NaN)} ↑${x.upsideAtMaxLamports === null ? 'n/d' : sol(x.upsideAtMaxLamports)} fim ${x.holdToEndLamports === null ? 'n/d' : sol(x.holdToEndLamports)}${x.status === 'graduated' ? ' (graduou)' : ''}`;
  out.push(table(['mint', 'venda', 'motivo', 'recebido (SOL)', '15 min máx/mín ↑upside fim', '1 h', '4 h'], pe.rows.map((r) => [
    r.mint, brt(r.sellTs), r.reason, sol(r.proceedsLamports), w(r.windows[0]), w(r.windows[1]), w(r.windows[2]),
  ])));
  out.push('máx/mín = preço marginal máximo/mínimo na janela em % do preço marginal na venda; ↑upside = segurar a MESMA quantidade e vender');
  out.push('no máximo da janela (bondingCurveSell nas reservas daquele trade; custos de tx iguais) menos o que a venda real recebeu; "fim" =');
  out.push('idem vendendo no fim da janela. "graduou": máx/mín só até sair da curva, sem valor no fim. "sem dados": janela não coberta.');
  out.push('');
  const er = a.exitRules;
  out.push(`== Análise: regras de saída alternativas (mesmas entradas; latência ${String(er.latencyMs)} ms; horizonte ${String(er.horizonMs / 3_600_000)} h) ==`);
  out.push(table(['regra', 'ops', 'PnL líquido (SOL)', 'expectativa/op (SOL)', 'acerto', 'drawdown (SOL)', 'fim por regra/horizonte/dados/graduou'], [er.real, ...er.rules].map((x) => [
    x.label, String(x.operations), sol(x.netLamports), sol(x.expectancyLamports), pct(x.hitRate), sol(x.maxDrawdownLamports),
    `${String(x.endedBy.regra)}/${String(x.endedBy.horizonte)}/${String(x.endedBy.dados)}/${String(x.endedBy.graduou)}`,
  ]), ['l', 'r', 'r', 'r', 'r', 'r', 'r']));
  out.push('Definições: (c) trailing 25% sobre o valor líquido do restante desde a ENTRADA, sem alvos; (d) a regra atual (TP +40% vende 50% da');
  out.push('posição inicial, TP +100% mais 30%, trailing 25% só depois do TP1); (e) a (d) com trailing 40%; (f) a (d) sobre (1 − moonbag) da');
  out.push('posição, e o moonbag fica sem stop/trailing/TP até o horizonte (ou fim dos dados/graduação). Todas mantêm o stop −20% e o time stop');
  out.push('de 10 min sem TP1 (em (c), sem alvos, o time stop sempre vale). Ganho/perda líquidos na base do netPnlRatio (bondingCurveSell nas reservas');
  out.push('de cada trade, custos de tx das vendas reais, rent devolvido no fechamento). Limitações: não modela o impacto de terceiros nem as');
  out.push('emergências (criador vendendo, venda > 5% do supply), latência fixa sem falha sorteada nem limite de slippage, graduação para o');
  out.push('PumpSwap encerra no último preço da curva, falta de dados encerra no último preço conhecido. "regra real" = fills reais.');
  out.push('');
  out.push('== Análise: stops (por que perde) ==');
  const st = a.stops;
  out.push(`stops: ${String(st.rows.length)} | tempo mediano entrada→stop: ${dur(st.medianHoldMs)} | MFE líquido mediano antes do stop: ${pct(st.medianMfeNetRatio)}`);
  out.push('MFE líquido = maior PnL líquido (base do netPnlRatio de positions: liquidar o restante com bondingCurveSell nas reservas de cada');
  out.push('trade de curva entre entrada e stop, menos custos de tx da saída real, mais rent) que a posição atingiu; MFE preço = máx. preço marginal / preço marginal na entrada − 1.');
  out.push(table(['horizonte após o stop', 'com dados', 'mediana vs saída', 'acima da saída', 'graduou', 'sem dados'], st.horizons.map((h) => [
    `${String(h.minutes)} min`, String(h.withData), pct(h.medianRatio), h.withData > 0 ? `${String(h.aboveExit)} (${pct(h.aboveExit / h.withData)})` : '-', String(h.graduated), String(h.noData),
  ]), ['l', 'r', 'r', 'r', 'r', 'r']));
  const cell = (c: { ratio: number | null; status: string } | undefined): string =>
    !c ? '-' : c.status === 'ok' ? pct(c.ratio ?? Number.NaN) : c.status === 'graduated' ? 'graduou' : 'sem dados';
  out.push(table(['mint', 'entrada', 'até o stop', 'retorno', 'MFE líq.', 'MFE preço', '+5 min', '+15 min', '+60 min'], st.rows.map((r) => [
    r.mint, brt(r.entryTs), dur(r.holdMs), pct(r.returnRatio), r.mfeNetRatio === null ? 'n/d' : pct(r.mfeNetRatio), r.mfePriceRatio === null ? 'n/d' : pct(r.mfePriceRatio),
    cell(r.after[0]), cell(r.after[1]), cell(r.after[2]),
  ]), ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r']));
  out.push('Preço depois do stop = preço marginal (virtualQuote/virtualToken) do último trade de curva do mint com ts ≤ t, em % do preço marginal na saída.');
  out.push('"sem dados" = t passa do fim dos dados gravados ou houve minuto sem nenhum trade gravado no caminho; "graduou" = trade no PumpSwap/curve_completed até t.');
  out.push('');
  out.push(`== Análise: token vivo 1 h depois da entrada (trade em [+${String(ALIVE_WINDOW_MIN[0])}, +${String(ALIVE_WINDOW_MIN[1])}] min e preço marginal em +60 min ≥ ${String(ALIVE_MIN_PRICE_RATIO * 100)}% do de entrada) ==`);
  const keys: AliveStatus[] = ['vivo', 'morto', 'graduou', 'sem_dados'];
  out.push(table(['resultado da operação', ...keys, 'total', '% vivo (com dados)'], a.alive.rows.map((r) => {
    const known = r.counts.vivo + r.counts.morto + r.counts.graduou;
    return [r.outcome, ...keys.map((k) => String(r.counts[k])), String(r.total), known > 0 ? pct(r.counts.vivo / known) : 'n/d'];
  }), ['l', 'r', 'r', 'r', 'r', 'r', 'r']));
  out.push('');
  const buckets = (title: string, rows: Analysis['byAge']): void => {
    out.push(title);
    out.push(table(['faixa', 'n', 'acerto', 'retorno médio', 'retorno mediano', 'PnL líquido (SOL)'], rows.map((b) => [
      b.label, String(b.n), pct(b.hitRate), pct(b.meanReturn), pct(b.medianReturn), sol(b.netLamports),
    ]), ['l', 'r', 'r', 'r', 'r', 'r']));
  };
  buckets('== Análise: retorno por idade do token na entrada (ageSec do snapshot do enter) ==', a.byAge);
  out.push('');
  buckets('== Análise: retorno por volume 60 s na entrada (volume60sSol do snapshot do enter) ==', a.byVolume);
  out.push('');
  const b = a.bootstrap;
  out.push(`== Análise: expectativa por operação fechada com IC 95% (bootstrap, ${String(b.replicas)} réplicas, seed "${b.seed}") ==`);
  out.push(
    `n = ${String(b.n)} | média ${(b.meanLamports / 1e9).toFixed(6)} SOL | IC 95% [${(b.ci95[0] / 1e9).toFixed(6)}, ${(b.ci95[1] / 1e9).toFixed(6)}] SOL | ` +
      `P(expectativa > 0) = ${pct(b.probPositive)}`,
  );
  out.push('');
  out.push('== Análise: slippage por lado (positivo = pior que o esperado na decisão) ==');
  out.push(table(['lado', 'fills', 'total (SOL)', '% do valor esperado', 'média (bps)'], a.slippage.map((x) => [
    x.side === 'buy' ? 'compra' : 'venda', String(x.fills), sol(x.totalLamports), pct(x.pctOfExpected), Number.isFinite(x.meanBps) ? x.meanBps.toFixed(0) : 'n/d',
  ]), ['l', 'r', 'r', 'r', 'r']));
  out.push('Compra = solIn − preço esperado × tokens; venda = preço esperado × tokens − solOut (preço esperado = simulado nas reservas da');
  out.push('decisão, já líquido das taxas da curva). Venda negativa = vendeu MELHOR que na decisão: o preço repicou durante a latência');
  out.push('(stops disparam em fundo local); compra positiva = entrou pior (o topo local ainda subia). Já está dentro do PnL.');
  return out.join('\n');
}

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
  if (r.discardReason !== null) {
    const line = '!'.repeat(100);
    out.push(line, `!!! RUN DESCARTADO — motivo: ${r.discardReason || '(sem motivo registrado)'}`, '!!! Os números abaixo NÃO valem para o critério da STRATEGY §7.', line, '');
  }
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
  if (r.analysis) {
    out.push('');
    out.push(formatAnalysis(r.analysis));
  }
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
