import type { Lamports, TokenAmount } from '@memebot/core';
import { feeFromBps } from './fees.ts';

/**
 * Matemática do swap no PumpSwap (programa `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`),
 * reproduzida com **0 unidades de diferença** contra trades reais.
 *
 * Fontes (ver `test/fixtures/golden/pumpswap.json`, `test/fixtures/pumpswap-rpc/` e
 * `scripts/extract-pumpswap-fixtures.ts`):
 * - IDL oficial `packages/ingest/src/idl/pump_amm.json`: a conta `Pool` e os eventos
 *   `BuyEvent`/`SellEvent` têm o campo `virtual_quote_reserves: i128`. O constant product usa
 *   `quoteEfetivo = pool_quote_token_reserves + virtual_quote_reserves`; a base usa o saldo real.
 *   Ignorar esse campo era a causa da divergência de ~7,6% registrada na Fase 2.
 * - Transações reais (RPC público, 2026-10-02): `pool_base_token_reserves` /
 *   `pool_quote_token_reserves` do evento são EXATAMENTE os `preTokenBalances` das vaults da pool
 *   (`Pool.pool_base_token_account` / `pool_quote_token_account`), e `Pool.virtual_quote_reserves`
 *   lido via `getAccountInfo` é igual ao campo do evento. Ou seja: o evento traz o estado ANTES do
 *   swap e as vaults não têm saldo "reservado" fora do que o programa usa.
 * - Validação em massa (ClickHouse, `raw_b64` decodificado com o IDL): 52.758 eventos de 40+
 *   pools com quote WSOL, mais amostras de pools com quote ≠ WSOL e pools com base = WSOL, 100%
 *   exatos; continuidade das reservas entre trades consecutivos do mesmo pool 46.829/46.864
 *   (as 35 quebras têm base E quote fora, i.e. evento faltando/ordem dentro do slot, não fórmula).
 *
 * Regras (todas confirmadas pelos dados acima):
 * - Taxas: `ceil(valor * bps / 10000)` por componente (lp, protocolo, criador, cashback), sempre
 *   sobre o valor de quote "do swap" (líquido na compra, bruto na venda).
 * - A taxa de LP fica na vault de quote; protocolo/criador/cashback saem para outras contas.
 *   `buyback_fee` e `holder_rewards` do evento são repartições internas das taxas acima
 *   (`buyback_fee = floor(protocol_fee * buyback_bps / 10000)`), não afetam usuário nem pool.
 * - Venda: `bruto = floor(Qe * baseIn / (B + baseIn))`; usuário recebe `bruto - taxas`; a vault
 *   de quote perde `bruto - lpFee`.
 * - Compra `buy` (base exata): `líquido = ceil(Qe * baseOut / (B - baseOut))`; usuário paga
 *   `líquido + taxas`; a vault de quote ganha `líquido + lpFee`.
 * - Compra `buy_exact_quote_in` (quote gastável): ver {@link pumpSwapBuyExactQuoteIn}.
 */

/**
 * Estado da pool ANTES do swap, exatamente como o programa o usa.
 * `base`/`quote` = saldos das vaults (= `pool_base_token_reserves`/`pool_quote_token_reserves`
 * do evento); `virtualQuote` = `Pool.virtual_quote_reserves` (i128; pools sem offset têm 0).
 */
export interface PumpSwapReserves {
  base: TokenAmount;
  quote: bigint;
  virtualQuote: bigint;
}

/**
 * Bps de cada componente de taxa, como aparecem no evento (`lp_fee_basis_points`,
 * `protocol_fee_basis_points`, `coin_creator_fee_basis_points`, `cashback_fee_basis_points`).
 */
export interface PumpSwapFeeBps {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
  cashbackFeeBps: bigint;
}

export interface PumpSwapFees {
  lpFee: Lamports;
  protocolFee: Lamports;
  creatorFee: Lamports;
  cashbackFee: Lamports;
}

export interface PumpSwapBuyResult extends PumpSwapFees {
  baseOut: TokenAmount;
  /** Quote que entra no constant product, base das taxas (`quote_amount_in` em `buy`, `user_quote_amount_in` em `buy_exact_quote_in`). */
  netQuoteIn: Lamports;
  /** Total debitado do comprador: `netQuoteIn + lp + protocol + creator + cashback`. */
  totalQuoteCost: Lamports;
  reservesAfter: PumpSwapReserves;
}

export interface PumpSwapSellResult extends PumpSwapFees {
  /** `quote_amount_out` do evento: saída do constant product antes das taxas. */
  quoteOutGross: Lamports;
  /** `user_quote_amount_out`: o que o vendedor recebe. */
  netQuoteOut: Lamports;
  reservesAfter: PumpSwapReserves;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor deve ser positivo');
  if (a < 0n) throw new RangeError('ceilDiv: dividendo não pode ser negativo');
  return (a + b - 1n) / b;
}

