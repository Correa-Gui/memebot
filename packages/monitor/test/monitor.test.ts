import { Writable } from 'node:stream';
import { createLogger } from '@memebot/core';
import { describe, expect, it } from 'vitest';
import { TelegramNotifier, formatEntryAlert, formatExitAlert, formatHourlySummary, formatSol, redactToken } from '../src/index.ts';

const TOKEN = '123456:SEGREDO-abc_DEF';

function capturingLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    destination: new Writable({
      write: (chunk: Buffer, _e, cb) => {
        lines.push(chunk.toString());
        cb();
      },
    }),
  });
  return { logger, lines };
}

const noSleep = (): Promise<void> => Promise.resolve();

function ok(): Response {
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
}

function bodyOf(init: RequestInit | undefined): { chat_id?: string; text?: string } {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { chat_id?: string; text?: string };
}

describe('TelegramNotifier', () => {
  it('sem token/chat: desligado, avisa no log e não chama fetch', () => {
    const { logger, lines } = capturingLogger();
    let calls = 0;
    const n = new TelegramNotifier({
      botToken: '', chatId: '', logger,
      fetchFn: () => {
        calls++;
        return Promise.resolve(ok());
      },
    });
    n.send('oi');
    expect(n.enabled).toBe(false);
    expect(calls).toBe(0);
    expect(lines.join('')).toMatch(/Telegram desligado/);
  });

  it('envia sendMessage com chat_id e texto', async () => {
    const { logger } = capturingLogger();
    const reqs: { url: string; body: { chat_id?: string; text?: string } }[] = [];
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, sleep: noSleep,
      fetchFn: (url, init) => {
        reqs.push({ url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, body: bodyOf(init) });
        return Promise.resolve(ok());
      },
    });
    n.send('olá');
    await n.close(1_000);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(reqs[0]?.body).toMatchObject({ chat_id: '42', text: 'olá' });
    expect(n.stats).toEqual({ sent: 1, failed: 0, dropped: 0 });
  });

  it('retry com backoff em erro de rede/5xx e respeita retry_after do 429', async () => {
    const { logger } = capturingLogger();
    const sleeps: number[] = [];
    const responses: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error('ECONNRESET')),
      () => Promise.resolve(new Response('{"ok":false}', { status: 502 })),
      () => Promise.resolve(new Response(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }), { status: 429 })),
      () => Promise.resolve(ok()),
    ];
    let i = 0;
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, maxRetries: 3, baseBackoffMs: 100,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      fetchFn: () => (responses[i++] ?? (() => Promise.resolve(ok())))(),
    });
    n.send('x');
    await n.close(1_000);
    expect(n.stats.sent).toBe(1);
    expect(sleeps).toEqual([100, 200, 2_000]);
  });

  it('falha definitiva: não lança, conta, e o log NUNCA contém o token (nem pela URL no erro do fetch)', async () => {
    const { logger, lines } = capturingLogger();
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, maxRetries: 1, sleep: noSleep,
      fetchFn: (url) => Promise.reject(new Error(`fetch failed for ${typeof url === 'string' ? url : url instanceof URL ? url.href : url.url}`)),
    });
    expect(() => {
      n.send('x');
    }).not.toThrow();
    await n.close(1_000);
    expect(n.stats.failed).toBe(1);
    const log = lines.join('');
    expect(log).toMatch(/falha ao enviar alerta/);
    expect(log).not.toContain('SEGREDO');
  });

  it('4xx não é repetido', async () => {
    const { logger } = capturingLogger();
    let calls = 0;
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, sleep: noSleep,
      fetchFn: () => {
        calls++;
        return Promise.resolve(new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }));
      },
    });
    n.send('x');
    await n.close(1_000);
    expect(calls).toBe(1);
    expect(n.stats.failed).toBe(1);
  });

  it('fila limitada: descarta as mais antigas e conta', async () => {
    const { logger } = capturingLogger();
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, maxQueue: 2, sleep: noSleep,
      fetchFn: async (_u, init) => {
        await gate;
        sent.push(bodyOf(init).text ?? '');
        return ok();
      },
    });
    for (const t of ['a', 'b', 'c', 'd', 'e']) n.send(t);
    release();
    await n.close(1_000);
    expect(n.stats.dropped).toBe(2);
    expect(sent).toEqual(['a', 'd', 'e']);
  });

  it('redactToken remove o token e padrões bot<id>:<segredo>', () => {
    expect(redactToken(`x https://api.telegram.org/bot${TOKEN}/sendMessage`, TOKEN)).not.toContain('SEGREDO');
    expect(redactToken('bot987:outro-segredo', '')).toBe('bot[REDACTED]');
  });
});

describe('mensagens', () => {
  it('formatSol sem float', () => {
    expect(formatSol(50_000_000n)).toBe('0.050000 SOL');
    expect(formatSol(-1_234_567_890n)).toBe('-1.234567 SOL');
  });

  it('entrada, saída e resumo trazem os campos pedidos e links públicos', () => {
    const entry = formatEntryAlert({ mint: 'Mint1', symbol: 'DOG', priceLamportsPerUnit: 0.0312, sizeLamports: 50_000_000n, costLamports: 2_664_840n, costSource: 'fallback', mode: 'paper' });
    expect(entry).toContain('ENTRADA DOG (Mint1)');
    expect(entry).toContain('https://pump.fun/coin/Mint1');
    expect(entry).toContain('https://solscan.io/token/Mint1');
    expect(entry).toContain('0.050000 SOL');

    const exit = formatExitAlert({
      mint: 'Mint1', symbol: null, reason: 'stop_loss', fraction: 1, priceLamportsPerUnit: 0.02, pnlLamports: -10_000_000n, pnlRatio: -0.2,
      closed: true, operationPnlLamports: -10_000_000n, operationPnlRatio: -0.2, mode: 'paper',
    });
    expect(exit).toContain('stop_loss');
    expect(exit).toContain('-20.0%');
    expect(exit).toContain('posição fechada');

    const summary = formatHourlySummary({
      mode: 'paper', runId: 'r', fromMs: 0, toMs: 3_600_000, entries: 2, closedOperations: 2, winningOperations: 1,
      netPnlLamports: 1_000_000n, runNetPnlLamports: 2_000_000n, openPositions: 1,
      rejectionsByReason: new Map([['minUniqueHolders', 30], ['maxAgeSec', 2]]),
    });
    expect(summary).toContain('acerto: 50%');
    expect(summary).toContain('minUniqueHolders: 30');
  });
});
