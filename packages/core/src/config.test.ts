import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, loadConfigFromEnvFile } from './config.ts';

describe('loadConfig', () => {
  it('aplica defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.MODE).toBe('record');
    expect(cfg.PAPER_LATENCY_MS).toBe(800);
    expect(cfg.PAPER_COST_MIN_SAMPLES).toBe(30);
    expect(cfg.PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS).toBe(500_000n);
    expect(cfg.PAPER_FALLBACK_JITO_TIP_LAMPORTS).toBe(500_000n);
  });

  it('lê os fallbacks de custo do paper como bigint', () => {
    const cfg = loadConfig({ PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS: '123456', PAPER_COST_MIN_SAMPLES: '10' });
    expect(cfg.PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS).toBe(123_456n);
    expect(cfg.PAPER_COST_MIN_SAMPLES).toBe(10);
  });

  it('recusa live sem LIVE_CONFIRM', () => {
    expect(() => loadConfig({ MODE: 'live' })).toThrow(/LIVE_CONFIRM/);
    expect(() => loadConfig({ MODE: 'live', LIVE_CONFIRM: 'yes' })).toThrow(/LIVE_CONFIRM/);
  });

  it('aceita live com a confirmação exata', () => {
    const cfg = loadConfig({ MODE: 'live', LIVE_CONFIRM: 'I_UNDERSTAND_REAL_MONEY' });
    expect(cfg.MODE).toBe('live');
  });

  it('rejeita valores inválidos', () => {
    expect(() => loadConfig({ PAPER_FAIL_RATE: '2' })).toThrow(/Config inválida/);
  });
});

describe('loadConfigFromEnvFile', () => {
  const saved = process.env['PAPER_LATENCY_MS'];
  // o Vitest define process.env.MODE='test', que colide com a nossa variável MODE
  beforeEach(() => {
    vi.stubEnv('MODE', 'record');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (saved === undefined) delete process.env['PAPER_LATENCY_MS'];
    else process.env['PAPER_LATENCY_MS'] = saved;
  });

  it('lê variáveis do arquivo', () => {
    delete process.env['PAPER_LATENCY_MS'];
    const dir = mkdtempSync(path.join(tmpdir(), 'memebot-cfg-'));
    const file = path.join(dir, '.env');
    writeFileSync(file, 'PAPER_LATENCY_MS=1234\n');
    expect(loadConfigFromEnvFile(file).PAPER_LATENCY_MS).toBe(1234);
  });

  it('funciona sem arquivo', () => {
    expect(() => loadConfigFromEnvFile(path.join(tmpdir(), 'nao-existe.env'))).not.toThrow();
  });
});
