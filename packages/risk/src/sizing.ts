import type { Lamports } from '@memebot/core';
import { bondingCurveBuy, effectiveQuoteReserves, feeFromBps, pumpSwapBuyExactQuoteIn } from '@memebot/curve-math';
import type { CurveFeeBps, CurveReserves, PumpSwapFeeBps, PumpSwapReserves } from '@memebot/curve-math';
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
  return sizeWith(limits, (budget) => quoteInForBudget(budget, fees), (budget) => impactForBudget(reserves, budget, fees));
}

/** Busca do tamanho, comum à curva e ao PumpSwap: `quoteInFor`/`impactFor` dão o valor no swap e o impacto de um orçamento. */
function sizeWith(limits: EffectiveRiskLimits, quoteInFor: (budget: Lamports) => Lamports, impactFor: (budget: Lamports) => number): EntrySizeResult {
  const budget = limits.sizeLamports;
  const fullQuoteIn = quoteInFor(budget);
  if (fullQuoteIn <= 0n) return { ok: false, reason: 'size_too_small', priceImpactPct: 0 };

  const fullImpact = impactFor(budget);
  if (fullImpact <= limits.maxOwnPriceImpactPct) {
    return { ok: true, sizeLamports: budget, quoteAmountIn: fullQuoteIn, priceImpactPct: fullImpact, reduced: false };
  }

  const fractionPpm = BigInt(Math.round(limits.minSizeFraction * 1_000_000));
  const minBudget = (budget * fractionPpm + 999_999n) / 1_000_000n;
  if (minBudget <= 0n || quoteInFor(minBudget) <= 0n || impactFor(minBudget) > limits.maxOwnPriceImpactPct) {
    return { ok: false, reason: 'maxOwnPriceImpactPct', priceImpactPct: fullImpact };
  }

  // Invariante: impacto(lo) ≤ máx < impacto(hi).
  let lo = minBudget;
  let hi = budget;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (impactFor(mid) <= limits.maxOwnPriceImpactPct) lo = mid;
    else hi = mid;
  }
  return { ok: true, sizeLamports: lo, quoteAmountIn: quoteInFor(lo), priceImpactPct: impactFor(lo), reduced: true };
}

/**
 * PumpSwap (universo graduado, só replay por enquanto): a compra simulada é `buy_exact_quote_in` com
 * `spendable = orçamento` (o total debitado — líquido + todas as taxas — nunca passa do orçamento).
 * Impacto com a mesma definição da curva: preço médio SEM taxas (`líquido / baseOut`) ÷ preço marginal
 * antes (`Qe / B`) − 1. `quoteAmountIn` = líquido que entra no constant product.
 */
export function pumpSwapImpactPct(reserves: PumpSwapReserves, spendable: Lamports, fees: PumpSwapFeeBps): number {
  try {
    const sim = pumpSwapBuyExactQuoteIn(reserves, spendable, fees);
    return Number(sim.netQuoteIn * reserves.base) / Number(sim.baseOut * effectiveQuoteReserves(reserves)) - 1;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function pumpSwapNetQuoteIn(reserves: PumpSwapReserves, spendable: Lamports, fees: PumpSwapFeeBps): Lamports {
  try {
    return spendable > 0n ? pumpSwapBuyExactQuoteIn(reserves, spendable, fees).netQuoteIn : 0n;
  } catch {
    return 0n;
  }
}

export function computePumpSwapEntrySize(reserves: PumpSwapReserves, limits: EffectiveRiskLimits, fees: PumpSwapFeeBps): EntrySizeResult {
  return sizeWith(limits, (budget) => pumpSwapNetQuoteIn(reserves, budget, fees), (budget) => pumpSwapImpactPct(reserves, budget, fees));
}
