import { z } from 'zod';
import { CLOCK_SKEW_ALERT_MS } from './clock-skew.ts';

/** Plano free do Helius (créditos HTTP por mês; 1 crédito por requisição de RPC padrão). */
export const HELIUS_FREE_MONTHLY_CREDITS = 1_000_000;

const MINUTES_PER_DAY = 1_440;
const DAYS_PER_MONTH = 30;

const IngestLine = z.object({
  msg: z.literal('ingest'),
  time: z.number(),
  eventsPerMin: z.number(),
  http: z.object({ requestsPerMin: z.number(), rateLimitedPerMin: z.number() }),
  ws: z.object({ mbPerMin: z.number(), messagesPerMin: z.number(), reconnectsPerMin: z.number() }),
  costSamples: z.object({ recordedPerMin: z.number(), notFoundPerMin: z.number(), failedPerMin: z.number() }).optional(),
  clockSkew: z.object({ samples: z.number(), medianMs: z.number(), minMs: z.number(), maxMs: z.number() }).nullable().optional(),
});

export interface IngestStatusSummary {
  minutes: number;
  fromMs: number;
  toMs: number;
  avg: { eventsPerMin: number; wsMbPerMin: number; httpRequestsPerMin: number; http429PerMin: number; costSamplesPerMin: number };
  totals: { wsReconnects: number; costSamplesNotFound: number; costSamplesFailed: number };
  /** Desvio relógio local × ts dos eventos (mediana de received_at − ts por minuto); null em logs antigos. */
  clockSkew: { minutes: number; lastMedianMs: number; maxAbsMedianMs: number; alert: boolean } | null;
  projection: {
    wsGbPerDay: number;
    wsGbPerMonth: number;
    httpRequestsPerDay: number;
    httpRequestsPerMonth: number;
    /** Fração do plano free do Helius consumida por mês nesse ritmo (1 = 100%). */
    heliusFreePlanFraction: number;
  };
}

/**
 * Lê linhas de log (formato pm2 com `time: true`: `<timestamp>: {json}`, ou JSON puro) e resume as
 * últimas `lastN` linhas `ingest` que já têm os campos `http`/`ws` (versões antigas do log são ignoradas).
 * Função pura: quem chama lê o arquivo.
 */
export function summarizeIngestLog(lines: readonly string[], lastN: number): IngestStatusSummary | null {
  const parsed: z.infer<typeof IngestLine>[] = [];
  for (const line of lines) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    let json: unknown;
    try {
      json = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    const r = IngestLine.safeParse(json);
    if (r.success) parsed.push(r.data);
  }
  const window = parsed.slice(-lastN);
  const first = window[0];
  const last = window.at(-1);
  if (!first || !last) return null;
  const n = window.length;
  const mean = (f: (x: z.infer<typeof IngestLine>) => number): number => window.reduce((acc, x) => acc + f(x), 0) / n;
  const sum = (f: (x: z.infer<typeof IngestLine>) => number): number => window.reduce((acc, x) => acc + f(x), 0);

  const wsMbPerMin = mean((x) => x.ws.mbPerMin);
  const httpRequestsPerMin = mean((x) => x.http.requestsPerMin);
  const httpRequestsPerMonth = httpRequestsPerMin * MINUTES_PER_DAY * DAYS_PER_MONTH;
  const skews = window.flatMap((x) => (x.clockSkew ? [x.clockSkew.medianMs] : []));
  const lastSkew = skews.at(-1);
  return {
    minutes: n,
    fromMs: first.time,
    toMs: last.time,
    avg: {
      eventsPerMin: mean((x) => x.eventsPerMin),
      wsMbPerMin,
      httpRequestsPerMin,
      http429PerMin: mean((x) => x.http.rateLimitedPerMin),
      costSamplesPerMin: mean((x) => x.costSamples?.recordedPerMin ?? 0),
    },
    totals: {
      wsReconnects: sum((x) => x.ws.reconnectsPerMin),
      costSamplesNotFound: sum((x) => x.costSamples?.notFoundPerMin ?? 0),
      costSamplesFailed: sum((x) => x.costSamples?.failedPerMin ?? 0),
    },
    clockSkew: lastSkew === undefined ? null : {
      minutes: skews.length,
      lastMedianMs: lastSkew,
      maxAbsMedianMs: Math.max(...skews.map(Math.abs)),
      alert: Math.abs(lastSkew) > CLOCK_SKEW_ALERT_MS,
    },
    projection: {
      wsGbPerDay: (wsMbPerMin * MINUTES_PER_DAY) / 1_024,
      wsGbPerMonth: (wsMbPerMin * MINUTES_PER_DAY * DAYS_PER_MONTH) / 1_024,
      httpRequestsPerDay: httpRequestsPerMin * MINUTES_PER_DAY,
      httpRequestsPerMonth,
      heliusFreePlanFraction: httpRequestsPerMonth / HELIUS_FREE_MONTHLY_CREDITS,
    },
  };
}

