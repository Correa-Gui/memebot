import { describe, expect, it } from 'vitest';
import { ClockSkewTracker, SkewAlarm } from './clock-skew.ts';

describe('ClockSkewTracker', () => {
  it('mediana/mín/máx de received_at − ts no período e zera', () => {
    const t = new ClockSkewTracker();
    expect(t.take()).toBeNull();
    for (const lag of [900, 1_200, 31_000, 1_500]) t.observe(10_000 + lag, 10_000);
    expect(t.take()).toEqual({ samples: 4, medianMs: 1_350, minMs: 900, maxMs: 31_000 });
    expect(t.take()).toBeNull();
  });

  it('relógio local 30 s adiantado → mediana ≈ 31 s', () => {
    const t = new ClockSkewTracker();
    for (let i = 0; i < 101; i++) t.observe(i * 1_000 + 30_000 + 700 + (i % 7) * 100, i * 1_000);
    expect(t.take()?.medianMs).toBe(31_000);
  });
});

describe('SkewAlarm', () => {
  it('alerta uma vez acima de 5 s (em módulo) e uma vez ao normalizar', () => {
    const a = new SkewAlarm();
    const s = (medianMs: number) => ({ samples: 10, medianMs, minMs: 0, maxMs: 0 });
    expect(a.check(s(1_500))).toBeNull();
    expect(a.check(null)).toBeNull();
    expect(a.check(s(31_000))).toEqual({ kind: 'high', medianMs: 31_000 });
    expect(a.check(s(30_000))).toBeNull();
    expect(a.check(s(5_000))).toEqual({ kind: 'normal', medianMs: 5_000 });
    expect(a.check(s(-6_000))).toEqual({ kind: 'high', medianMs: -6_000 });
  });
});
