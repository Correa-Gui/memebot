import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bondingCurveBuy } from '@memebot/curve-math';
import {
  HARD_LIMITS,
  HardLimitExceededError,
  InvalidRiskConfigError,
  KILL_SWITCH_DEFAULTS,
  approveEntry,
  assertWithinHardLimits,
  buildEffectiveRiskLimits,
  computeEntrySize,
  createRiskState,
  dailyRealizedLoss,
  evaluateKillSwitch,
  isStopFilePresent,
  nextDecisionId,
  ownPriceImpactPct,
  quoteInForBudget,
  recordRealizedPnl,
  recordTxOutcome,
} from '../src/index.ts';
import type { ApproveEntryInput, KillSwitchInputs } from '../src/index.ts';
import { FEES, INITIAL_VIRTUAL_QUOTE, INITIAL_VIRTUAL_TOKEN, NOW, enterDecision, fixedClock, marketWithToken, realConfig, tokenOf } from './helpers.ts';

describe('hard-limits.ts', () => {
  it('tem exatamente os valores de docs/RISK_AND_SECURITY.md §2', () => {
    expect(HARD_LIMITS).toEqual({
      maxPositionLamports: 50_000_000n,
      maxOpenPositions: 3,
      maxDailyLossLamports: 200_000_000n,
      maxHotWalletLamports: 1_000_000_000n,
      maxSlippageBps: 1500,
      maxPriorityFeeLamports: 2_000_000n,
      maxJitoTipLamports: 2_000_000n,
    });
  });
});

describe('buildEffectiveRiskLimits — a config só reduz', () => {
  it('aceita o config/strategy.v0.yaml real (sizeSol 0.05 = hard limit)', () => {
    const limits = buildEffectiveRiskLimits(realConfig());
    expect(limits.sizeLamports).toBe(50_000_000n);
    expect(limits.maxDailyLossLamports).toBe(200_000_000n);
    expect(limits.maxOpenPositions).toBe(3);
    expect(limits.maxSlippageBps).toBe(HARD_LIMITS.maxSlippageBps);
    expect(() => { assertWithinHardLimits(limits); }).not.toThrow();
  });

  it('sizeSol acima do hard limit é erro explícito, não clamp', () => {
    const cfg = realConfig();
    expect(() => buildEffectiveRiskLimits({ ...cfg, sizing: { ...cfg.sizing, sizeSol: 0.1 } })).toThrow(HardLimitExceededError);
    try {
      buildEffectiveRiskLimits({ ...cfg, sizing: { ...cfg.sizing, sizeSol: 0.1 } });
    } catch (e) {
      expect(e).toBeInstanceOf(HardLimitExceededError);
      expect((e as HardLimitExceededError).limitKey).toBe('sizing.sizeSol');
    }
  });

  it('maxDailyLossSol e maxOpenPositions acima do hard limit são erro', () => {
    const cfg = realConfig();
    expect(() => buildEffectiveRiskLimits({ ...cfg, risk: { ...cfg.risk, maxDailyLossSol: 0.21 } })).toThrow(HardLimitExceededError);
    expect(() => buildEffectiveRiskLimits({ ...cfg, risk: { ...cfg.risk, maxOpenPositions: 4 } })).toThrow(HardLimitExceededError);
  });

  it('overrides acima do hard limit são erro; abaixo reduzem', () => {
    const cfg = realConfig();
    expect(() => buildEffectiveRiskLimits(cfg, { maxSlippageBps: 1501 })).toThrow(HardLimitExceededError);
    expect(() => buildEffectiveRiskLimits(cfg, { maxPriorityFeeLamports: 2_000_001n })).toThrow(HardLimitExceededError);
    expect(() => buildEffectiveRiskLimits(cfg, { maxJitoTipLamports: 2_000_001n })).toThrow(HardLimitExceededError);
    expect(() => buildEffectiveRiskLimits(cfg, { maxHotWalletLamports: 1_000_000_001n })).toThrow(HardLimitExceededError);
    const reduced = buildEffectiveRiskLimits({ ...cfg, sizing: { ...cfg.sizing, sizeSol: 0.02 } }, { maxSlippageBps: 500 });
    expect(reduced.sizeLamports).toBe(20_000_000n);
    expect(reduced.maxSlippageBps).toBe(500);
  });

  it('recusa precisão abaixo de 1 lamport', () => {
    const cfg = realConfig();
    expect(() => buildEffectiveRiskLimits({ ...cfg, sizing: { ...cfg.sizing, sizeSol: 0.0000000001 } })).toThrow(InvalidRiskConfigError);
  });
});

