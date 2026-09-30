/**
 * Sanidade da gravação (ROADMAP Fase 1).
 *
 * Uso:
 *   pnpm sanity --hours=24                    # últimas 24h, pulando runs 'provisional' (RPC público)
 *   pnpm sanity --hours=24 --include-provisional
 *   pnpm sanity --run=<run_id>                # só a janela de tempo dessa run específica
 *   pnpm sanity --since-run-start              # da última run em diante (ignora runs anteriores)
 *
 * Critério de aceite (Fase 1, local): ≥ 12h contínuas sem silêncio > 60s.
 */
import { parseArgs } from 'node:util';
import { createClient } from '@clickhouse/client';
import { loadConfigFromEnvFile } from '@memebot/core';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    hours: { type: 'string', default: '24' },
    run: { type: 'string' },
    'since-run-start': { type: 'boolean', default: false },
    'include-provisional': { type: 'boolean', default: false },
  },
});
const hours = Number(values.hours);
if (!Number.isInteger(hours) || hours <= 0 || hours > 24 * 30) throw new Error('--hours deve ser inteiro entre 1 e 720');
if (values.run !== undefined && !/^[\w-]+$/.test(values.run)) throw new Error('--run tem caracteres inválidos');

const cfg = loadConfigFromEnvFile();
const ch = createClient({ url: cfg.CLICKHOUSE_URL, username: cfg.CLICKHOUSE_USER, password: cfg.CLICKHOUSE_PASSWORD, database: cfg.CLICKHOUSE_DB });

async function rows(query: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
  const rs = await ch.query({ query, format: 'JSONEachRow', query_params: params });
  return rs.json<Record<string, unknown>>();
}

function section(title: string, data: Record<string, unknown>[]): void {
  console.log(`\n== ${title}`);
  if (data.length === 0) console.log('(sem dados)');
  else console.table(data);
}

interface RunRange {
  runId: string;
  quality: 'provisional' | 'production';
  start: string;
  /** started_at da próxima run, ou `nowStr` se for a mais recente. */
  end: string;
}

const nowStr = String((await rows('SELECT now64(3) AS t'))[0]?.['t']);
const runsRaw = await rows('SELECT run_id, started_at, quality FROM runs ORDER BY started_at');
const runRanges: RunRange[] = runsRaw.map((r, i) => ({
  runId: String(r['run_id']),
  quality: r['quality'] === 'production' ? 'production' : 'provisional',
  start: String(r['started_at']),
  end: i + 1 < runsRaw.length ? String(runsRaw[i + 1]?.['started_at']) : nowStr,
}));

