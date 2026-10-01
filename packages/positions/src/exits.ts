import type { Lamports } from '@memebot/core';
import { bondingCurveSell } from '@memebot/curve-math';
import type { CurveFeeBps } from '@memebot/curve-math';
import type { TokenState } from '@memebot/state';
import type { StrategyV0Config } from '@memebot/strategy';
import type { ExitOrder, ExitReason, Position } from './position.ts';

export type ExitsConfig = StrategyV0Config['exits'];

export interface ExitContext {
  /** Taxas da curva resolvidas de `protocol_config`. */
  fees: CurveFeeBps;
  /** Custos estimados da transação de saída (os mesmos que o executor cobraria, já limitados). */
  exitPriorityFeeLamports: Lamports;
  exitJitoTipLamports: Lamports;
}

/** Token saiu da bonding curve (mesma regra do executor: completou ou já migrou). */
function graduated(token: TokenState): boolean {
  return token.curveCompleted || token.venue === 'pumpswap';
}

/**
 * Valor líquido de liquidação do restante AGORA (lamports, com sinal):
 * `L = netQuoteOut(bondingCurveSell(reservas atuais, quantidade)) − priorityFeeSaída − tipSaída + rentPago`.
 * `netQuoteOut` já desconta as taxas de protocolo/criador da venda; o rent entra porque vender tudo
 * fecha a conta de token e devolve o rent (que foi cobrado no custo de entrada). `null` sem reservas.
 */
export function liquidationValue(position: Position, token: TokenState, ctx: ExitContext): Lamports | null {
  if (!token.curveReserves || position.tokenAmount <= 0n) return null;
  const { netQuoteOut } = bondingCurveSell(
    { virtualQuote: token.curveReserves.virtualQuote, virtualToken: token.curveReserves.virtualToken },
    position.tokenAmount,
    ctx.fees,
  );
  return netQuoteOut - ctx.exitPriorityFeeLamports - ctx.exitJitoTipLamports + position.rentPaidLamports;
}

/**
 * Ganho/perda LÍQUIDO da posição (STRATEGY §6, "percentuais líquidos de taxas de saída"):
 *
 *   pnl = (realizadoLíquido + L − custoEntrada) / custoEntrada
 *
 * - `custoEntrada` = solIn (com taxas da curva) + priority fee + tip + rent da compra;
 * - `realizadoLíquido` = Σ (solOut + rentRefund − priority − tip) das vendas já feitas (e −custo das falhas);
 * - `L` = `liquidationValue` do restante (venda total agora, com taxas da curva e custos da tx de saída).
 * Logo, logo após entrar (mesmas reservas), pnl < 0: paga as taxas de ida e volta.
 */
export function netPnlRatio(position: Position, token: TokenState, ctx: ExitContext): number | null {
  const value = liquidationValue(position, token, ctx);
  if (value === null || position.entryCostLamports <= 0n) return null;
  const net = position.realizedNetProceedsLamports + value - position.entryCostLamports;
  return Number(net) / Number(position.entryCostLamports);
}

function toBps(fraction: number): bigint {
  return BigInt(Math.round(fraction * 10_000));
}

function hasLargeSellSince(position: Position, token: TokenState, pctSupply: number): boolean {
  if (token.tokenTotalSupply === null || token.tokenTotalSupply <= 0n) return false;
  const thresholdBps = toBps(pctSupply);
  for (let i = token.trades.length - 1; i >= 0; i--) {
    const t = token.trades[i];
    if (!t || t.ts <= position.openedAtMs) break;
    if (t.side === 'sell' && t.tokenAmount * 10_000n > token.tokenTotalSupply * thresholdBps) return true;
  }
  return false;
}

function hasCreatorSellSince(position: Position, token: TokenState): boolean {
  for (let i = token.trades.length - 1; i >= 0; i--) {
    const t = token.trades[i];
    if (!t || t.ts <= position.openedAtMs) break;
    if (t.side === 'sell' && token.creatorWallets.has(t.trader)) return true;
  }
  return false;
}

function sellAll(position: Position, reason: ExitReason): ExitOrder {
  return { mint: position.mint, fraction: 1, reason, takeProfitStep: null };
}