describe('sizing', () => {
  it('quoteInForBudget: total pago com taxas cabe no orçamento e é o máximo possível', () => {
    for (const budget of [1_000n, 49_999_999n, 50_000_000n, 123_456_789n]) {
      const q = quoteInForBudget(budget, FEES);
      const total = bondingCurveBuy({ virtualQuote: INITIAL_VIRTUAL_QUOTE, virtualToken: INITIAL_VIRTUAL_TOKEN }, q, FEES).totalQuoteCost;
      expect(total).toBeLessThanOrEqual(budget);
      const totalPlusOne = bondingCurveBuy({ virtualQuote: INITIAL_VIRTUAL_QUOTE, virtualToken: INITIAL_VIRTUAL_TOKEN }, q + 1n, FEES).totalQuoteCost;
      expect(totalPlusOne).toBeGreaterThan(budget);
    }
  });

  it('nas reservas iniciais reais, 0,05 SOL tem impacto ~0,17% e entra inteiro', () => {
    const limits = buildEffectiveRiskLimits(realConfig());
    const r = computeEntrySize({ virtualQuote: INITIAL_VIRTUAL_QUOTE, virtualToken: INITIAL_VIRTUAL_TOKEN }, limits, FEES);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sizeLamports).toBe(50_000_000n);
      expect(r.reduced).toBe(false);
      expect(r.priceImpactPct).toBeGreaterThan(0.0016);
      expect(r.priceImpactPct).toBeLessThan(0.0018);
    }
  });

  it('impacto acima do máximo reduz o tamanho até o maior que cabe (busca binária determinística)', () => {
    const limits = buildEffectiveRiskLimits(realConfig());
    const reserves = { virtualQuote: 2_000_000_000n, virtualToken: 70_000_000_000_000n };
    const r = computeEntrySize(reserves, limits, FEES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reduced).toBe(true);
    expect(r.sizeLamports).toBeLessThan(limits.sizeLamports);
    expect(r.priceImpactPct).toBeLessThanOrEqual(limits.maxOwnPriceImpactPct);
    expect(ownPriceImpactPct(reserves, quoteInForBudget(r.sizeLamports + 1n, FEES), FEES)).toBeGreaterThan(limits.maxOwnPriceImpactPct);
    expect(computeEntrySize(reserves, limits, FEES)).toEqual(r);
  });

  it('rejeita se o tamanho reduzido ficaria abaixo de minSizeFraction × sizeLamports', () => {
    const limits = buildEffectiveRiskLimits(realConfig());
    const r = computeEntrySize({ virtualQuote: 500_000_000n, virtualToken: 17_000_000_000_000n }, limits, FEES);
    expect(r).toMatchObject({ ok: false, reason: 'maxOwnPriceImpactPct' });
  });
});

