import type { Lamports } from '@memebot/core';
import type { CostEstimateSource } from './fill.ts';

/** Uma linha de `tx_costs` (só os campos usados). `jitoTip` null = contas de tip indisponíveis. */
export interface TxCostSample {
  priorityFee: Lamports;
  jitoTip: Lamports | null;
}

export interface TxCostEstimateParams {
  /** `PAPER_COST_MIN_SAMPLES`: abaixo disso a mediana não é confiável → fallback. */
  minSamples: number;
  fallbackPriorityFeeLamports: Lamports;
  fallbackJitoTipLamports: Lamports;
}

export interface TxCostEstimate {
  priorityFeeLamports: Lamports;
  jitoTipLamports: Lamports;
  priorityFeeSource: CostEstimateSource;
  jitoTipSource: CostEstimateSource;
  /** Amostras usadas para a priority fee / para o tip (só as que pagaram tip > 0). */
  prioritySampleCount: number;
  tipSampleCount: number;
}

/** Mediana; com nº par de valores, média dos dois do meio arredondada para cima (pessimista). */
export function medianLamports(values: readonly Lamports[]): Lamports {
  if (values.length === 0) throw new RangeError('medianLamports: lista vazia');
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0n;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? 0n;
  return (lower + upper + 1n) / 2n;
}

/** `ceil(x × 1,5)` em bigint. */
function timesOneAndHalf(x: Lamports): Lamports {
  return (x * 3n + 1n) / 2n;
}

/**
 * Estimativa de custos do paper (ARCHITECTURE §5): mediana das amostras de `tx_costs` × 1,5.
 * - Priority fee: todas as amostras.
 * - Tip: só amostras com tip > 0 — o live vai mandar via Jito com tip; a mediana sobre transações
 *   que não usaram Jito (tip 0) subestimaria o custo.
 * Com menos de `minSamples` amostras, usa o fallback configurado e marca a origem (`'fallback'`).
 * O limite (hard limit / config) NÃO é aplicado aqui: o executor aplica e marca `costCappedByHardLimit`.
 */
export function estimateTxCosts(samples: readonly TxCostSample[], params: TxCostEstimateParams): TxCostEstimate {
  const priorityValues = samples.map((s) => s.priorityFee);
  const tipValues = samples.flatMap((s) => (s.jitoTip !== null && s.jitoTip > 0n ? [s.jitoTip] : []));

  const priorityFromSamples = priorityValues.length >= params.minSamples;
  const tipFromSamples = tipValues.length >= params.minSamples;

  return {
    priorityFeeLamports: priorityFromSamples ? timesOneAndHalf(medianLamports(priorityValues)) : params.fallbackPriorityFeeLamports,
    jitoTipLamports: tipFromSamples ? timesOneAndHalf(medianLamports(tipValues)) : params.fallbackJitoTipLamports,
    priorityFeeSource: priorityFromSamples ? 'tx_costs_median' : 'fallback',
    jitoTipSource: tipFromSamples ? 'tx_costs_median' : 'fallback',
    prioritySampleCount: priorityValues.length,
    tipSampleCount: tipValues.length,
  };
}