const SourceEntry = z.object({ source: z.string().optional(), host: z.string().optional(), value: z.number().optional() });
const ConfigSourcesLine = z.object({ msg: z.literal('config sources'), configSources: z.record(z.string(), SourceEntry) });
export type ConfigSources = z.infer<typeof ConfigSourcesLine>['configSources'];

/** Última linha `config sources` do log (origem de RPC_URL/RPC_WS_URL/INGEST_COST_SAMPLES_PER_SEC; sem valores secretos). */
export function lastConfigSources(lines: readonly string[]): ConfigSources | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const start = line.indexOf('{');
    if (start < 0 || !line.includes('config sources')) continue;
    try {
      const r = ConfigSourcesLine.safeParse(JSON.parse(line.slice(start)));
      if (r.success) return r.data.configSources;
    } catch {
      continue;
    }
  }
  return null;
}

export function formatConfigSources(c: ConfigSources | null): string {
  if (!c) return 'Origem da config: (nenhuma linha "config sources" no log — versão antiga do bot)';
  const rows = Object.entries(c).map(([k, v]) => {
    const extra = v.host !== undefined ? `host ${v.host}` : v.value !== undefined ? `valor ${String(v.value)}` : '';
    return `  ${k.padEnd(28)} ${(v.source ?? '?').padEnd(16)} ${extra}`;
  });
  return ['Origem da config (env do processo vence o .env; chaves nunca exibidas)', ...rows].join('\n');
}

export function formatStatus(s: IngestStatusSummary): string {
  const f = (x: number, d = 1): string => x.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: d });
  const i = (x: number): string => Math.round(x).toLocaleString('pt-BR');
  return [
    `Janela: ${String(s.minutes)} min (${new Date(s.fromMs).toISOString()} → ${new Date(s.toMs).toISOString()})`,
    '',
    'Média por minuto',
    `  eventos           ${i(s.avg.eventsPerMin)}`,
    `  WebSocket         ${f(s.avg.wsMbPerMin, 2)} MB`,
    `  HTTP (RPC_URL)    ${f(s.avg.httpRequestsPerMin)} requisições  (429: ${f(s.avg.http429PerMin)})`,
    `  amostras de custo ${f(s.avg.costSamplesPerMin)}`,
    `  reconexões WS na janela: ${String(s.totals.wsReconnects)}; amostras não encontradas: ${String(s.totals.costSamplesNotFound)}; falhas: ${String(s.totals.costSamplesFailed)}`,
    s.clockSkew
      ? `  desvio relógio local × ts dos eventos (mediana received_at − ts): último min ${f(s.clockSkew.lastMedianMs / 1_000)} s; máx |mediana| na janela ${f(s.clockSkew.maxAbsMedianMs / 1_000)} s${s.clockSkew.alert ? `  ⚠ ACIMA DE ${String(CLOCK_SKEW_ALERT_MS / 1_000)} s` : ' (normal ≈ +1 a +2 s)'}`
      : '  desvio do relógio: (sem campo clockSkew no log — versão antiga do bot)',
    '',
    'Projeção (ritmo médio da janela; mês = 30 dias)',
    `  WebSocket   ${f(s.projection.wsGbPerDay, 2)} GB/dia   ${f(s.projection.wsGbPerMonth, 1)} GB/mês`,
    `  HTTP        ${i(s.projection.httpRequestsPerDay)} req/dia   ${i(s.projection.httpRequestsPerMonth)} req/mês`,
    `  Helius free (${i(HELIUS_FREE_MONTHLY_CREDITS)} créditos/mês): ${f(s.projection.heliusFreePlanFraction * 100)}% do plano`,
  ].join('\n');
}
