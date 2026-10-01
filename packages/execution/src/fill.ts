import type { Lamports, TokenAmount } from '@memebot/core';

/**
 * Origem de cada custo estimado (priority fee, tip) — migração 007 (`priority_fee_source`,
 * `jito_tip_source`): mediana × 1,5 (amostras ≥ mínimo), p75 × 1,5 (1..mínimo−1 amostras) ou fallback
 * configurado (nenhuma amostra). Ver `estimateOneCost`.
 */
export type TxCostSource = 'tx_costs_median' | 'tx_costs_p75' | 'fallback';

/**
 * Origem combinada (coluna legada `cost_estimate_source` da migração 006, cujo Enum8 só tem
 * 'tx_costs_median' e 'fallback'): `tx_costs_median` só quando os DOIS tipos vieram da mediana;
 * qualquer outra coisa (p75 ou fallback em algum tipo) vira `fallback` = "não é a mediana".
 * Mantida por compatibilidade com linhas/relatórios anteriores à 007.
 */
export type CostEstimateSource = 'tx_costs_median' | 'fallback';

export function combinedCostSource(priority: TxCostSource, tip: TxCostSource): CostEstimateSource {
  return priority === 'tx_costs_median' && tip === 'tx_costs_median' ? 'tx_costs_median' : 'fallback';
}

export type FillStatus = 'filled' | 'failed' | 'expired';

/**
 * Fill (simulado ou real). Espelha a tabela `fills` (migração 001) + colunas da migração 006
 * (`venue_unverified`, `cost_estimate_source`, `cost_capped`, `rent_refund`, `base_fee`,
 * `virtual_quote_before`, `virtual_token_before` e os preços renomeados para
 * `*_price_lamports_per_unit`).
 *
 * Convenções:
 * - `solIn` (compra) = total pago à curva = `quoteAmountIn + protocolFee + creatorFee`.
 *   `solOut` (venda) = líquido recebido = `quoteOutGross − protocolFee − creatorFee`.
 *   Priority fee, tip e rent ficam nos próprios campos, fora de `solIn`/`solOut`.
 * - `tokenDelta`: + na compra, − na venda, 0 em falha/expiração.
 * - Preços em lamports por unidade mínima de token (mesma unidade de `marginalPrice`), daí o nome
 *   `*PriceLamportsPerUnit`. Compra: `solIn / tokenOut`; venda: `solOut / tokenIn` (ambos
 *   líquidos das taxas da curva). `expected` = mesma ordem simulada nas reservas do instante da
 *   decisão; `realized` = no instante do preenchimento (NaN em `failed`).
 * - `slippageBps` > 0 = pior que o esperado (compra mais cara / venda mais barata).
 * - `rent`: rent-exempt da conta de token, cobrado na primeira compra do mint; `rentRefund`:
 *   devolvido só na venda que zera a posição (conta fechada e limpa).
 * - `baseFee`: taxa base por assinatura do runtime da Solana (não-priority), cobrada em TODA
 *   transação que entra no bloco — `filled`, `failed` e `expired` (tx com erro também paga). O paper
 *   usa 1 assinatura por tx (só a carteira quente assina).
 * - `virtualQuoteBefore`/`virtualTokenBefore`: reservas virtuais da curva usadas no preenchimento
 *   (antes da nossa ordem); `null` quando não havia reservas. Servem para recalcular a operação com
 *   outros tamanhos (tabela de sensibilidade do `pnpm report`).
 * - `landedSlot`: `null` no paper (não existe slot real de inclusão).
 */
export interface Fill {
  runId: string;
  /** ms do preenchimento simulado (= submissão + latência), relógio dos eventos. */
  ts: number;
  decisionId: string;
  mint: string;
  side: 'buy' | 'sell';
  solIn: Lamports;
  solOut: Lamports;
  tokenDelta: TokenAmount;
  protocolFee: Lamports;
  creatorFee: Lamports;
  priorityFee: Lamports;
  jitoTip: Lamports;
  rent: Lamports;
  rentRefund: Lamports;
  baseFee: Lamports;
  expectedPriceLamportsPerUnit: number;
  realizedPriceLamportsPerUnit: number;
  slippageBps: number;
  landedSlot: bigint | null;
  status: FillStatus;
  error: string | null;
  /** true = fechado no último preço da bonding curve porque o token graduou (sem simular PumpSwap). */
  venueUnverified: boolean;
  /** Pior dos dois (compatibilidade, ver `combinedCostSource`). */
  costEstimateSource: CostEstimateSource;
  priorityFeeSource: TxCostSource;
  jitoTipSource: TxCostSource;
  /** true = a estimativa de priority fee/tip passou do limite e foi trocada pelo limite. */
  costCappedByHardLimit: boolean;
  virtualQuoteBefore: bigint | null;
  virtualTokenBefore: TokenAmount | null;
}

/** Fluxo de caixa líquido do fill para a carteira (negativo = saiu SOL). */
export function fillCashFlow(fill: Fill): Lamports {
  return fill.solOut + fill.rentRefund - fill.solIn - fill.priorityFee - fill.jitoTip - fill.baseFee - fill.rent;
}
