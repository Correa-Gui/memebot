import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createLogger, loadConfigFromEnvFile } from '@memebot/core';
import type { QueryFn } from './replay/clickhouse.ts';
import { createReplayClient, loadSolUsdCandles, loadVariant, paramsFromConfig, runPeriod, writeReplayRun } from './replay/load.ts';
import type { ReplayVariant } from './replay/run.ts';
import { summarizeVariant, type VariantSummary } from './replay/summary.ts';

/**
 * `pnpm replay:sweep` — hipóteses de entrada OFFLINE (experimento de 2026-10-02, docs/STRATEGY.md §8) com
 * separação POR TEMPO (ROADMAP Fase 4): o bloco contínuo gravado é cortado em AJUSTE (primeiros ~60%) e
 * VALIDAÇÃO (últimos ~40%), sem sobreposição; cada período começa limpo (só a pré-carga de 24 h de
 * `token_created`) e só tokens CRIADOS dentro dele são elegíveis; posições abertas no corte são geridas até
 * fechar com os eventos seguintes (drenagem, sem novas entradas) e contam no período em que abriram.
 * Kill switch DESLIGADO (para não cortar a amostra), tokens com lacuna de gravação excluídos, relógio = ts
 * dos eventos, seed fixa. Todas as variantes rodam na mesma passada de eventos de cada período.
 *
 * Opções: --from/--cut/--to (ISO) · --variants=<arquivo,...> (padrão: config/strategy.v0.yaml + config/variants/*.yaml)
 * · --seed=<n> (padrão 1) · --group=<n> variantes por passada (padrão todas) · --write (grava os runs) · --out=<prefixo>.
 * · --pumpswap: universo GRADUADO (experimento de 2026-10-03) — libera a simulação do PumpSwap, carrega os trades
 *   do PumpSwap dos tokens graduados com `swapDetails` e bloqueia entradas no aquecimento; --sol-usd=<json> (padrão
 *   config/reference/solusdt-1h-2026-09-30_10-03.json) dá o preço SOL/US$ do filtro de market cap.
 */
const DEFAULT_SOL_USD = 'config/reference/solusdt-1h-2026-09-30_10-03.json';

/**
 * Bloco contínuo de 2026-10-01/02 (primeiro e último ts gravados). O ajuste começa no início dos dados, então não há
 * `token_created` anterior para a pré-carga: as primeiras `--warmup-min` (120) min são SÓ de estado (tokens criados
 * nelas nunca são elegíveis) e os DOIS períodos usam a mesma pré-carga de `--creator-preload-h` (2) h — cada um começa
 * com exatamente 2 h de histórico de criadores. Corte = 60% do tempo ELEGÍVEL total (00:16:24 → 11:53:08 UTC = 41.804 s;
 * 60% ⇒ 07:14:26), arredondado para 07:14:00 UTC.
 */
const DEFAULT_FROM = '2026-10-01T22:16:24Z';
const DEFAULT_CUT = '2026-10-02T07:14:00Z';
const DEFAULT_TO = '2026-10-02T11:53:08Z';

