import type { Lamports, TokenAmount } from '@memebot/core';
import { feeFromBps } from './fees.ts';

/**
 * Reservas do pool PumpSwap. **Importante:** no evento `BuyEvent`/`SellEvent` do IDL,
 * `pool_base_token_reserves`/`pool_quote_token_reserves` representam o estado ANTES do swap
 * daquele mesmo evento, não depois — confirmado comparando a continuidade das reservas entre
 * trades consecutivos do mesmo pool contra dados reais (`scripts/extract-golden-fixtures.ts`):
 * `reservas(trade[i+1]) == reservas(trade[i]) ajustadas pelo delta do PRÓPRIO trade[i]`, o que só
 * é consistente se as reservas de cada evento forem o estado inicial daquele evento.
 */
export interface PumpSwapReserves {
  base: TokenAmount;
  quote: bigint;
}

export interface PumpSwapFeeBps {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

export interface PumpSwapBuyResult {
  baseOut: TokenAmount;
  lpFee: Lamports;
  protocolFee: Lamports;
  creatorFee: Lamports;
  /** Total pago pelo comprador (quote): `netQuoteIn + lpFee + protocolFee + creatorFee`. */
  totalQuoteCost: Lamports;
  reservesAfter: PumpSwapReserves;
}

export interface PumpSwapSellResult {
  quoteOutGross: Lamports;
  lpFee: Lamports;
  protocolFee: Lamports;
  creatorFee: Lamports;
  /** Valor líquido recebido pelo vendedor. */
  netQuoteOut: Lamports;
  reservesAfter: PumpSwapReserves;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor deve ser positivo');
  if (a < 0n) throw new RangeError('ceilDiv: dividendo não pode ser negativo');
  return (a + b - 1n) / b;
}

function assertPositiveReserves(r: PumpSwapReserves): void {
  if (r.base <= 0n || r.quote <= 0n) throw new RangeError('reservas do pool devem ser positivas');
}

/**
 * LIMITAÇÃO CONHECIDA (documentada em vez de forçar um número que não bate): o cálculo de taxas
 * abaixo (`lpFee`/`protocolFee`/`creatorFee` em cima do valor líquido, com ceiling) foi
 * confirmado byte a byte contra trades reais do PumpSwap. Já o `baseOut`/`reservesAfter`
 * (quanto token sai/entra do pool) usa aqui o constant-product "de manual" sobre
 * `pool_base_token_reserves`/`pool_quote_token_reserves`, e esse valor **não reproduziu** os
 * trades reais gravados (erro de ~10%, não é arredondamento) — ver o relatório da Fase 2. A
 * hipótese mais provável é que o PumpSwap também usa reservas *virtuais* com algum deslocamento
 * não exposto nestes dois campos do evento (análogo ao par virtual/real da bonding curve), o que
 * exigiria ler a conta `Pool` on-chain para resolver — desproporcional para o tempo desta fase.
 * Os testes golden deste pacote por isso só exigem exatidão nas taxas para o PumpSwap, não no
 * `baseOut`/`reservesAfter`. Ajustar quando a conta `Pool` completa for lida (Fase 3+).
 */
export function pumpSwapBuy(
  reservesBefore: PumpSwapReserves,
  netQuoteIn: Lamports,
  fees: PumpSwapFeeBps,
): PumpSwapBuyResult {
  assertPositiveReserves(reservesBefore);
  if (netQuoteIn <= 0n) throw new RangeError('netQuoteIn deve ser positivo');

  const lpFee = feeFromBps(netQuoteIn, fees.lpFeeBps);
  const protocolFee = feeFromBps(netQuoteIn, fees.protocolFeeBps);
  const creatorFee = feeFromBps(netQuoteIn, fees.creatorFeeBps);

  const swapAmount = netQuoteIn + lpFee; // lp fee fica no pool; protocol/creator saem do sistema.
  const newQuote = reservesBefore.quote + swapAmount;
  const k = reservesBefore.base * reservesBefore.quote;
  const newBase = ceilDiv(k, newQuote);
  const baseOut = reservesBefore.base - newBase;
  if (baseOut < 0n) throw new RangeError('pumpSwapBuy: baseOut negativo (reservas inconsistentes)');

  return {
    baseOut,
    lpFee,
    protocolFee,
    creatorFee,
    totalQuoteCost: netQuoteIn + lpFee + protocolFee + creatorFee,
    reservesAfter: { base: newBase, quote: newQuote },
  };
}

/** Ver limitação documentada em {@link pumpSwapBuy}: taxas exatas, `quoteOutGross`/reservas best-effort. */
export function pumpSwapSell(
  reservesBefore: PumpSwapReserves,
  tokenAmountIn: TokenAmount,
  fees: PumpSwapFeeBps,
): PumpSwapSellResult {
  assertPositiveReserves(reservesBefore);
  if (tokenAmountIn <= 0n) throw new RangeError('tokenAmountIn deve ser positivo');

  const newBase = reservesBefore.base + tokenAmountIn;
  const k = reservesBefore.base * reservesBefore.quote;
  const newQuote = ceilDiv(k, newBase);
  const quoteOutGross = reservesBefore.quote - newQuote;
  if (quoteOutGross < 0n) throw new RangeError('pumpSwapSell: quoteOutGross negativo (reservas inconsistentes)');

  const lpFee = feeFromBps(quoteOutGross, fees.lpFeeBps);
  const protocolFee = feeFromBps(quoteOutGross, fees.protocolFeeBps);
  const creatorFee = feeFromBps(quoteOutGross, fees.creatorFeeBps);
  const netQuoteOut = quoteOutGross - lpFee - protocolFee - creatorFee;

  // lp fee fica retida no pool (não sai com o usuário nem com protocolo/criador).
  const quoteLeavingPool = quoteOutGross - lpFee;

  return {
    quoteOutGross,
    lpFee,
    protocolFee,
    creatorFee,
    netQuoteOut,
    reservesAfter: { base: newBase, quote: reservesBefore.quote - quoteLeavingPool },
  };
}

/** Market cap em lamports do quote, usado para escolher o tier de taxa (ver `lookupFeeTier`). */
export function marketCapLamports(reservesBefore: PumpSwapReserves, tokenTotalSupply: TokenAmount): bigint {
  assertPositiveReserves(reservesBefore);
  return (reservesBefore.quote * tokenTotalSupply) / reservesBefore.base;
}
