import { z } from 'zod';

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
});

export interface IngestStatusSummary {
  minutes: number;
  fromMs: number;
  toMs: number;
  avg: { eventsPerMin: number; wsMbPerMin: number; httpRequestsPerMin: number; http429PerMin: number; costSamplesPerMin: number };
  totals: { wsReconnects: number; costSamplesNotFound: number; costSamplesFailed: number };
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
    projection: {
      wsGbPerDay: (wsMbPerMin * MINUTES_PER_DAY) / 1_024,
      wsGbPerMonth: (wsMbPerMin * MINUTES_PER_DAY * DAYS_PER_MONTH) / 1_024,
      httpRequestsPerDay: httpRequestsPerMin * MINUTES_PER_DAY,
      httpRequestsPerMonth,
      heliusFreePlanFraction: httpRequestsPerMonth / HELIUS_FREE_MONTHLY_CREDITS,
    },
  };
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
    '',
    'Projeção (ritmo médio da janela; mês = 30 dias)',
    `  WebSocket   ${f(s.projection.wsGbPerDay, 2)} GB/dia   ${f(s.projection.wsGbPerMonth, 1)} GB/mês`,
    `  HTTP        ${i(s.projection.httpRequestsPerDay)} req/dia   ${i(s.projection.httpRequestsPerMonth)} req/mês`,
    `  Helius free (${i(HELIUS_FREE_MONTHLY_CREDITS)} créditos/mês): ${f(s.projection.heliusFreePlanFraction * 100)}% do plano`,
  ].join('\n');
}