describe('kill switch (RISK §3)', () => {
  const base: KillSwitchInputs = {
    nowMs: NOW,
    dailyRealizedLossLamports: 0n,
    consecutiveTxFailures: 0,
    lastStreamEventMs: NOW - 1_000,
    balance: null,
    stopFilePresent: false,
  };
  const max = HARD_LIMITS.maxDailyLossLamports;

  it('inativo em condições normais (balance null = paper, gatilho de saldo desligado)', () => {
    expect(evaluateKillSwitch(base, max)).toEqual({ active: false, reasons: [] });
  });

  it('perda do dia ≥ limite', () => {
    expect(evaluateKillSwitch({ ...base, dailyRealizedLossLamports: max - 1n }, max).active).toBe(false);
    expect(evaluateKillSwitch({ ...base, dailyRealizedLossLamports: max }, max).reasons).toEqual(['daily_loss']);
  });

  it('5 falhas de transação seguidas', () => {
    expect(evaluateKillSwitch({ ...base, consecutiveTxFailures: 4 }, max).active).toBe(false);
    expect(evaluateKillSwitch({ ...base, consecutiveTxFailures: 5 }, max).reasons).toEqual(['consecutive_failures']);
  });

  it('stream sem eventos por 30 s (e nenhum evento ainda)', () => {
    expect(evaluateKillSwitch({ ...base, lastStreamEventMs: NOW - 29_999 }, max).active).toBe(false);
    expect(evaluateKillSwitch({ ...base, lastStreamEventMs: NOW - 30_000 }, max).reasons).toEqual(['stream_stale']);
    expect(evaluateKillSwitch({ ...base, lastStreamEventMs: null }, max).reasons).toEqual(['stream_stale']);
  });

  it('divergência de saldo > 1% (só live)', () => {
    const ok = { expectedLamports: 1_000_000_000n, onchainLamports: 990_000_000n }; // exatamente 1%
    const bad = { expectedLamports: 1_000_000_000n, onchainLamports: 989_999_999n };
    expect(evaluateKillSwitch({ ...base, balance: ok }, max).active).toBe(false);
    expect(evaluateKillSwitch({ ...base, balance: bad }, max).reasons).toEqual(['balance_divergence']);
    expect(evaluateKillSwitch({ ...base, balance: { expectedLamports: 1_000_000_000n, onchainLamports: 1_010_000_001n } }, max).active).toBe(true);
  });

  it('arquivo data/STOP', () => {
    expect(evaluateKillSwitch({ ...base, stopFilePresent: true }, max).reasons).toEqual(['stop_file']);
  });

  it('defaults são os de RISK §3', () => {
    expect(KILL_SWITCH_DEFAULTS).toEqual({ maxConsecutiveTxFailures: 5, streamStaleMs: 30_000, maxBalanceDivergenceBps: 100n });
  });
});

describe('adaptador isStopFilePresent', () => {
  it('reflete a existência do arquivo num diretório temporário', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'memebot-stop-'));
    const file = path.join(dir, 'STOP');
    expect(isStopFilePresent(file)).toBe(false);
    writeFileSync(file, '');
    expect(isStopFilePresent(file)).toBe(true);
  });
});

describe('RiskState', () => {
  it('perda diária vira no dia UTC', () => {
    const dayStart = Date.UTC(2026, 9, 1);
    let s = createRiskState(dayStart + 1_000);
    s = recordRealizedPnl(s, -150_000_000n, dayStart + 2_000);
    s = recordRealizedPnl(s, 20_000_000n, dayStart + 3_000);
    expect(dailyRealizedLoss(s, dayStart + 4_000)).toBe(130_000_000n);
    expect(dailyRealizedLoss(s, dayStart + 86_400_000)).toBe(0n); // meia-noite UTC
    s = recordRealizedPnl(s, -10n, dayStart + 86_400_000 + 1);
    expect(s.dailyRealizedPnlLamports).toBe(-10n);
  });

  it('falhas seguidas: failed/expired somam, filled zera', () => {
    let s = createRiskState(NOW);
    s = recordTxOutcome(recordTxOutcome(s, 'failed'), 'expired');
    expect(s.consecutiveTxFailures).toBe(2);
    expect(recordTxOutcome(s, 'filled').consecutiveTxFailures).toBe(0);
  });

  it('decisionId é determinístico e único no run', () => {
    const s = createRiskState(NOW);
    const a = nextDecisionId(s, 'run-1', 'mintA', NOW);
    const b = nextDecisionId(a.state, 'run-1', 'mintA', NOW);
    expect(a.decisionId).toBe(`run-1:mintA:${String(NOW)}:1`);
    expect(b.decisionId).not.toBe(a.decisionId);
    expect(nextDecisionId(s, 'run-1', 'mintA', NOW)).toEqual(a);
  });
});

