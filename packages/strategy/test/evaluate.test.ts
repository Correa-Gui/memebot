import { fileURLToPath } from 'node:url';
import type { Clock } from '@memebot/core';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate.ts';
import { loadStrategyConfig } from '../src/config.ts';
import { CURVE_PARAMS, buildScenario } from './helpers.ts';

function clockAt(nowMs: number): Clock {
  return { nowMs: () => nowMs, slot: () => 0n };
}

describe('evaluate — cenário que passa em todos os filtros e no gatilho', () => {
  it('produz uma decisão de entrada com o snapshot de features', () => {
    const { state, mint, nowMs, config } = buildScenario();
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome: 'enter', mint, reason: 'momentum_trigger' });
    const enter = decisions[0];
    if (!enter || enter.outcome !== 'enter') throw new Error('esperava enter');
    expect(enter.features.uniqueHolders).toBe(3);
    expect(enter.features.buySellVolumeRatio60s).toBeGreaterThan(1.5);
  });
});

describe('evaluate — com o config/strategy.v0.yaml real do repositório', () => {
  const realConfig = loadStrategyConfig(fileURLToPath(new URL('../../../config/strategy.v0.yaml', import.meta.url)));

  it('parseia o arquivo real', () => {
    expect(realConfig.version).toBe('v0.1');
    expect(realConfig.filters.allowedVenues).toEqual(['curve']);
  });

  it('aprova um token que cumpre os limiares reais (40 holders, 15 compradores/60s, ≥ 5 SOL)', () => {
    const { state, mint, nowMs } = buildScenario({ extraHolderCount: 40, numWindowBuyers: 15 });
    const decisions = evaluate(state, mint, clockAt(nowMs), realConfig, CURVE_PARAMS);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome: 'enter', mint, reason: 'momentum_trigger' });
  });

  it('rejeita, com o motivo exato, um token abaixo de minUniqueHolders real (40)', () => {
    const { state, mint, nowMs } = buildScenario({ extraHolderCount: 10, numWindowBuyers: 15 });
    const decisions = evaluate(state, mint, clockAt(nowMs), realConfig, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'minUniqueHolders' }]);
  });
});

describe('evaluate — universo (docs/STRATEGY.md §2)', () => {
  it('rejeita venue fora de allowedVenues com o motivo "venue_not_allowed"', () => {
    const { state, mint, nowMs, config } = buildScenario({ venue: 'pumpswap' });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'venue_not_allowed' }]);
  });

  it('rejeita quote mint fora de allowedQuoteMints com o motivo "allowedQuoteMints"', () => {
    const { state, mint, nowMs, config } = buildScenario({ quoteMint: 'SomeOtherQuoteMint11111111111111111111111' });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'allowedQuoteMints' }]);
  });

  it('rejeita token mais novo que minAgeSec com o motivo "minAgeSec"', () => {
    const { state, mint, nowMs, config } = buildScenario({ ageSec: 30 });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'minAgeSec' }]);
  });

  it('rejeita token mais velho que maxAgeSec com o motivo "maxAgeSec"', () => {
    const { state, mint, nowMs, config } = buildScenario({ ageSec: 700 });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'maxAgeSec' }]);
  });
});