const brt = (ms: number): string => `${new Date(ms - 3 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ')} BRT (${new Date(ms).toISOString().slice(11, 16)} UTC)`;
const sol = (v: bigint | number): string => (Number(v) / 1e9).toFixed(4);
const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : 'n/d');

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { from: { type: 'string' }, cut: { type: 'string' }, to: { type: 'string' }, clock: { type: 'string' }, 'warmup-min': { type: 'string' }, 'creator-preload-h': { type: 'string' }, variants: { type: 'string' }, seed: { type: 'string' }, group: { type: 'string' }, write: { type: 'boolean' }, out: { type: 'string' }, pumpswap: { type: 'boolean' }, 'sol-usd': { type: 'string' } },
    strict: true,
  });
  const fromMs = Date.parse(values.from ?? DEFAULT_FROM);
  const cutMs = Date.parse(values.cut ?? DEFAULT_CUT);
  const toMs = Date.parse(values.to ?? DEFAULT_TO);
  if (!(fromMs < cutMs && cutMs < toMs)) throw new Error('--from < --cut < --to');
  const files = values.variants
    ? values.variants.split(',').map((s) => s.trim()).filter(Boolean)
    : ['config/strategy.v0.yaml', ...readdirSync('config/variants').filter((f) => f.endsWith('.yaml') && !f.startsWith('d-') && !f.startsWith('g')).sort().map((f) => `config/variants/${f}`)];
  const clockMode = values.clock === 'event' ? 'event' : 'paper_wall';
  const warmupMs = Number(values['warmup-min'] ?? '120') * 60_000;
  const preloadMs = Number(values['creator-preload-h'] ?? '2') * 3_600_000;
  const variants: ReplayVariant[] = files.map((f) => loadVariant(f));
  const group = Number(values.group ?? String(variants.length));
  const pumpSwap = values.pumpswap === true;
  const solUsdPath = values['sol-usd'] ?? DEFAULT_SOL_USD;
  const solUsd = pumpSwap ? loadSolUsdCandles(solUsdPath) : undefined;

  const cfg = loadConfigFromEnvFile();
  const log = createLogger({ name: 'replay-sweep' });
  const client = createReplayClient(cfg);
  const query: QueryFn = async (q, params) => (await client.query({ query: q, query_params: params, format: 'JSONEachRow' })).json<unknown>();
  const periods = [
    { name: 'ajuste', fromMs, eligibleFromMs: fromMs + warmupMs, toMs: cutMs },
    { name: 'validação', fromMs: cutMs, eligibleFromMs: cutMs, toMs },
  ];
  const results = new Map<string, Map<string, VariantSummary>>();
  const notes: string[] = [];
  try {
    for (const p of periods) {
      const byLabel = new Map<string, VariantSummary>();
      for (let i = 0; i < variants.length; i += group) {
        const chunk = variants.slice(i, i + group);
        const params = paramsFromConfig(cfg, { fromMs: p.fromMs, entriesUntilMs: p.toMs, drainMs: 30 * 60_000, seed: Number(values.seed ?? '1'), killSwitchEnabled: false, excludeGapTokens: true, clockMode, eligibleFromMs: p.eligibleFromMs, creatorPreloadMs: preloadMs, ...(pumpSwap ? { pumpSwapEnabled: true } : {}) });
        const run = await runPeriod(query, chunk, params, log, solUsd);
        const r = run.result;
        notes.push(`${p.name} [${chunk.map((v) => v.label).join(', ')}]: eventos desde ${brt(p.fromMs)}, entradas ${brt(p.eligibleFromMs)} → ${brt(p.toMs)}; relógio ${clockMode}; eventos ${String(r.driver.events)}; tokens só-estado (aquecimento) ${String(r.warmupTokens)}; tokens excluídos por lacuna ${String(r.driver.excludedTokens - r.warmupTokens)}; esqueletos pré-carregados ${String(r.seededSkeletons)} (${String(preloadMs / 3_600_000)} h); lacunas ${String(run.gaps.length)} (${run.gaps.map((g) => `${new Date(g.fromMs).toISOString().slice(11, 19)}–${new Date(g.toMs).toISOString().slice(11, 19)}`).join(', ')}); execução ${String(Math.round(run.runMs / 1000))} s; latência ${String(params.latencyMs)} ms; falha ${String(params.failRate)}; seed ${String(params.seed)}`);
        for (const v of r.variants) {
          const s = summarizeVariant(v, run.gaps);
          byLabel.set(v.label, s);
          log.info({ period: p.name, label: v.label, closed: s.closed, net: sol(s.netLamports), errors: v.engineErrors, open: v.openPositionsAtEnd }, 'variante concluída');
          if (values.write) notes.push(`  ${v.label} ${p.name}: ${v.runId} (${await writeReplayRun(cfg, query, v, p.fromMs, log)})`);
        }
      }
      results.set(p.name, byLabel);
    }
  } finally {
    await client.close();
  }

  const aj = results.get('ajuste') ?? new Map<string, VariantSummary>();
  const va = results.get('validação') ?? new Map<string, VariantSummary>();
  const cell = (s: VariantSummary | undefined): string[] => (s
    ? [String(s.closed), pct(s.hitRate), sol(s.grossLamports), sol(s.netLamports), `${sol(s.expectancyLamports)} [${sol(s.ci95[0])}; ${sol(s.ci95[1])}]`, sol(s.maxDrawdownLamports)]
    : ['-', '-', '-', '-', '-', '-']);
  const header = ['variante', 'ops', 'acerto', 'bruto', 'líquido', 'exp/op [IC95%]', 'DD', '|', 'ops', 'acerto', 'bruto', 'líquido', 'exp/op [IC95%]', 'DD', '±'];
  const rows = variants.map((v) => {
    const a = aj.get(v.label);
    const b = va.get(v.label);
    const both = a !== undefined && b !== undefined && a.netLamports > 0n && b.netLamports > 0n;
    return [v.label, ...cell(a), '|', ...cell(b), both ? '★' : ''];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]): string => r.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join('  ');
  const out: string[] = [];
  out.push(`Hipóteses de entrada — replay offline (relógio ${clockMode}, kill switch desligado, tokens com lacuna excluídos, pré-carga de criadores ${String(preloadMs / 3_600_000)} h${pumpSwap ? `, universo GRADUADO com PumpSwap exato, SOL/US$ de ${solUsdPath}` : ''})`);
  out.push(`AJUSTE entradas ${brt(fromMs + warmupMs)} → ${brt(cutMs)} (aquecimento só de estado desde ${brt(fromMs)}) | VALIDAÇÃO ${brt(cutMs)} → ${brt(toMs)} (sem sobreposição; SOL; IC 95% bootstrap da média por operação fechada)`);
  out.push('');
  out.push(line(header));
  out.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) out.push(line(r));
  out.push('');
  out.push('★ = PnL líquido > 0 nos DOIS períodos.');
  const candidates = variants.filter((v) => /^[abc]-/.test(v.label)).map((v) => ({ v, s: aj.get(v.label) })).filter((x): x is { v: ReplayVariant; s: VariantSummary } => x.s !== undefined);
  candidates.sort((x, y) => (x.s.netLamports > y.s.netLamports ? -1 : x.s.netLamports < y.s.netLamports ? 1 : 0));
  const best = candidates[0];
  if (best) out.push(`Melhor entrada (a)–(c) pelo PnL líquido no AJUSTE (critério da hipótese d; a validação não entra na escolha): ${best.v.label} (${sol(best.s.netLamports)} SOL)`);
  out.push('');
  out.push('Detalhes por variante (operações fechadas + abertas no fim, entradas não executadas, P(média>0), PnL sem as operações que cruzam lacuna, motivos de saída):');
  for (const v of variants) {
    for (const [name, m] of [['ajuste', aj], ['validação', va]] as const) {
      const s = m.get(v.label);
      if (!s) continue;
      out.push(`  ${v.label.padEnd(18)} ${name.padEnd(9)} fechadas ${String(s.closed)} abertas ${String(s.open)} não-exec ${String(s.failedEntries)} · P>0 ${pct(s.probPositive)} · sem as 3 melhores ${sol(s.netWithoutTop3Lamports)} · cruzam lacuna ${String(s.gapOperations)} (líquido sem elas ${sol(s.netWithoutGapOpsLamports)}) · ${s.exitReasons.map((x) => `${x.reason}=${String(x.count)}`).join(' ')}`);
    }
  }
  out.push('');
  out.push('Execução:');
  for (const n of notes) out.push(`  ${n}`);
  const text = out.join('\n');
  console.log(text);
  const prefix = values.out ?? `data/reports/replay-sweep-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  mkdirSync('data/reports', { recursive: true });
  writeFileSync(`${prefix}.txt`, `${text}\n`);
  writeFileSync(`${prefix}.json`, JSON.stringify({ fromMs, cutMs, toMs, ajuste: [...aj.values()], validacao: [...va.values()] }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`\nsalvo em ${prefix}.txt / .json`);
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
