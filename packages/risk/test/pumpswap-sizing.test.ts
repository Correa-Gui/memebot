import { describe, expect, it } from 'vitest';
import { effectiveQuoteReserves, pumpSwapBuyExactQuoteIn } from '@memebot/curve-math';
import type { TokenState } from '@memebot/state';
import { approveEntry, buildEffectiveRiskLimits, computePumpSwapEntrySize, createRiskState, pumpSwapImpactPct } from '../src/index.ts';
import type { ApproveEntryInput } from '../src/index.ts';
import { FEES, NOW, enterDecision, fixedClock, marketWithToken, realConfig, tokenOf } from './helpers.ts';

/** Universo graduado (2026-10-03): sizing pelo swap exato do PumpSwap, só com `pumpSwapEnabled`. */
const BPS = { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n, cashbackFeeBps: 0n };
const DEEP = { base: 206_900_000_000_000n, quote: 67_000_000_000n, virtualQuote: 17_584_505_396n };
const THIN = { base: 900_000_000_000_000n, quote: 500_000_000n, virtualQuote: 0n };

function graduated(token: TokenState, r = DEEP): TokenState {
  return { ...token, venue: 'pumpswap', curveCompleted: true, graduatedAtMs: NOW - 120_000, pumpSwapReserves: { pool: 'p', ...r, feeBps: BPS, baseSupply: 1_000_000_000_000_000n, lastSlot: 1n } };
}

describe('computePumpSwapEntrySize', () => {
  const limits = buildEffectiveRiskLimits(realConfig());

  it('pool funda: tamanho cheio, quoteAmountIn = líquido do buy_exact_quote_in, impacto = preço médio sem taxa ÷ marginal − 1', () => {
    const r = computePumpSwapEntrySize(DEEP, limits, BPS);
    const sim = pumpSwapBuyExactQuoteIn(DEEP, limits.sizeLamports, BPS);
    expect(r).toMatchObject({ ok: true, sizeLamports: limits.sizeLamports, quoteAmountIn: sim.netQuoteIn, reduced: false });
    const expected = Number(sim.netQuoteIn * DEEP.base) / Number(sim.baseOut * effectiveQuoteReserves(DEEP)) - 1;
    expect(r.priceImpactPct).toBeCloseTo(expected, 12);
    expect(r.priceImpactPct).toBeGreaterThan(0);
  });

  it('impacto cresce com o tamanho; pool rasa reduz ou rejeita (maxOwnPriceImpactPct)', () => {
    expect(pumpSwapImpactPct(DEEP, 10_000_000n, BPS)).toBeLessThan(pumpSwapImpactPct(DEEP, 50_000_000n, BPS));
    const thin = computePumpSwapEntrySize(THIN, limits, BPS);
    if (thin.ok) {
      expect(thin.reduced).toBe(true);
      expect(thin.priceImpactPct).toBeLessThanOrEqual(limits.maxOwnPriceImpactPct);
    } else {
      expect(thin.reason).toBe('maxOwnPriceImpactPct');
    }
  });
});

describe('approveEntry — token graduado', () => {
  const mint = 'mintA';
  function input(overrides: Partial<ApproveEntryInput> = {}): ApproveEntryInput {
    return {
      decision: enterDecision(mint),
      token: graduated(tokenOf(marketWithToken(mint), mint)),
      runId: 'run-1',
      limits: buildEffectiveRiskLimits(realConfig()),
      fees: FEES,
      riskState: createRiskState(NOW),
      portfolio: { openMints: new Set(), openExposureLamports: 0n },
      killSwitch: { lastStreamEventMs: NOW - 100, balance: null, stopFilePresent: false },
      ...overrides,
    };
  }

  it('sem pumpSwapEnabled: curve_unavailable (comportamento da v0.1)', () => {
    expect(approveEntry(input(), fixedClock(NOW)).result).toMatchObject({ approved: false, reason: 'curve_unavailable' });
  });

  it('com pumpSwapEnabled: aprova com o sizing do PumpSwap', () => {
    const { result } = approveEntry(input({ pumpSwapEnabled: true }), fixedClock(NOW));
    expect(result).toMatchObject({ approved: true, sizeLamports: 50_000_000n, quoteAmountIn: pumpSwapBuyExactQuoteIn(DEEP, 50_000_000n, BPS).netQuoteIn });
  });

  it('com pumpSwapEnabled mas sem offset/bps conhecidos: curve_unavailable (não precifica com dado incompleto)', () => {
    const t = graduated(tokenOf(marketWithToken(mint), mint));
    const incomplete: TokenState = { ...t, pumpSwapReserves: t.pumpSwapReserves ? { ...t.pumpSwapReserves, virtualQuote: null, feeBps: null } : null };
    expect(approveEntry(input({ pumpSwapEnabled: true, token: incomplete }), fixedClock(NOW)).result).toMatchObject({ approved: false, reason: 'curve_unavailable' });
  });
});