describe('evaluate — filtros duros (docs/STRATEGY.md §3)', () => {
  it('rejeita concentração do top10 acima do limite com o motivo "maxTop10PctSupply"', () => {
    const { state, mint, nowMs, config } = buildScenario({ topHolderAmount: 350_000n });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'maxTop10PctSupply' }]);
  });

  it('rejeita % comprado no mesmo slot da criação acima do limite com o motivo "maxSameSlotAsCreatePct"', () => {
    const { state, mint, nowMs, config } = buildScenario({ sameSlotAmount: 150_000n });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'maxSameSlotAsCreatePct' }]);
  });

  it('v0.1: compra inicial grande do CRIADOR no slot de criação não é bundle — cai no filtro de criador', () => {
    const { state, mint, nowMs, config } = buildScenario({ creatorHoldingAmount: 150_000n, creatorBuysInCreationSlot: true });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'maxCreatorHoldingPct' }]);
  });

  it('v0.1: compra inicial pequena do criador no slot de criação entra no snapshot como creatorInitialBuyPct', () => {
    const { state, mint, nowMs, config } = buildScenario({ creatorHoldingAmount: 40_000n, creatorBuysInCreationSlot: true });
    const [d] = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    if (d?.outcome !== 'enter') throw new Error('esperava enter');
    expect(d.features.sameSlotBuyPct).toBe(0);
    expect(d.features.creatorInitialBuyPct).toBeCloseTo(0.04, 9);
  });

  it('rejeita criador segurando acima do limite com o motivo "maxCreatorHoldingPct"', () => {
    const { state, mint, nowMs, config } = buildScenario({ creatorHoldingAmount: 60_000n });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'maxCreatorHoldingPct' }]);
  });

  it('rejeita criador com >= 3 tokens em 24h com o motivo "maxCreatorTokens24h"', () => {
    const { state, mint, nowMs, config } = buildScenario({ creatorOtherTokens24h: 3 });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'maxCreatorTokens24h' }]);
  });

  it('rejeita holders únicos abaixo do mínimo com o motivo "minUniqueHolders"', () => {
    const { state, mint, nowMs, config } = buildScenario({ extraHolderCount: 0 });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'minUniqueHolders' }]);
  });

  it('rejeita volume 60s abaixo do mínimo com o motivo "minVolume60sSol"', () => {
    const { state, mint, nowMs, config } = buildScenario({
      windowBuyQuoteEach: 100_000_000n,
      windowSellQuoteEach: 10_000_000n,
    });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'minVolume60sSol' }]);
  });

  it('nunca rejeita por maxRiskScore enquanto o modelo de risco não existir (CLAUDE.md §3: sinal ausente nunca bloqueia)', () => {
    const { state, mint, nowMs, config } = buildScenario();
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions[0]?.outcome).toBe('enter');
    const enter = decisions[0];
    if (enter?.outcome !== 'enter') throw new Error('esperava enter');
    expect(Number.isNaN(enter.features.riskScore)).toBe(true);
  });
});

describe('evaluate — gatilho de momentum (docs/STRATEGY.md §4)', () => {
  it('rejeita razão buy/sell abaixo do mínimo com o motivo "minBuySellVolumeRatio60s"', () => {
    const { state, mint, nowMs, config } = buildScenario({
      windowBuyQuoteEach: 2_000_000_000n,
      windowSellQuoteEach: 2_000_000_000n,
    });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'minBuySellVolumeRatio60s' }]);
  });

  it('rejeita compradores únicos abaixo do mínimo com o motivo "minUniqueBuyers60s"', () => {
    const { state, mint, nowMs, config } = buildScenario({ numWindowBuyers: 1 });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'minUniqueBuyers60s' }]);
  });

  it('rejeita preço abaixo da média de 120s com o motivo "requirePriceAboveMean120s"', () => {
    const { state, mint, nowMs, config } = buildScenario({ finalVirtualQuote: 1n, finalVirtualToken: 1_000_000n });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'requirePriceAboveMean120s' }]);
  });

  it('rejeita venda individual acima do limite com o motivo "maxSingleSellPctSupply60s"', () => {
    const { state, mint, nowMs, config } = buildScenario({ windowTokenEach: 50_000n });
    const decisions = evaluate(state, mint, clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint, reason: 'maxSingleSellPctSupply60s' }]);
  });
});

describe('evaluate — casos estruturais', () => {
  it('rejeita mint desconhecido com o motivo "mint_not_found"', () => {
    const { state, nowMs, config } = buildScenario();
    const decisions = evaluate(state, 'mint-que-nao-existe', clockAt(nowMs), config, CURVE_PARAMS);
    expect(decisions).toEqual([{ outcome: 'reject', mint: 'mint-que-nao-existe', reason: 'mint_not_found' }]);
  });
});