const esc = (s: string): string => s.replace(/'/g, "\\'");
const between = (col: string, start: string, end: string): string => `${col} >= toDateTime64('${esc(start)}', 3) AND ${col} < toDateTime64('${esc(end)}', 3)`;

/** Condição SQL para a coluna de tempo `col`, de acordo com --run / --since-run-start / --hours (+ exclusão de provisional por padrão). */
function windowFor(col: string): string {
  if (values.run !== undefined) {
    const r = runRanges.find((x) => x.runId === values.run);
    if (!r) throw new Error(`run '${values.run}' não encontrada em runs. Rodadas conhecidas: ${runRanges.map((x) => x.runId).join(', ') || '(nenhuma)'}`);
    console.log(`(janela: run ${r.runId}, ${r.quality}, ${r.start} até ${r.end})`);
    return between(col, r.start, r.end);
  }
  if (values['since-run-start']) {
    const last = runRanges.at(-1);
    if (!last) throw new Error('nenhuma run registrada em runs; nada para medir com --since-run-start');
    console.log(`(janela: desde o início da run ${last.runId}, ${last.start})`);
    return between(col, last.start, nowStr);
  }
  const base = `${col} >= toDateTime64('${esc(nowStr)}', 3) - toIntervalHour(${String(hours)}) AND ${col} < toDateTime64('${esc(nowStr)}', 3)`;
  if (values['include-provisional']) return base;
  const provisional = runRanges.filter((r) => r.quality === 'provisional');
  if (provisional.length === 0) return base;
  const exclusions = provisional.map((r) => `NOT (${between(col, r.start, r.end)})`).join(' AND ');
  console.log(`(excluindo ${String(provisional.length)} run(s) provisional(is); use --include-provisional para incluir)`);
  return `(${base}) AND (${exclusions})`;
}

const window = windowFor('received_at');

section(
  'Eventos por minuto (trades)',
  await rows(`
    SELECT count() AS minutos_com_dados,
           dateDiff('minute', min(m), max(m)) + 1 AS minutos_no_intervalo,
           min(c) AS min, quantile(0.5)(c) AS mediana, max(c) AS max
    FROM (SELECT toStartOfMinute(received_at) m, count() c FROM events_trade WHERE ${window} GROUP BY m)`),
);

section(
  'Maior silêncio entre eventos gravados (aceite: < 60 s)',
  await rows(`
    SELECT round(max(d) / 1000, 1) AS maior_silencio_s, argMax(prev, d) AS a_partir_de
    FROM (
      SELECT received_at,
             lagInFrame(received_at) OVER (ORDER BY received_at ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS prev,
             dateDiff('millisecond', prev, received_at) AS d
      FROM (SELECT received_at FROM events_trade WHERE ${window}
            UNION ALL SELECT received_at FROM events_token WHERE ${window})
    ) WHERE prev > toDateTime64('2000-01-01', 3)`),
);

section(
  'Tokens criados por hora (compare com Dune/Bitquery)',
  await rows(`SELECT toStartOfHour(ts) AS hora, count() AS tokens, countIf(quote_mint = '11111111111111111111111111111111') AS cotados_em_sol
              FROM events_token WHERE ${window} GROUP BY hora ORDER BY hora`),
);

section(
  'Reconexões (maiores intervalos de slots perdidos)',
  await rows(`SELECT detected_at, from_slot, to_slot, to_slot - from_slot AS slots, round((to_slot - from_slot) * 0.4, 0) AS aprox_s, detail
              FROM ingest_gaps WHERE kind = 'reconnect' AND ${windowFor('detected_at')}
              ORDER BY slots DESC LIMIT 10`),
);

section(
  'Gaps por tipo',
  await rows(`SELECT kind, count() AS ocorrencias, uniqExact(sig) AS transacoes FROM ingest_gaps
              WHERE ${windowFor('detected_at')} GROUP BY kind ORDER BY ocorrencias DESC`),
);

section(
  'Resolução de pool PumpSwap',
  await rows(`
    SELECT t.trades,
           t.sem_mint AS trades_gravados_com_pool_nao_resolvida,
           round(100 * t.sem_mint / t.trades, 2) AS pct_sem_mint,
           g.falhas_rpc
    FROM (SELECT countIf(venue = 'pumpswap') trades, countIf(venue = 'pumpswap' AND pool_unresolved = 1) sem_mint FROM events_trade WHERE ${window}) t,
         (SELECT countIf(kind = 'pool_resolve_failed') falhas_rpc FROM ingest_gaps WHERE ${windowFor('detected_at')}) g`),
);

section(
  'Qualidade do parse',
  await rows(`
    SELECT t.trades,
           g.parse_errors,
           round(100 * g.parse_errors / (t.trades + g.parse_errors), 4) AS pct_parse_falho,
           g.truncados AS logs_truncados,
           g.trailing AS eventos_com_bytes_extras
    FROM (SELECT count() trades FROM events_trade WHERE ${window}) t,
         (SELECT countIf(kind = 'parse_error') parse_errors, countIf(kind = 'log_truncated') truncados, countIf(kind = 'trailing_bytes') trailing
          FROM ingest_gaps WHERE ${windowFor('detected_at')}) g`),
);

section(
  'Latência on-chain → gravação (received_at − ts do evento)',
  await rows(`SELECT round(quantile(0.5)(d) / 1000, 2) AS p50_s, round(quantile(0.9)(d) / 1000, 2) AS p90_s, round(quantile(0.99)(d) / 1000, 2) AS p99_s
              FROM (SELECT dateDiff('millisecond', ts, received_at) d FROM events_trade WHERE ${window})`),
);

section(
  'Custos amostrados (lamports)',
  await rows(`SELECT count() AS amostras, quantile(0.5)(priority_fee) AS priority_p50, quantile(0.9)(priority_fee) AS priority_p90,
                     countIf(jito_tip > 0) AS com_tip, quantileIf(0.5)(jito_tip, jito_tip > 0) AS tip_p50
              FROM tx_costs WHERE ${windowFor('sampled_at')}`),
);

await ch.close();
