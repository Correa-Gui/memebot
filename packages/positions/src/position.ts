import type { Lamports, TokenAmount } from '@memebot/core';
import type { Fill } from '@memebot/execution';

export type ExitReason =
  | 'graduated'
  | 'emergency_creator_sell'
  | 'emergency_large_sell'
  | 'stop_loss'
  | 'trailing_stop'
  | 'time_stop'
  | `take_profit_${string}`;

/** Ordem de saída: vender `fraction` (em (0, 1]) da quantidade ATUAL da posição. */
export interface ExitOrder {
  mint: string;
  fraction: number;
  reason: ExitReason;
  /** Para take profit: nº de degraus concluídos quando esta venda for preenchida; senão null. */
  takeProfitStep: number | null;
}

/**
 * Posição aberta (visão da estratégia, separada da carteira simulada do executor). Imutável.
 * Valores monetários em lamports (bigint, com sinal onde indicado).
 */
export interface Position {
  mint: string;
  /**
   * Onde a posição foi comprada. `curve` (padrão, v0.1): se o token graduar, sai por `graduated` no último
   * preço da curva. `pumpswap` (universo graduado do replay): liquidação e saídas pelo swap exato do PumpSwap.
   */
  venue: 'curve' | 'pumpswap';
  entryDecisionId: string;
  /** ts do fill de compra (relógio dos eventos). */
  openedAtMs: number;
  initialTokenAmount: TokenAmount;
  tokenAmount: TokenAmount;
  /** Custo total de entrada: `solIn` (com taxas da curva) + priority fee + tip + taxa base + rent. */
  entryCostLamports: Lamports;
  /** Parte do custo de entrada ainda não alocada a vendas (para o PnL realizado proporcional). */
  costBasisRemainingLamports: Lamports;
  /** Rent da conta de token pago na entrada (volta quando a posição zera). */
  rentPaidLamports: Lamports;
  /** Soma de (solOut + rentRefund − priority − tip − taxa base) das vendas, inclusive custo de vendas falhas. Com sinal. */
  realizedNetProceedsLamports: Lamports;
  /** PnL realizado acumulado desta posição. Com sinal. */
  realizedPnlLamports: Lamports;
  takeProfitStepsDone: number;
  /** Máxima do valor líquido do restante (trailing), em lamports; null até o trailing começar. */
  trailingPeakLamports: Lamports | null;
  /** Saída submetida e ainda não preenchida: nenhuma nova ordem enquanto houver uma. */
  exitPending: ExitOrder | null;
}

export class InvalidFillForPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFillForPositionError';
  }
}

/** Abre a posição a partir de um fill de compra `filled` (`venue`: onde a compra foi simulada). */
export function openPosition(fill: Fill, venue: 'curve' | 'pumpswap' = 'curve'): Position {
  if (fill.side !== 'buy' || fill.status !== 'filled' || fill.tokenDelta <= 0n) {
    throw new InvalidFillForPositionError(`openPosition exige compra preenchida (decision ${fill.decisionId})`);
  }
  const entryCost = fill.solIn + fill.priorityFee + fill.jitoTip + fill.baseFee + fill.rent;
  return {
    mint: fill.mint,
    venue,
    entryDecisionId: fill.decisionId,
    openedAtMs: fill.ts,
    initialTokenAmount: fill.tokenDelta,
    tokenAmount: fill.tokenDelta,
    entryCostLamports: entryCost,
    costBasisRemainingLamports: entryCost,
    rentPaidLamports: fill.rent,
    realizedNetProceedsLamports: 0n,
    realizedPnlLamports: 0n,
    takeProfitStepsDone: 0,
    trailingPeakLamports: null,
    exitPending: null,
  };
}

/** Registra que a ordem de saída foi submetida ao executor. */
export function markExitSubmitted(position: Position, order: ExitOrder): Position {
  return { ...position, exitPending: order };
}

/**
 * Aplica o fill de uma venda. PnL realizado (vai para a perda diária do risco):
 * - `filled`: `(solOut + rentRefund − priority − tip − taxa base) − custoAlocado`, com
 *   `custoAlocado = custoRestante × vendido / quantidadeAntes` (o resto inteiro na venda que zera).
 * - `failed`/`expired`: `−(priority + tip + taxa base)` (o que a transação custou), posição intacta.
 * Devolve `position: null` quando a posição zera.
 */
export function applyExitFill(position: Position, fill: Fill): { position: Position | null; realizedPnlDelta: Lamports } {
  if (fill.side !== 'sell' || fill.mint !== position.mint) {
    throw new InvalidFillForPositionError(`fill ${fill.decisionId} não é venda de ${position.mint}`);
  }
  const pending = position.exitPending;
  const cleared: Position = { ...position, exitPending: null };

  if (fill.status !== 'filled') {
    const cost = fill.priorityFee + fill.jitoTip + fill.baseFee;
    return {
      position: {
        ...cleared,
        realizedNetProceedsLamports: cleared.realizedNetProceedsLamports - cost,
        realizedPnlLamports: cleared.realizedPnlLamports - cost,
      },
      realizedPnlDelta: -cost,
    };
  }

  const sold = -fill.tokenDelta;
  if (sold <= 0n || sold > position.tokenAmount) {
    throw new InvalidFillForPositionError(`quantidade vendida inválida no fill ${fill.decisionId}`);
  }
  const remaining = position.tokenAmount - sold;
  const allocatedCost = remaining === 0n
    ? position.costBasisRemainingLamports
    : (position.costBasisRemainingLamports * sold) / position.tokenAmount;
  const netProceeds = fill.solOut + fill.rentRefund - fill.priorityFee - fill.jitoTip - fill.baseFee;
  const delta = netProceeds - allocatedCost;

  if (remaining === 0n) return { position: null, realizedPnlDelta: delta };

  return {
    position: {
      ...cleared,
      tokenAmount: remaining,
      costBasisRemainingLamports: position.costBasisRemainingLamports - allocatedCost,
      realizedNetProceedsLamports: position.realizedNetProceedsLamports + netProceeds,
      realizedPnlLamports: position.realizedPnlLamports + delta,
      takeProfitStepsDone: pending?.takeProfitStep ?? position.takeProfitStepsDone,
      // Depois de uma venda parcial o trailing recomeça a partir do valor atual do restante.
      trailingPeakLamports: null,
    },
    realizedPnlDelta: delta,
  };
}
