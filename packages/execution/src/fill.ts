import type { Lamports, TokenAmount } from '@memebot/core';

/** Origem da estimativa de priority fee / tip usada no fill (nunca silenciosa). */
export type CostEstimateSource = 'tx_costs_median' | 'fallback';

export type FillStatus = 'filled' | 'failed' | 'expired';

/**
 * Fill (simulado ou real). Espelha a tabela `fills` (migração 001) + colunas da migração 006
 * (`venue_unverified`, `cost_estimate_source`, `cost_capped`, `rent_refund`).
 *
 * Convenções:
 * - `solIn` (compra) = total pago à curva = `quoteAmountIn + protocolFee + creatorFee`.
 *   `solOut` (venda) = líquido recebido = `quoteOutGross − protocolFee − creatorFee`.
 *   Priority fee, tip e rent ficam nos próprios campos, fora de `solIn`/`solOut`.
 * - `tokenDelta`: + na compra, − na venda, 0 em falha/expiração.
 * - Preços em lamports por unidade mínima de token (mesma unidade de `marginalPrice`); o nome
 *   `*_price_sol` vem da tabela. Compra: `solIn / tokenOut`; venda: `solOut / tokenIn` (ambos
 *   líquidos das taxas da curva). `expected` = mesma ordem simulada nas reservas do instante da
 *   decisão; `realized` = no instante do preenchimento (NaN em `failed`).
 * - `slippageBps` > 0 = pior que o esperado (compra mais cara / venda mais barata).
 * - `rent`: rent-exempt da conta de token, cobrado na primeira compra do mint; `rentRefund`:
 *   devolvido só na venda que zera a posição (conta fechada e limpa).
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
  expectedPriceSol: number;
  realizedPriceSol: number;
  slippageBps: number;
  landedSlot: bigint | null;
  status: FillStatus;
  error: string | null;
  /** true = fechado no último preço da bonding curve porque o token graduou (sem simular PumpSwap). */
  venueUnverified: boolean;
  costEstimateSource: CostEstimateSource;
  /** true = a estimativa de priority fee/tip passou do limite e foi trocada pelo limite. */
  costCappedByHardLimit: boolean;
}

/** Fluxo de caixa líquido do fill para a carteira (negativo = saiu SOL). */
export function fillCashFlow(fill: Fill): Lamports {
  return fill.solOut + fill.rentRefund - fill.solIn - fill.priorityFee - fill.jitoTip - fill.rent;
}