/** Quote efetivo do constant product: saldo da vault + `virtual_quote_reserves`. */
export function effectiveQuoteReserves(r: PumpSwapReserves): bigint {
  return r.quote + r.virtualQuote;
}

function assertValidReserves(r: PumpSwapReserves): void {
  if (r.base <= 0n || r.quote < 0n || effectiveQuoteReserves(r) <= 0n) {
    throw new RangeError('reservas do pool inválidas (base e quote efetivo devem ser positivos)');
  }
}

function assertValidFees(f: PumpSwapFeeBps): void {
  for (const v of [f.lpFeeBps, f.protocolFeeBps, f.creatorFeeBps, f.cashbackFeeBps]) {
    if (v < 0n || v > 10000n) throw new RangeError('bps de taxa fora de [0, 10000]');
  }
}

/** `Pool.coin_creator` de pool sem criador (chave padrão). */
export const PUMPSWAP_NO_COIN_CREATOR = '11111111111111111111111111111111';

/**
 * Bps efetivos de um swap. Pool SEM criador (`coin_creator` = chave padrão): o programa não cobra a
 * taxa do criador, mas o evento ainda traz `coin_creator_fee_basis_points` > 0 (com
 * `coin_creator_fee` = 0). Achado de 2026-10-03: verificação em massa de 11.356.386 trades reais
 * (todos com `pumpswap_trade_extra`) — 148 divergências, 100% nesse caso, e as 148 batem com 0 de
 * diferença usando o bps do criador = 0 (fixtures `test/fixtures/golden/pumpswap-no-creator.json`).
 * Sem o `coin_creator` à mão (linha reconstruída do banco), o equivalente exato é
 * `coin_creator_fee == 0` com bps > 0: com valor > 0, `ceil(valor·bps/10000) ≥ 1`.
 */
export function effectivePumpSwapFeeBps(eventBps: PumpSwapFeeBps, hasCoinCreator: boolean): PumpSwapFeeBps {
  return hasCoinCreator ? eventBps : { ...eventBps, creatorFeeBps: 0n };
}

export function pumpSwapFees(amount: Lamports, fees: PumpSwapFeeBps): PumpSwapFees {
  return {
    lpFee: feeFromBps(amount, fees.lpFeeBps),
    protocolFee: feeFromBps(amount, fees.protocolFeeBps),
    creatorFee: feeFromBps(amount, fees.creatorFeeBps),
    cashbackFee: feeFromBps(amount, fees.cashbackFeeBps),
  };
}

function totalFees(f: PumpSwapFees): Lamports {
  return f.lpFee + f.protocolFee + f.creatorFee + f.cashbackFee;
}

/** `floor(B * q / (Qe + q))`: base que sai do pool para `q` de quote entrando no constant product. */
function baseOutForQuote(r: PumpSwapReserves, quoteIn: bigint): TokenAmount {
  const qe = effectiveQuoteReserves(r);
  return (r.base * quoteIn) / (qe + quoteIn);
}

/**
 * Instrução `buy` (args `base_amount_out`, `max_quote_amount_in`): compra uma quantidade EXATA de
 * base. `netQuoteIn = ceil(Qe * baseOut / (B - baseOut))` (= `quote_amount_in` do evento); taxas
 * sobre `netQuoteIn`; usuário paga `netQuoteIn + taxas` (= `user_quote_amount_in`).
 */
export function pumpSwapBuyExactBaseOut(
  reservesBefore: PumpSwapReserves,
  baseOut: TokenAmount,
  fees: PumpSwapFeeBps,
): PumpSwapBuyResult {
  assertValidReserves(reservesBefore);
  assertValidFees(fees);
  if (baseOut <= 0n) throw new RangeError('baseOut deve ser positivo');
  if (baseOut >= reservesBefore.base) throw new RangeError('baseOut deve ser menor que a reserva de base');

  const qe = effectiveQuoteReserves(reservesBefore);
  const netQuoteIn = ceilDiv(qe * baseOut, reservesBefore.base - baseOut);
  const f = pumpSwapFees(netQuoteIn, fees);
  return {
    baseOut,
    netQuoteIn,
    ...f,
    totalQuoteCost: netQuoteIn + totalFees(f),
    reservesAfter: {
      base: reservesBefore.base - baseOut,
      quote: reservesBefore.quote + netQuoteIn + f.lpFee,
      virtualQuote: reservesBefore.virtualQuote,
    },
  };
}

