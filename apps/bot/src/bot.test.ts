import { loadConfig } from '@memebot/core';
import { describe, expect, it } from 'vitest';
import { parseBotArgs } from './args.ts';
import { BoundedQueue } from './bounded-queue.ts';
import { formatLamports } from './format.ts';
import { configHash, publicConfig } from './run-info.ts';

describe('parseBotArgs', () => {
  it('padrões e debug', () => {
    expect(parseBotArgs([])).toEqual({ mode: 'record', debugEvents: null });
    expect(parseBotArgs(['--mode=record', '--debug-events=20'])).toEqual({ mode: 'record', debugEvents: 20 });
  });
  it('recusa valores inválidos', () => {
    expect(() => parseBotArgs(['--mode=yolo'])).toThrow(/--mode/);
    expect(() => parseBotArgs(['--debug-events=0'])).toThrow(/debug-events/);
    expect(() => parseBotArgs(['--foo'])).toThrow();
  });
});

describe('publicConfig / configHash', () => {
  it('não inclui segredos nem URLs (que podem conter API key)', () => {
    const cfg = loadConfig({ RPC_URL: 'https://rpc.example/?api-key=SEGREDO', CLICKHOUSE_PASSWORD: 'pw', TELEGRAM_BOT_TOKEN: 't' });
    const pub = JSON.stringify(publicConfig(cfg));
    expect(pub).not.toContain('SEGREDO');
    expect(pub).not.toContain('RPC_URL');
    expect(pub).not.toContain('CLICKHOUSE_PASSWORD');
    expect(pub).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(pub).toContain('PAPER_LATENCY_MS');
  });
  it('trocar só um segredo não muda o hash', () => {
    expect(configHash(loadConfig({ CLICKHOUSE_PASSWORD: 'a' }))).toBe(configHash(loadConfig({ CLICKHOUSE_PASSWORD: 'b' })));
    expect(configHash(loadConfig({ PAPER_LATENCY_MS: '1' }))).not.toBe(configHash(loadConfig({ PAPER_LATENCY_MS: '2' })));
  });
});

describe('formatLamports', () => {
  it('sem float', () => {
    expect(formatLamports(29_629_629n)).toBe('0.029629629');
    expect(formatLamports(84_990_359_847n)).toBe('84.990359847');
    expect(formatLamports(-5n)).toBe('-0.000000005');
  });
});

describe('BoundedQueue', () => {
  it('respeita concorrência e recusa quando cheia', async () => {
    const q = new BoundedQueue(2, 1);
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const task = () =>
      new Promise<void>((r) => {
        active++;
        peak = Math.max(peak, active);
        releases.push(() => {
          active--;
          r();
        });
      });
    expect([q.push(task), q.push(task), q.push(task), q.push(task)]).toEqual([true, true, true, false]);
    expect(peak).toBe(2);
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    await q.onIdle();
    expect(q.size).toBe(0);
  });
});