describe('approveEntry', () => {
  const mint = 'mintA';
  function input(overrides: Partial<ApproveEntryInput> = {}): ApproveEntryInput {
    const market = marketWithToken(mint);
    return {
      decision: enterDecision(mint),
      token: tokenOf(market, mint),
      runId: 'run-1',
      limits: buildEffectiveRiskLimits(realConfig()),
      fees: FEES,
      riskState: createRiskState(NOW),
      portfolio: { openMints: new Set(), openExposureLamports: 0n },
      killSwitch: { lastStreamEventMs: NOW - 100, balance: null, stopFilePresent: false },
      ...overrides,
    };
  }

  it('aprova com tamanho fixo, slippage máx. e decisionId determinístico', () => {
    const { result, riskState } = approveEntry(input(), fixedClock(NOW));
    expect(result).toMatchObject({ approved: true, mint, sizeLamports: 50_000_000n, maxSlippageBps: 1500, decisionId: `run-1:${mint}:${String(NOW)}:1` });
    expect(riskState.decisionSeq).toBe(1);
    expect(approveEntry(input(), fixedClock(NOW))).toEqual({ result, riskState });
  });

  it('kill switch bloqueia entrada, com o gatilho no motivo', () => {
    const stop = approveEntry(input({ killSwitch: { lastStreamEventMs: NOW, balance: null, stopFilePresent: true } }), fixedClock(NOW));
    expect(stop.result).toMatchObject({ approved: false, reason: 'kill_switch:stop_file' });

    const lossState = recordRealizedPnl(createRiskState(NOW), -200_000_000n, NOW);
    expect(approveEntry(input({ riskState: lossState }), fixedClock(NOW)).result).toMatchObject({ reason: 'kill_switch:daily_loss' });

    let failState = createRiskState(NOW);
    for (let i = 0; i < 5; i++) failState = recordTxOutcome(failState, 'failed');
    expect(approveEntry(input({ riskState: failState }), fixedClock(NOW)).result).toMatchObject({ reason: 'kill_switch:consecutive_failures' });

    const stale = input({ killSwitch: { lastStreamEventMs: NOW - 30_000, balance: null, stopFilePresent: false } });
    expect(approveEntry(stale, fixedClock(NOW)).result).toMatchObject({ reason: 'kill_switch:stream_stale' });
  });

  it('posição já aberta, máximo de posições e exposição da carteira', () => {
    expect(approveEntry(input({ portfolio: { openMints: new Set([mint]), openExposureLamports: 0n } }), fixedClock(NOW)).result)
      .toMatchObject({ reason: 'position_already_open' });
    expect(approveEntry(input({ portfolio: { openMints: new Set(['a', 'b', 'c']), openExposureLamports: 0n } }), fixedClock(NOW)).result)
      .toMatchObject({ reason: 'maxOpenPositions' });
    expect(approveEntry(input({ portfolio: { openMints: new Set(['a']), openExposureLamports: 960_000_000n } }), fixedClock(NOW)).result)
      .toMatchObject({ reason: 'maxHotWalletLamports' });
  });

  it('curva indisponível: sem token, completada ou já no PumpSwap', () => {
    expect(approveEntry(input({ token: undefined }), fixedClock(NOW)).result).toMatchObject({ reason: 'curve_unavailable' });
    const token = tokenOf(marketWithToken(mint), mint);
    expect(approveEntry(input({ token: { ...token, curveCompleted: true } }), fixedClock(NOW)).result).toMatchObject({ reason: 'curve_unavailable' });
    expect(approveEntry(input({ token: { ...token, venue: 'pumpswap' } }), fixedClock(NOW)).result).toMatchObject({ reason: 'curve_unavailable' });
  });

  it('impacto alto demais rejeita com a chave do limite', () => {
    const token = tokenOf(marketWithToken(mint, 500_000_000n, 17_000_000_000_000n), mint);
    expect(approveEntry(input({ token }), fixedClock(NOW)).result).toMatchObject({ approved: false, reason: 'maxOwnPriceImpactPct' });
  });
});
