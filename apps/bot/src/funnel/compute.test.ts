import { describe, expect, it } from 'vitest';
import { computeFunnel, percentile, stageReached, type FunnelSnapshot, type FunnelStep } from './compute.ts';

const snap = (mint: string, a: boolean, b: boolean, c: boolean): FunnelSnapshot & { a: boolean; b: boolean; c: boolean } =>
  ({ mint, a, b, c }) as unknown as FunnelSnapshot & { a: boolean; b: boolean; c: boolean };
const steps = [
  { key: 'a', label: 'a', pass: (s: FunnelSnapshot) => (s as unknown as { a: boolean }).a },
  { key: 'b', label: 'b', pass: (s: FunnelSnapshot) => (s as unknown as { b: boolean }).b },
  { key: 'c', label: 'c', pass: (s: FunnelSnapshot) => (s as unknown as { c: boolean }).c },
] satisfies FunnelStep[];

describe('funil', () => {
  it('estágio = passos consecutivos a partir do primeiro (um passo posterior não compensa um anterior)', () => {
    expect(stageReached(snap('m', true, false, true), steps)).toBe(1);
    expect(stageReached(snap('m', true, true, true), steps)).toBe(3);
    expect(stageReached(snap('m', false, true, true), steps)).toBe(0);
  });

  it('cada token conta pelo melhor estágio em qualquer avaliação; passed é cumulativo', () => {
    const r = computeFunnel(
      [snap('x', true, false, false), snap('x', true, true, false), snap('y', false, true, true), snap('z', true, true, true)],
      steps,
    );
    expect(r.tokens).toBe(3);
    expect(r.passed).toEqual([2, 2, 1]);
    expect(r.bestSnapshots.find((s) => s.mint === 'x')).toMatchObject({ b: true });
  });

  it('percentil com interpolação linear, ignorando NaN', () => {
    expect(percentile([1, 2, 3, 4, Number.NaN], 0.5)).toBe(2.5);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });
});
