import type { Lamports, TokenAmount } from '@memebot/core';
import { feeFromBps } from './fees.ts';

/**
 * Reservas virtuais da bonding curve do Pump.fun (constant product `virtualQuote * virtualToken = k`).
 * Campos como emitidos pelo `TradeEvent` (ver `packages/core/src/events.ts`).
 */
export interface CurveReserves {
  virtualQuote: bigint;
  virtualToken: TokenAmount;
}

/** Reservas "reais" (visíveis como saldo de SOL/token da bonding curve), derivadas das virtuais. */
export interface RealReserves {
  realQuote: bigint;
  realToken: TokenAmount;
}

/** Constantes iniciais da curva, lidas de `protocol_config` (Pump.fun `Global`), nunca hardcoded no chamador. */
export interface CurveInitialParams {
  initialVirtualQuote: bigint;
  initialVirtualToken: TokenAmount;
  initialRealToken: TokenAmount;
}

export interface CurveFeeBps {
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

export interface CurveBuyResult {
  /** Tokens recebidos pelo comprador. */
  tokenOut: TokenAmount;
  protocolFee: Lamports;
  creatorFee: Lamports;
  /** Total pago pelo comprador: `quoteAmountIn + protocolFee + creatorFee`. */
  totalQuoteCost: Lamports;
  reservesAfter: CurveReserves;
}

export interface CurveSellResult {
  /** Valor bruto recebido da curva, antes das taxas. */
  quoteOutGross: Lamports;
  protocolFee: Lamports;
  creatorFee: Lamports;
  /** Valor líquido recebido pelo vendedor: `quoteOutGross - protocolFee - creatorFee`. */
  netQuoteOut: Lamports;
  reservesAfter: CurveReserves;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor deve ser positivo');
  if (a < 0n) throw new RangeError('ceilDiv: dividendo não pode ser negativo');
  return (a + b - 1n) / b;
}

function assertPositiveReserves(r: CurveReserves): void {
  if (r.virtualQuote <= 0n || r.virtualToken <= 0n) {
    throw new RangeError('reservas da curva devem ser positivas');
  }
}

/**
 * Compra na bonding curve: `quoteAmountIn` é o valor líquido que entra na curva (sem taxas).
 * O comprador paga `quoteAmountIn + protocolFee + creatorFee` (as taxas são cobradas por cima,
 * não saem do valor que efetivamente move a curva).
 *
 * Fórmula e arredondamento (ceiling em toda divisão) confirmados byte a byte contra 100+ trades
 * reais gravados — ver `test/fixtures/golden/curve.json` e `curve-math.test.ts`. Floor division
 * foi testado e NÃO reproduz os valores reais (erro de 1 unidade sistemático).
 */
export function bondingCurveBuy(
  reservesBefore: CurveReserves,
  quoteAmountIn: Lamports,
  fees: CurveFeeBps,
): CurveBuyResult {
  assertPositiveReserves(reservesBefore);
  if (quoteAmountIn <= 0n) throw new RangeError('quoteAmountIn deve ser positivo');

  const newVirtualQuote = reservesBefore.virtualQuote + quoteAmountIn;
  const k = reservesBefore.virtualQuote * reservesBefore.virtualToken;
  const newVirtualToken = ceilDiv(k, newVirtualQuote);
  const tokenOut = reservesBefore.virtualToken - newVirtualToken;
  if (tokenOut < 0n) throw new RangeError('bondingCurveBuy: tokenOut negativo (reservas inconsistentes)');

  const protocolFee = feeFromBps(quoteAmountIn, fees.protocolFeeBps);
  const creatorFee = feeFromBps(quoteAmountIn, fees.creatorFeeBps);

  return {
    tokenOut,
    protocolFee,
    creatorFee,
    totalQuoteCost: quoteAmountIn + protocolFee + creatorFee,
    reservesAfter: { virtualQuote: newVirtualQuote, virtualToken: newVirtualToken },
  };
}

/**
 * Venda na bonding curve: `tokenAmountIn` é a quantidade de token vendida (entra inteira na
 * curva, sem desconto). O valor bruto que sai (`quoteOutGross`) é o que a curva libera pelo
 * constant product; as taxas são then deduzidas dele antes de pagar o vendedor.
 */
export function bondingCurveSell(
  reservesBefore: CurveReserves,
  tokenAmountIn: TokenAmount,
  fees: CurveFeeBps,
): CurveSellResult {
  assertPositiveReserves(reservesBefore);
  if (tokenAmountIn <= 0n) throw new RangeError('tokenAmountIn deve ser positivo');

  const newVirtualToken = reservesBefore.virtualToken + tokenAmountIn;
  const k = reservesBefore.virtualQuote * reservesBefore.virtualToken;
  const newVirtualQuote = ceilDiv(k, newVirtualToken);
  const quoteOutGross = reservesBefore.virtualQuote - newVirtualQuote;
  if (quoteOutGross < 0n) throw new RangeError('bondingCurveSell: quoteOutGross negativo (reservas inconsistentes)');

  const protocolFee = feeFromBps(quoteOutGross, fees.protocolFeeBps);
  const creatorFee = feeFromBps(quoteOutGross, fees.creatorFeeBps);

  return {
    quoteOutGross,
    protocolFee,
    creatorFee,
    netQuoteOut: quoteOutGross - protocolFee - creatorFee,
    reservesAfter: { virtualQuote: newVirtualQuote, virtualToken: newVirtualToken },
  };
}

/**
 * Deriva as reservas "reais" a partir das virtuais e dos parâmetros iniciais da curva
 * (constantes, lidas de `protocol_config`). `realQuote` começa em 0 e `virtualQuote` em
 * `initialVirtualQuote`, logo `realQuote = virtualQuote - initialVirtualQuote`; o mesmo
 * deslocamento vale para o token, usando `initialVirtualToken - initialRealToken`.
 * Confirmado exatamente contra os fixtures golden (campos `after.realQuote`/`after.realToken`).
 */
export function deriveRealReserves(virtual: CurveReserves, initial: CurveInitialParams): RealReserves {
  return {
    realQuote: virtual.virtualQuote - initial.initialVirtualQuote,
    realToken: virtual.virtualToken - (initial.initialVirtualToken - initial.initialRealToken),
  };
}

/** Preço marginal (quote por token, em unidades mínimas) implícito nas reservas virtuais atuais. */
export function marginalPrice(reserves: CurveReserves): number {
  assertPositiveReserves(reserves);
  return Number(reserves.virtualQuote) / Number(reserves.virtualToken);
}
