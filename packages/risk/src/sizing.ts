import type { Lamports } from '@memebot/core';
import { bondingCurveBuy, feeFromBps } from '@memebot/curve-math';
import type { CurveFeeBps, CurveReserves } from '@memebot/curve-math';
import type { EffectiveRiskLimits } from './limits.ts';

/**
 * Maior `quoteAmountIn` (valor que entra na curva) tal que `quoteAmountIn + protocolFee + creatorFee`
 * (o total pago, `totalQuoteCost` de `bondingCurveBuy`) caiba em `budget`. O "tamanho" da posição é
 * sempre esse total pago à curva com as taxas da curva — é o que é comparado com
 * `maxPositionLamports`. Priority fee, tip e rent são custos à parte, com limites próprios.
 */
export function quoteInForBudget(budget: Lamports, fees: CurveFeeBps): Lamports {
  if (budget <= 0n) return 0n;
  const totalBps = 10_000n + fees.protocolFeeBps + fees.creatorFeeBps;
  let quoteIn = (budget * 10_000n) / totalBps;
  // As taxas são arredondadas para cima (feeFromBps): no máximo poucas unidades a mais.
  while (quoteIn > 0n && quoteIn + feeFromBps(quoteIn, fees.protocolFeeBps) + feeFromBps(quoteIn, fees.creatorFeeBps) > budget) {
    quoteIn -= 1n;
  }
  return quoteIn;
}

/**
 * Impacto de preço da própria compra (escolha documentada): preço médio de execução SEM taxas
 * (`quoteAmountIn / tokenOut`) comparado ao preço marginal antes da compra (`virtualQuote /
 * virtualToken`): `impacto = (quoteIn × virtualToken) / (tokenOut × virtualQuote) − 1`.
 *
 * Alternativa considerada: preço marginal depois ÷ antes (≈ 2× o valor acima no constant product).
 * Ficamos com o preço médio porque é o custo que NÓS pagamos pelo tamanho (o marginal depois mede o
 * preço que deixamos para o próximo comprador); taxas ficam fora porque já são contadas à parte no
 * PnL líquido e não dependem do tamanho.
 */
export function ownPriceImpactPct(reserves: CurveReserves, quoteAmountIn: Lamports, fees: CurveFeeBps): number {
  if (quoteAmountIn <= 0n) return 0;
  const { tokenOut } = bondingCurveBuy(reserves, quoteAmountIn, fees);
  if (tokenOut <= 0n) return Number.POSITIVE_INFINITY;
  return Number(quoteAmountIn * reserves.virtualToken) / Number(tokenOut * reserves.virtualQuote) - 1;
}

export type EntrySizeResult =
  | { ok: true; sizeLamports: Lamports; quoteAmountIn: Lamports; priceImpactPct: number; reduced: boolean }
  | { ok: false; reason: 'maxOwnPriceImpactPct' | 'size_too_small'; priceImpactPct: number };

function impactForBudget(reserves: CurveReserves, budget: Lamports, fees: CurveFeeBps): number {
  return ownPriceImpactPct(reserves, quoteInForBudget(budget, fees), fees);
}

/**
 * Sizing (docs/STRATEGY.md §5): tamanho fixo `limits.sizeLamports` (já ≤ hard limit). Se o impacto
 * da própria compra passar de `maxOwnPriceImpactPct`, reduz por busca binária determinística (em
 * lamports inteiros; o impacto cresce monotonicamente com o tamanho) até o maior tamanho que cabe.
 * Critério de "irrisório": se esse tamanho for menor que `minSizeFraction × sizeLamports`, rejeita
 * com `maxOwnPriceImpactPct` — os custos fixos por transação (priority fee, tip, rent) não encolhem
 * com o tamanho, então uma entrada muito menor que a planejada é outra aposta, pior.
 */
export function computeEntrySize(reserves: CurveReserves, limits: EffectiveRiskLimits, fees: CurveFeeBps): EntrySizeResult {
  const budget = limits.sizeLamports;
  const fullQuoteIn = quoteInForBudget(budget, fees);
  if (fullQuoteIn <= 0n) return { ok: false, reason: 'size_too_small', priceImpactPct: 0 };

  const fullImpact = ownPriceImpactPct(reserves, fullQuoteIn, fees);
  if (fullImpact <= limits.maxOwnPriceImpactPct) {
    return { ok: true, sizeLamports: budget, quoteAmountIn: fullQuoteIn, priceImpactPct: fullImpact, reduced: false };
  }

  const fractionPpm = BigInt(Math.round(limits.minSizeFraction * 1_000_000));
  const minBudget = (budget * fractionPpm + 999_999n) / 1_000_000n;
  const minImpact = impactForBudget(reserves, minBudget, fees);
  if (minBudget <= 0n || quoteInForBudget(minBudget, fees) <= 0n || minImpact > limits.maxOwnPriceImpactPct) {
    return { ok: false, reason: 'maxOwnPriceImpactPct', priceImpactPct: fullImpact };
  }

  // Invariante: impacto(lo) ≤ máx < impacto(hi).
  let lo = minBudget;
  let hi = budget;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (impactForBudget(reserves, mid, fees) <= limits.maxOwnPriceImpactPct) lo = mid;
    else hi = mid;
  }
  const quoteAmountIn = quoteInForBudget(lo, fees);
  return {
    ok: true,
    sizeLamports: lo,
    quoteAmountIn,
    priceImpactPct: ownPriceImpactPct(reserves, quoteAmountIn, fees),
    reduced: true,
  };
}