/**
 * Regras de saída (docs/STRATEGY.md §6, valores de `config.exits`), avaliadas a cada evento/tick.
 * Função pura: devolve a posição (com a máxima do trailing atualizada) e no máximo UMA ordem.
 *
 * Precedência quando várias disparam no mesmo tick (a primeira vence):
 *   graduated > emergency_creator_sell > emergency_large_sell > stop_loss > trailing_stop >
 *   time_stop > take_profit_N
 * Motivo: sair de tudo por risco estrutural (graduação, criador/baleia vendendo) antes de olhar
 * preço; perdas (stop/trailing) antes de regras de tempo; realização parcial de lucro por último.
 *
 * Regras:
 * - emergência: venda individual de terceiro com `tokenAmount > singleSellPctSupply × supply`, ou
 *   venda de carteira do criador (`exitOnCreatorSell`), com `ts > openedAtMs` → vende tudo;
 * - stop loss: `pnl ≤ −stopLossPct` → vende tudo;
 * - trailing (só depois do TP1, "no restante"): `L ≤ máximaL × (1 − trailingStopPct)`, com `L` e a
 *   máxima em valor LÍQUIDO do restante; a máxima recomeça do valor atual após cada venda parcial;
 * - time stop: `agora − openedAtMs ≥ timeStopSec` sem TP1 → vende tudo;
 * - take profit: degraus em ordem; `sellFraction` é fração da quantidade INICIAL (TP1 50% + TP2 30% →
 *   sobram 20%). Se o preço pular vários degraus num tick, vende a soma deles numa ordem só
 *   (`take_profit_<último degrau>`).
 * Enquanto houver saída pendente (`exitPending`), não emite nova ordem.
 */
export function evaluateExits(
  position: Position,
  token: TokenState,
  nowMs: number,
  config: ExitsConfig,
  ctx: ExitContext,
): { position: Position; orders: ExitOrder[] } {
  const value = liquidationValue(position, token, ctx);
  const trailingActive = position.takeProfitStepsDone >= 1;
  let next = position;
  if (trailingActive && value !== null) {
    const peak = position.trailingPeakLamports === null || value > position.trailingPeakLamports ? value : position.trailingPeakLamports;
    if (peak !== position.trailingPeakLamports) next = { ...position, trailingPeakLamports: peak };
  }

  if (position.exitPending !== null || position.tokenAmount <= 0n) return { position: next, orders: [] };
  const done = (order: ExitOrder): { position: Position; orders: ExitOrder[] } => ({ position: next, orders: [order] });

  if (graduated(token)) return done(sellAll(position, 'graduated'));
  if (config.emergency.exitOnCreatorSell && hasCreatorSellSince(position, token)) {
    return done(sellAll(position, 'emergency_creator_sell'));
  }
  if (hasLargeSellSince(position, token, config.emergency.singleSellPctSupply)) {
    return done(sellAll(position, 'emergency_large_sell'));
  }

  const pnl = netPnlRatio(position, token, ctx);
  if (pnl !== null && pnl <= -config.stopLossPct) return done(sellAll(position, 'stop_loss'));

  const peak = next.trailingPeakLamports;
  if (trailingActive && value !== null && peak !== null && peak > 0n) {
    if (value * 10_000n <= peak * (10_000n - toBps(config.trailingStopPct))) return done(sellAll(position, 'trailing_stop'));
  }

  if (position.takeProfitStepsDone === 0 && nowMs - position.openedAtMs >= config.timeStopSec * 1000) {
    return done(sellAll(position, 'time_stop'));
  }

  if (pnl !== null) {
    let reached = position.takeProfitStepsDone;
    while (reached < config.takeProfit.length && (config.takeProfit[reached]?.gainPct ?? Number.POSITIVE_INFINITY) <= pnl) {
      reached++;
    }
    if (reached > position.takeProfitStepsDone) {
      let fractionOfInitial = 0;
      for (let i = position.takeProfitStepsDone; i < reached; i++) fractionOfInitial += config.takeProfit[i]?.sellFraction ?? 0;
      const raw = (fractionOfInitial * Number(position.initialTokenAmount)) / Number(position.tokenAmount);
      const fraction = raw >= 0.999_999 ? 1 : raw;
      return done({ mint: position.mint, fraction, reason: `take_profit_${String(reached)}`, takeProfitStep: reached });
    }
  }

  return { position: next, orders: [] };
}
