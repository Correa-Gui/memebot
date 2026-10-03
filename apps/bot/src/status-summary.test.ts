import { describe, expect, it } from 'vitest';
import { HELIUS_FREE_MONTHLY_CREDITS, formatConfigSources, formatStatus, lastConfigSources, summarizeIngestLog } from './status-summary.ts';

function line(time: number, mbPerMin: number, requestsPerMin: number, extra: Record<string, unknown> = {}): string {
  const body = {
    level: 30,
    time,
    msg: 'ingest',
    eventsPerMin: 1000,
    http: { requestsPerMin, rateLimitedPerMin: 1 },
    ws: { mbPerMin, messagesPerMin: 500, reconnectsPerMin: 0 },
    costSamples: { recordedPerMin: 10, notFoundPerMin: 1, failedPerMin: 0 },
    ...extra,
  };
  return `2026-10-01T20:00:00: ${JSON.stringify(body)}`;
}

describe('summarizeIngestLog', () => {
  it('ignora linhas que não são ingest ou não têm métricas novas, e usa só as últimas N', () => {
    const lines = [
      'lixo',
      '2026-10-01T20:00:00: {"msg":"ingest","time":1,"eventsPerMin":5}', // formato antigo
      line(1_000, 100, 999),
      line(2_000, 10, 20),
      line(3_000, 20, 40, { ws: { mbPerMin: 20, messagesPerMin: 1, reconnectsPerMin: 2 } }),
      '{"msg":"run iniciado"}',
    ];
    const s = summarizeIngestLog(lines, 2);
    expect(s?.minutes).toBe(2);
    expect(s?.avg.wsMbPerMin).toBe(15);
    expect(s?.avg.httpRequestsPerMin).toBe(30);
    expect(s?.totals.wsReconnects).toBe(2);
    expect(s?.fromMs).toBe(2_000);
  });

  it('projeta por dia e por mês (30 dias) e a fração do plano free do Helius', () => {
    const s = summarizeIngestLog([line(1, 1, 10)], 30);
    expect(s?.projection.wsGbPerDay).toBeCloseTo(1_440 / 1_024, 9);
    expect(s?.projection.httpRequestsPerDay).toBe(14_400);
    expect(s?.projection.httpRequestsPerMonth).toBe(432_000);
    expect(s?.projection.heliusFreePlanFraction).toBeCloseTo(432_000 / HELIUS_FREE_MONTHLY_CREDITS, 9);
  });

  it('desvio do relógio: último minuto, máximo da janela e alerta acima de 5 s; null em log antigo', () => {
    const skew = (medianMs: number) => ({ clockSkew: { samples: 100, medianMs, minMs: 500, maxMs: 9_000 } });
    const s = summarizeIngestLog([line(1, 1, 1, skew(1_200)), line(2, 1, 1, skew(-7_000)), line(3, 1, 1, skew(31_000))], 10);
    expect(s?.clockSkew).toEqual({ minutes: 3, lastMedianMs: 31_000, maxAbsMedianMs: 31_000, alert: true });
    if (!s) throw new Error('sem resumo');
    expect(formatStatus(s)).toContain('ACIMA DE 5 s');
    const ok = summarizeIngestLog([line(1, 1, 1, skew(1_200)), line(2, 1, 1, { clockSkew: null })], 10);
    expect(ok?.clockSkew).toMatchObject({ minutes: 1, lastMedianMs: 1_200, alert: false });
    expect(summarizeIngestLog([line(1, 1, 1)], 10)?.clockSkew).toBeNull();
  });

  it('null sem nenhuma linha válida', () => {
    expect(summarizeIngestLog(['nada'], 10)).toBeNull();
  });
});

describe('lastConfigSources / formatConfigSources', () => {
  it('pega a última linha config sources e mostra origem + host/valor, nunca a URL completa', () => {
    const l = (src: string) =>
      `2026-10-01T23:00:00: ${JSON.stringify({ msg: 'config sources', configSources: { RPC_URL: { source: src, host: 'mainnet.helius-rpc.com' }, INGEST_COST_SAMPLES_PER_SEC: { source: 'padrão', value: 0.2 } } })}`;
    const c = lastConfigSources([l('.env'), 'x', l('env do processo')]);
    expect(c?.['RPC_URL']).toEqual({ source: 'env do processo', host: 'mainnet.helius-rpc.com' });
    const text = formatConfigSources(c);
    expect(text).toContain('mainnet.helius-rpc.com');
    expect(text).toContain('valor 0.2');
    expect(formatConfigSources(null)).toContain('versão antiga');
  });
});