/**
 * Instrução `buy_exact_quote_in` (args `spendable_quote_in`, `min_base_amount_out`). Regra
 * observada em 100% dos eventos reais (o evento grava `quote_amount_in = spendable_quote_in`):
 * 1. `n0 = floor(spendable * 10000 / (10000 + lp + protocol + creator + cashback bps))`;
 * 2. taxas = `ceil(n0 * bps / 10000)` por componente (são as taxas gravadas no evento);
 * 3. `netQuoteIn = min(n0, spendable - taxas)` (= `user_quote_amount_in` do evento);
 * 4. `baseOut = floor(B * (netQuoteIn - 1) / (Qe + netQuoteIn - 1))` — o programa calcula a
 *    saída com 1 unidade de quote a menos do que efetivamente cobra (margem de arredondamento a
 *    favor da pool; sem esse `-1` nenhum evento real bate);
 * 5. a vault de quote recebe `netQuoteIn + lpFee`.
 * Caso de borda (6 em ~7.700 eventos): quando as taxas de `n0` são exatas (sem arredondar),
 * `netQuoteIn + taxas = spendable - 1`; o programa só transfere esse total (o evento não registra
 * débito do lamport restante), por isso `totalQuoteCost` pode ser `spendable - 1`.
 */
export function pumpSwapBuyExactQuoteIn(
  reservesBefore: PumpSwapReserves,
  spendableQuoteIn: Lamports,
  fees: PumpSwapFeeBps,
): PumpSwapBuyResult {
  assertValidReserves(reservesBefore);
  assertValidFees(fees);
  if (spendableQuoteIn <= 0n) throw new RangeError('spendableQuoteIn deve ser positivo');

  const totalBps = fees.lpFeeBps + fees.protocolFeeBps + fees.creatorFeeBps + fees.cashbackFeeBps;
  const n0 = (spendableQuoteIn * 10000n) / (10000n + totalBps);
  const f = pumpSwapFees(n0, fees);
  const rest = spendableQuoteIn - totalFees(f);
  const netQuoteIn = rest < n0 ? rest : n0;
  if (netQuoteIn <= 1n) throw new RangeError('pumpSwapBuyExactQuoteIn: valor pequeno demais para comprar');
  const baseOut = baseOutForQuote(reservesBefore, netQuoteIn - 1n);
  if (baseOut <= 0n) throw new RangeError('pumpSwapBuyExactQuoteIn: baseOut zero');

  return {
    baseOut,
    netQuoteIn,
    ...f,
    totalQuoteCost: netQuoteIn + totalFees(f),
    reservesAfter: {
      base: reservesBefore.base - baseOut,
      quote: reservesBefore.quote + netQuoteIn + f.lpFee,
      virtualQuote: reservesBefore.virtualQuote,
    },
  };
}

/**
 * Instrução `sell` (args `base_amount_in`, `min_quote_amount_out`):
 * `quoteOutGross = floor(Qe * baseIn / (B + baseIn))` (= `quote_amount_out`); taxas sobre o bruto;
 * vendedor recebe `bruto - taxas` (= `user_quote_amount_out`); a vault perde `bruto - lpFee`.
 */
export function pumpSwapSell(
  reservesBefore: PumpSwapReserves,
  baseIn: TokenAmount,
  fees: PumpSwapFeeBps,
): PumpSwapSellResult {
  assertValidReserves(reservesBefore);
  assertValidFees(fees);
  if (baseIn <= 0n) throw new RangeError('baseIn deve ser positivo');

  const qe = effectiveQuoteReserves(reservesBefore);
  const quoteOutGross = (qe * baseIn) / (reservesBefore.base + baseIn);
  const f = pumpSwapFees(quoteOutGross, fees);
  const netQuoteOut = quoteOutGross - totalFees(f);
  if (netQuoteOut < 0n) throw new RangeError('pumpSwapSell: saída líquida negativa');
  const quoteLeavingVault = quoteOutGross - f.lpFee;
  if (quoteLeavingVault > reservesBefore.quote) {
    throw new RangeError('pumpSwapSell: saída maior que o saldo real da vault de quote');
  }

  return {
    quoteOutGross,
    netQuoteOut,
    ...f,
    reservesAfter: {
      base: reservesBefore.base + baseIn,
      quote: reservesBefore.quote - quoteLeavingVault,
      virtualQuote: reservesBefore.virtualQuote,
    },
  };
}

/**
 * Market cap em unidades de quote, usado para escolher o tier de taxa (ver `lookupFeeTier`):
 * `Qe * supply / B`, com o quote EFETIVO. Medido em 3.000 eventos reais com quote WSOL contra o
 * `FeeConfig` gravado em `protocol_config`: com `Qe` o tier bate em 2.970 (99,0%); só com o saldo
 * real `quote`, em 2.650 (88,3%). As 30 exceções são pools fora da regra de tiers (flat 25/5/0
 * de pools não-canônicas, pools isentas 0/0/0 e moedas com cashback, onde a taxa do criador vira
 * cashback) — os bps de cada trade real vêm no próprio evento.
 */
export function marketCapLamports(reservesBefore: PumpSwapReserves, tokenTotalSupply: TokenAmount): bigint {
  assertValidReserves(reservesBefore);
  return (effectiveQuoteReserves(reservesBefore) * tokenTotalSupply) / reservesBefore.base;
}
