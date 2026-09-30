/**
 * Sanidade da gravação (ROADMAP Fase 1). Uso: pnpm sanity --hours=24
 * Critério de aceite: nenhum silêncio > 60 s em 24 h; tokens/hora na ordem das fontes públicas.
 */
import { parseArgs } from 'node:util';
import { createClient } from '@clickhouse/client';
import { loadConfigFromEnvFile } from '@memebot/core';

const { values } = parseArgs({ args: process.argv.slice(2), options: { hours: { type: 'string', default: '24' } } });
const hours = Number(values.hours);
if (!Number.isInteger(hours) || hours <= 0 || hours > 24 * 30) throw new Error('--hours deve ser inteiro entre 1 e 720');

const cfg = loadConfigFromEnvFile();
const ch = createClient({ url: cfg.CLICKHOUSE_URL, username: cfg.CLICKHOUSE_USER, password: cfg.CLICKHOUSE_PASSWORD, database: cfg.CLICKHOUSE_DB });

async function rows(query: string): Promise<Record<string, unknown>[]> {
  const rs = await ch.query({ query, format: 'JSONEachRow', query_params: { hours } });
  return rs.json<Record<string, unknown>>();
}

function section(title: string, data: Record<string, unknown>[]): void {
  console.log(`\n== ${title}`);
  if (data.length === 0) console.log('(sem dados)');
  else console.table(data);
}

const window = 'received_at >= now64(3) - toIntervalHour({hours:UInt32})';

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
              FROM ingest_gaps WHERE kind = 'reconnect' AND detected_at >= now64(3) - toIntervalHour({hours:UInt32})
              ORDER BY slots DESC LIMIT 10`),
);

section(
  'Gaps por tipo',
  await rows(`SELECT kind, count() AS ocorrencias, uniqExact(sig) AS transacoes FROM ingest_gaps
              WHERE detected_at >= now64(3) - toIntervalHour({hours:UInt32}) GROUP BY kind ORDER BY ocorrencias DESC`),
);

section(
  'Qualidade do parse',
  await rows(`
    SELECT t.trades,
           g.parse_errors,
           round(100 * g.parse_errors / (t.trades + g.parse_errors), 4) AS pct_parse_falho,
           t.sem_mint AS trades_pumpswap_sem_pool_resolvida,
           round(100 * t.sem_mint / t.trades, 2) AS pct_sem_mint,
           g.truncados AS logs_truncados,
           g.trailing AS eventos_com_bytes_extras
    FROM (SELECT count() trades, countIf(mint = '') sem_mint FROM events_trade WHERE ${window}) t,
         (SELECT countIf(kind = 'parse_error') parse_errors, countIf(kind = 'log_truncated') truncados, countIf(kind = 'trailing_bytes') trailing
          FROM ingest_gaps WHERE detected_at >= now64(3) - toIntervalHour({hours:UInt32})) g`),
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
              FROM tx_costs WHERE sampled_at >= now64(3) - toIntervalHour({hours:UInt32})`),
);

await ch.close();
