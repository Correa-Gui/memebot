import type { Lamports } from '@memebot/core';
import type { TxCostSource } from './fill.ts';

/** Uma linha de `tx_costs` (só os campos usados). `jitoTip` null = contas de tip indisponíveis. */
export interface TxCostSample {
  priorityFee: Lamports;
  jitoTip: Lamports | null;
}

export interface TxCostEstimateParams {
  /**
   * `PAPER_COST_MIN_SAMPLES`, POR TIPO de custo: com ≥ mínimo usa a mediana; com 1..mínimo−1 usa o p75
   * das amostras disponíveis; com zero, o fallback configurado.
   */
  minSamples: number;
  fallbackPriorityFeeLamports: Lamports;
  fallbackJitoTipLamports: Lamports;
}

export interface TxCostEstimate {
  priorityFeeLamports: Lamports;
  jitoTipLamports: Lamports;
  priorityFeeSource: TxCostSource;
  jitoTipSource: TxCostSource;
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

/**
 * Percentil 75 (nearest-rank, arredondando o posto para cima: pessimista com poucas amostras):
 * o valor na posição `ceil(0,75 × n)` (1-indexada) da lista ordenada.
 */
export function p75Lamports(values: readonly Lamports[]): Lamports {
  if (values.length === 0) throw new RangeError('p75Lamports: lista vazia');
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.ceil(0.75 * sorted.length);
  return sorted[rank - 1] ?? sorted[sorted.length - 1] ?? 0n;
}

/** `ceil(x × 1,5)` em bigint. */
function timesOneAndHalf(x: Lamports): Lamports {
  return (x * 3n + 1n) / 2n;
}

/**
 * Estimativa de UM tipo de custo (priority fee ou tip), com o mínimo de amostras por tipo:
 * - ≥ `minSamples`: mediana × 1,5 → `tx_costs_median`;
 * - 1..`minSamples`−1: p75 das amostras disponíveis × 1,5 → `tx_costs_p75`. O × 1,5 é mantido de
 *   propósito: com poucas amostras o p75 é ruidoso e o paper tem de ser pessimista (ARCHITECTURE §5);
 *   aplicar o mesmo fator da mediana mantém as duas origens comparáveis (p75 ≥ mediana sempre);
 * - 0 amostras: fallback configurado → `fallback`.
 */
export function estimateOneCost(values: readonly Lamports[], minSamples: number, fallback: Lamports): { lamports: Lamports; source: TxCostSource } {
  if (values.length === 0) return { lamports: fallback, source: 'fallback' };
  if (values.length >= minSamples) return { lamports: timesOneAndHalf(medianLamports(values)), source: 'tx_costs_median' };
  return { lamports: timesOneAndHalf(p75Lamports(values)), source: 'tx_costs_p75' };
}

/**
 * Estimativa de custos do paper (ARCHITECTURE §5), por tipo (`estimateOneCost`):
 * - Priority fee: todas as amostras.
 * - Tip: só amostras com tip > 0 — o live vai mandar via Jito com tip; a mediana sobre transações
 *   que não usaram Jito (tip 0) subestimaria o custo.
 * O limite (hard limit / config) NÃO é aplicado aqui: o executor aplica e marca `costCappedByHardLimit`.
 */
export function estimateTxCosts(samples: readonly TxCostSample[], params: TxCostEstimateParams): TxCostEstimate {
  const priorityValues = samples.map((s) => s.priorityFee);
  const tipValues = samples.flatMap((s) => (s.jitoTip !== null && s.jitoTip > 0n ? [s.jitoTip] : []));
  const priority = estimateOneCost(priorityValues, params.minSamples, params.fallbackPriorityFeeLamports);
  const tip = estimateOneCost(tipValues, params.minSamples, params.fallbackJitoTipLamports);
  return {
    priorityFeeLamports: priority.lamports,
    jitoTipLamports: tip.lamports,
    priorityFeeSource: priority.source,
    jitoTipSource: tip.source,
    prioritySampleCount: priorityValues.length,
    tipSampleCount: tipValues.length,
  };
}
