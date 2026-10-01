import { Writable } from 'node:stream';
import { createLogger } from '@memebot/core';
import { estimateTxCosts } from '@memebot/execution';
import { TelegramNotifier } from '@memebot/monitor';
import { describe, expect, it } from 'vitest';
import { formatBrasiliaTime, formatPaperStarted } from './start-message.ts';

const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => { cb(); } }) });

describe('aviso "paper iniciado"', () => {
  it('hora de Brasília (UTC−3) com UTC entre parênteses', () => {
    expect(formatBrasiliaTime(Date.UTC(2026, 9, 1, 22, 56, 25))).toBe('01/10/2026 19:56:25 (Brasília, UTC−3) (22:56:25 UTC)');
    expect(formatBrasiliaTime(Date.UTC(2026, 9, 2, 1, 5, 0))).toBe('01/10/2026 22:05:00 (Brasília, UTC−3) (01:05:00 UTC)');
  });

  it('enviado pelo Telegram (fetch falso) com run, versão/hash da config, tamanho e modo de custos', async () => {
    const bodies: string[] = [];
    const tg = new TelegramNotifier({
      botToken: '1:abc', chatId: '42', logger: silent, sleep: () => Promise.resolve(),
      fetchFn: (_u, init) => {
        bodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      },
    });
    const costs = estimateTxCosts([{ priorityFee: 100_000n, jitoTip: null }], { minSamples: 30, fallbackPriorityFeeLamports: 500_000n, fallbackJitoTipLamports: 500_000n });
    tg.send(formatPaperStarted({
      runId: 'paper-x', startedAtMs: Date.UTC(2026, 9, 1, 22, 56, 25), configVersion: 'v0.1', configHash: 'abcdef1234567890',
      sizeLamports: 50_000_000n, maxOpenPositions: 3, costs, latencyMs: 800, failRate: 0.1,
    }));
    await tg.close(1_000);
    expect(tg.stats).toEqual({ sent: 1, failed: 0, dropped: 0 });
    const text = (JSON.parse(bodies[0] ?? '{}') as { text: string }).text;
    expect(text).toContain('paper iniciado');
    expect(text).toContain('19:56:25 (Brasília, UTC−3) (22:56:25 UTC)');
    expect(text).toContain('run: paper-x');
    expect(text).toContain('config: v0.1 (sha256 abcdef123456)');
    expect(text).toContain('posição: 0.050000 SOL × até 3 abertas');
    expect(text).toContain('priority 0.000150 SOL (tx_costs_p75, 1 amostras)');
    expect(text).toContain('tip 0.000500 SOL (fallback, 0 amostras)');
  });
});
