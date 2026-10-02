import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Clock } from '@memebot/core';
import { describe, expect, it } from 'vitest';
import { StrategyConfigSchema, entryMode, loadStrategyConfig } from '../src/config.ts';
import type { StrategyV0Config } from '../src/config.ts';
import { evaluate } from '../src/evaluate.ts';
import { confirmPendingEntry, createPendingSignal, decidePendingSignal, observePendingPrice } from '../src/pending.ts';
import type { PendingSignal } from '../src/pending.ts';
import { CURVE_PARAMS, NOW, baseStrategyConfig, buildScenario } from './helpers.ts';

/** Hipóteses de entrada do experimento de 2026-10-02 (docs/STRATEGY.md §8) — todas desligadas por padrão. */

const clockAt = (ms: number): Clock => ({ nowMs: () => ms, slot: () => 0n });
const withEntry = (patch: Partial<StrategyV0Config['entry']>): StrategyV0Config => {
  const c = baseStrategyConfig();
  return { ...c, entry: { ...c.entry, ...patch } };
};

describe('config — opções novas (default = v0.1)', () => {
  it('o strategy.v0.yaml do paper não liga nenhuma hipótese', () => {
    const real = loadStrategyConfig(fileURLToPath(new URL('../../../config/strategy.v0.yaml', import.meta.url)));
    expect(entryMode(real)).toBe('immediate');
    expect(real.entry.maxPriceAboveMean120sPct).toBeUndefined();
  });

  it('confirmation e pullback juntos são recusados', () => {
    const c = baseStrategyConfig();
    const r = StrategyConfigSchema.safeParse({ ...c, entry: { ...c.entry, confirmation: { windowSec: 10, maxDipPct: 0.1 }, pullback: { retracePct: 0.2, windowSec: 120, minUniqueBuyers60s: 5 } } });
    expect(r.success).toBe(false);
  });

  it('todas as variantes de config/variants/ parseiam e têm o modo esperado', () => {
    const dir = fileURLToPath(new URL('../../../config/variants/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const c = loadStrategyConfig(`${dir}${f}`);
      if (f.includes('confirm')) expect(entryMode(c)).toBe('confirmation');
      else if (f.includes('pullback')) expect(entryMode(c)).toBe('pullback');
      else expect(entryMode(c)).toBe('immediate');
    }
  });
});

describe('(b) não perseguir — entry.maxPriceAboveMean120sPct', () => {
  it('desligada: mesmo enter da v0.1, sem feature nova', () => {
    const { state, mint, nowMs, config } = buildScenario();
    const [d] = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(d?.outcome).toBe('enter');
    if (d?.outcome !== 'enter') throw new Error('enter');
    expect('priceVsMean120sPct' in d.features).toBe(false);
  });

  it('acima do limite → reject; abaixo → enter com priceVsMean120sPct no snapshot', () => {
    const { state, mint, nowMs } = buildScenario();
    expect(evaluate(state, mint, clockAt(nowMs), withEntry({ maxPriceAboveMean120sPct: 0.2 }), CURVE_PARAMS)).toEqual([
      { outcome: 'reject', mint, reason: 'maxPriceAboveMean120sPct' },
    ]);
    const [d] = evaluate(state, mint, clockAt(nowMs), withEntry({ maxPriceAboveMean120sPct: 1e12 }), CURVE_PARAMS);
    if (d?.outcome !== 'enter') throw new Error('enter');
    expect(d.features.priceVsMean120sPct).toBeGreaterThan(0.2);
  });
});

function signalFor(config: StrategyV0Config): PendingSignal {
  const { state, mint, nowMs } = buildScenario();
  const [d] = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
  if (d?.outcome !== 'enter') throw new Error('enter');
  const s = createPendingSignal(d, state, nowMs, config);
  if (!s) throw new Error('signal');
  return s;
}

describe('(a) confirmação — entry.confirmation', () => {
  const cfg = withEntry({ confirmation: { windowSec: 30, maxDipPct: 0.1 } });

  it('espera a janela; fecha ≥ preço do sinal → fire; abaixo → cancel', () => {
    const s = signalFor(cfg);
    expect(s.mode).toBe('confirmation');
    expect(decidePendingSignal(s, NOW + 29_999, cfg)).toEqual({ action: 'wait' });
    const up = observePendingPrice(observePendingPrice(s, s.signalPrice * 0.95), s.signalPrice * 1.01);
    expect(decidePendingSignal(up, NOW + 30_000, cfg)).toEqual({ action: 'fire' });
    const down = observePendingPrice(s, s.signalPrice * 0.99);
    expect(decidePendingSignal(down, NOW + 30_000, cfg)).toEqual({ action: 'cancel', reason: 'confirmation_below_signal' });
  });

  it('queda maior que maxDipPct no meio da janela cancela na hora (mesmo que volte)', () => {
    const s = signalFor(cfg);
    expect(observePendingPrice(s, 0)).toBe(s); // preço inválido é ignorado
    const dip = observePendingPrice(observePendingPrice(s, s.signalPrice * 0.89), s.signalPrice * 2);
    expect(decidePendingSignal(dip, NOW + 1_000, cfg)).toEqual({ action: 'cancel', reason: 'confirmation_dip' });
  });

  it('confirmPendingEntry: reavalia os filtros duros; enter leva signal_* e a espera', () => {
    const { state } = buildScenario();
    const s = signalFor(cfg);
    const d = confirmPendingEntry(state, s, NOW + 30_000, cfg, CURVE_PARAMS);
    expect(d).toMatchObject({ outcome: 'enter', reason: 'momentum_confirmed' });
    if (d.outcome !== 'enter') throw new Error('enter');
    expect(d.features.signalWaitMs).toBe(30_000);
    expect(d.features.signal_uniqueBuyers60s).toBe(3);
    // filtro duro falhando no disparo (top holder com 40% do supply)
    const bad = buildScenario({ topHolderAmount: 400_000n });
    expect(confirmPendingEntry(bad.state, s, NOW + 30_000, cfg, CURVE_PARAMS)).toEqual({ outcome: 'reject', mint: s.mint, reason: 'confirmation:maxTop10PctSupply' });
  });
});

describe('(c) recuo — entry.pullback', () => {
  const cfg = withEntry({ pullback: { retracePct: 0.25, windowSec: 180, minUniqueBuyers60s: 3 } });

  it('dispara quando recua retracePct do máximo desde o sinal; expira sem recuo', () => {
    const s = signalFor(cfg);
    expect(s.mode).toBe('pullback');
    const peak = observePendingPrice(s, s.signalPrice * 2);
    expect(decidePendingSignal(observePendingPrice(peak, s.signalPrice * 1.51), NOW + 10_000, cfg)).toEqual({ action: 'wait' });
    expect(decidePendingSignal(observePendingPrice(peak, s.signalPrice * 1.5), NOW + 10_000, cfg)).toEqual({ action: 'fire' });
    expect(decidePendingSignal(peak, NOW + 180_000, cfg)).toEqual({ action: 'cancel', reason: 'pullback_expired' });
  });

  it('no disparo exige compradores únicos ativos', () => {
    const { state } = buildScenario();
    const s = signalFor(cfg);
    expect(confirmPendingEntry(state, s, NOW, cfg, CURVE_PARAMS)).toMatchObject({ outcome: 'enter', reason: 'momentum_pullback' });
    const strict = withEntry({ pullback: { retracePct: 0.25, windowSec: 180, minUniqueBuyers60s: 4 } });
    expect(confirmPendingEntry(state, s, NOW, strict, CURVE_PARAMS)).toEqual({ outcome: 'reject', mint: s.mint, reason: 'pullback:minUniqueBuyers60s' });
  });
});
