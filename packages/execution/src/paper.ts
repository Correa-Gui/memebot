import type { Lamports, TokenAmount } from '@memebot/core';
import { bondingCurveBuy, bondingCurveSell, effectiveQuoteReserves, pumpSwapBuyExactQuoteIn, pumpSwapSell } from '@memebot/curve-math';
import type { CurveFeeBps, CurveReserves, PumpSwapFeeBps, PumpSwapReserves } from '@memebot/curve-math';
import { HARD_LIMITS, assertWithinHardLimits, quoteInForBudget } from '@memebot/risk';
import type { EffectiveRiskLimits } from '@memebot/risk';
import type { MarketState, TokenState } from '@memebot/state';
import type { TxCostEstimate } from './costs.ts';
import { HardLimitViolationError, InvalidOrderError, PumpSwapSimulationNotValidatedError } from './errors.ts';
import { combinedCostSource } from './fill.ts';
import type { Fill, FillStatus } from './fill.ts';
import { mulberry32Next } from './prng.ts';

/**
 * Paper executor pessimista (ARCHITECTURE §5) como máquina de estados PURA, dirigida por eventos e
 * pelo relógio dos eventos — sem timers, sem `Date.now()`, sem I/O. Quem orquestra:
 * 1. `submitOrder` no instante da decisão `t` (guarda pendente com vencimento `t + latencyMs`);
 * 2. ANTES de aplicar cada evento de mercado com `ts = e`, chama `settleBeforeEvent(..., e)`: preenche
 *    as ordens com vencimento `< e` no `MarketState` atual, que já contém todos os eventos com
 *    `ts ≤ vencimento` (eventos com `ts == vencimento` entram, porque só se preenche antes de um
 *    evento estritamente posterior);
 * 3. em ticks sem evento (ao vivo), `settleOnTick(..., nowMs)` preenche vencimentos `≤ nowMs`.
 *
 * Pessimismos deliberados: latência; falha aleatória semeada (paga priority fee); expiração por
 * slippage (paga priority fee); custos = mediana × 1,5 ou fallback conservador; e a nossa própria
 * ordem NÃO é injetada no `MarketState` (os eventos gravados não a contêm) — a venda posterior não
 * se beneficia do preço que a nossa compra teria empurrado.
 */

export interface PaperExecutorParams {
  runId: string;
  /** `PAPER_LATENCY_MS`. */
  latencyMs: number;
  /** `PAPER_FAIL_RATE` ∈ [0, 1]. */
  failRate: number;
  /** Taxas da curva resolvidas da `protocol_config` (FeeConfig) pelo chamador. */
  fees: CurveFeeBps;
  /**
   * Rent-exempt da conta de token (o adaptador de borda obtém via `getMinimumBalanceForRentExemption`
   * do tamanho da conta). Injetado: nunca um número fixo no código.
   */
  tokenAccountRentLamports: Lamports;
  /**
   * Taxa base por assinatura (fee não-priority do runtime da Solana). Injetada pelo orquestrador a
   * partir de `LAMPORTS_PER_SIGNATURE` (`packages/ingest/src/onchain.ts`, fonte:
   * https://solana.com/docs/core/fees) — o número não é duplicado aqui. Cobrada em toda transação
   * que entra no bloco (filled, failed, expired), com `SIGNATURES_PER_TX` assinaturas.
   */
  baseFeeLamportsPerSignature: Lamports;
  /** De `estimateTxCosts`. Limitada aqui por `limits` e pelos hard limits. */
  costs: TxCostEstimate;
  /** Limites efetivos (já validados); conferidos de novo contra `HARD_LIMITS`. */
  limits: EffectiveRiskLimits;
  /**
   * `true` libera a simulação de swaps no PumpSwap (compra e venda de tokens GRADUADOS) com a matemática
   * exata de `curve-math/pumpswap.ts` (0 de diferença em 11,46 M de trades reais, 2026-10-03). Só o replay
   * de pesquisa liga (experimento do universo graduado); ausente = comportamento anterior: compra fora da
   * curva lança `PumpSwapSimulationNotValidatedError` e posição de curva que gradua fecha no último preço
   * da curva (`venue_unverified`).
   */
  pumpSwapEnabled?: boolean;
}

/**
 * Assinaturas por transação simulada: só a carteira quente assina (compra/venda na curva, com
 * criação/fechamento idempotente da ATA na mesma tx, como nas transações reais gravadas em
 * `packages/ingest/test/fixtures/curve-trade.json`, que têm 1 assinatura).
 */
export const SIGNATURES_PER_TX = 1n;

export interface BuyOrder {
  side: 'buy';
  decisionId: string;
  mint: string;
  /** Total a pagar à curva com as taxas da curva (`ApprovedEntry.sizeLamports`). */
  sizeLamports: Lamports;
  maxSlippageBps: number;
}

export interface SellOrder {
  side: 'sell';
  decisionId: string;
  mint: string;
  /** Fração da quantidade em carteira, em (0, 1]; 1 = zera a posição. */
  fraction: number;
  maxSlippageBps: number;
}

export type PaperOrder = BuyOrder | SellOrder;

interface PendingOrder {
  order: PaperOrder;
  /** Onde a ordem foi simulada na submissão (compra: venue do token; venda: venue da posição). */
  venue: 'curve' | 'pumpswap';
  seq: number;
  dueMs: number;
  /** Compra: total pago esperado; venda: líquido esperado. Nas reservas do instante da decisão. */
  expectedQuote: Lamports;
  /** Compra: tokens esperados; venda: tokens vendidos (fixados na submissão). */
  expectedTokens: TokenAmount;
}

export interface Holding {
  /** Onde a posição foi comprada: `pumpswap` só com `pumpSwapEnabled` (token graduado). */
  venue: 'curve' | 'pumpswap';
  tokenBalance: TokenAmount;
  /** Rent pago ao abrir a conta de token (devolvido quando a posição zera). */
  rentPaid: Lamports;
}

export interface PaperExecutorState {
  pending: readonly PendingOrder[];
  holdings: ReadonlyMap<string, Holding>;
  rngState: number;
  orderSeq: number;
}

export function createPaperExecutorState(seed: number): PaperExecutorState {
  return { pending: [], holdings: new Map(), rngState: seed >>> 0, orderSeq: 0 };
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function validateParams(params: PaperExecutorParams): void {
  assertWithinHardLimits(params.limits);
  if (!(params.failRate >= 0 && params.failRate <= 1)) throw new InvalidOrderError('failRate fora de [0, 1]');
  if (!Number.isFinite(params.latencyMs) || params.latencyMs < 0) throw new InvalidOrderError('latencyMs inválido');
  if (params.tokenAccountRentLamports < 0n) throw new InvalidOrderError('tokenAccountRentLamports negativo');
  if (params.baseFeeLamportsPerSignature < 0n) throw new InvalidOrderError('baseFeeLamportsPerSignature negativo');
}

function curveReservesOf(token: TokenState): CurveReserves | null {
  if (!token.curveReserves) return null;
  return { virtualQuote: token.curveReserves.virtualQuote, virtualToken: token.curveReserves.virtualToken };
}

/** Reservas e bps EFETIVOS do PumpSwap, se completos (offset virtual e bps conhecidos). */
function pumpSwapOf(token: TokenState): { reserves: PumpSwapReserves; fees: PumpSwapFeeBps } | null {
  const r = token.pumpSwapReserves;
  if (!r || r.virtualQuote === null || r.feeBps === null || r.base <= 0n) return null;
  return { reserves: { base: r.base, quote: r.quote, virtualQuote: r.virtualQuote }, fees: r.feeBps };
}

/** Token saiu da bonding curve (completou ou já migrou): só existe o último preço da curva. */
export function isGraduated(token: TokenState): boolean {
  return token.curveCompleted || token.venue === 'pumpswap';
}

/** Mints com posição em carteira ou compra pendente (o que conta para o máx. de posições). */
export function openMints(state: PaperExecutorState): Set<string> {
  const mints = new Set<string>();
  for (const [mint, h] of state.holdings) if (h.tokenBalance > 0n) mints.add(mint);
  for (const p of state.pending) if (p.order.side === 'buy') mints.add(p.order.mint);
  return mints;
}

/** Soma do tamanho das compras pendentes (para a exposição vista pelo risco). */
export function pendingBuyExposure(state: PaperExecutorState): Lamports {
  let total = 0n;
  for (const p of state.pending) if (p.order.side === 'buy') total += p.order.sizeLamports;
  return total;
}

function effectiveMaxSlippageBps(params: PaperExecutorParams): number {
  return Math.min(params.limits.maxSlippageBps, HARD_LIMITS.maxSlippageBps);
}

function checkSlippageBound(order: PaperOrder, params: PaperExecutorParams): void {
  if (!Number.isInteger(order.maxSlippageBps) || order.maxSlippageBps < 0) {
    throw new InvalidOrderError(`maxSlippageBps inválido: ${String(order.maxSlippageBps)}`);
  }
  const max = effectiveMaxSlippageBps(params);
  if (order.maxSlippageBps > max) {
    throw new HardLimitViolationError('maxSlippageBps', `${String(order.maxSlippageBps)} > ${String(max)}`);
  }
}

function sellTokenAmount(balance: TokenAmount, fraction: number): TokenAmount {
  if (fraction >= 1) return balance;
  const ppm = BigInt(Math.floor(fraction * 1_000_000));
  return (balance * ppm) / 1_000_000n;
}

/**
 * Registra uma ordem (instante da decisão = `nowMs`). Lança erro tipado se a ordem viola hard
 * limit (`HardLimitViolationError`), é inválida (`InvalidOrderError`) ou pediria simular uma
 * COMPRA fora da bonding curve (`PumpSwapSimulationNotValidatedError`).
 */
export function submitOrder(
  state: PaperExecutorState,
  params: PaperExecutorParams,
  order: PaperOrder,
  market: MarketState,
  nowMs: number,
): PaperExecutorState {
  validateParams(params);
  checkSlippageBound(order, params);
  const token = market.tokens.get(order.mint);
  if (!token) throw new InvalidOrderError(`mint desconhecido: ${order.mint}`);

  let expectedQuote: Lamports;
  let expectedTokens: TokenAmount;
  let venue: 'curve' | 'pumpswap' = 'curve';

  if (order.side === 'buy') {
    const maxPosition = minBigint(params.limits.maxPositionLamports, HARD_LIMITS.maxPositionLamports);
    if (order.sizeLamports <= 0n) throw new InvalidOrderError('sizeLamports deve ser positivo');
    if (order.sizeLamports > maxPosition) {
      throw new HardLimitViolationError('maxPositionLamports', `${order.sizeLamports.toString()} > ${maxPosition.toString()}`);
    }
    const open = openMints(state);
    if (open.has(order.mint)) throw new InvalidOrderError(`já existe posição ou compra pendente em ${order.mint}`);
    const maxOpen = Math.min(params.limits.maxOpenPositions, HARD_LIMITS.maxOpenPositions);
    if (open.size >= maxOpen) throw new HardLimitViolationError('maxOpenPositions', `${String(open.size)} >= ${String(maxOpen)}`);
    if (params.pumpSwapEnabled === true && token.venue === 'pumpswap') {
      // Token graduado (universo do replay): buy_exact_quote_in com spendable = tamanho.
      const ps = pumpSwapOf(token);
      if (!ps) throw new InvalidOrderError(`sem reservas completas do PumpSwap para ${order.mint}`);
      const sim = pumpSwapBuyExactQuoteIn(ps.reserves, order.sizeLamports, ps.fees);
      expectedQuote = sim.totalQuoteCost;
      expectedTokens = sim.baseOut;
      venue = 'pumpswap';
    } else {
      // Compra só na bonding curve: qualquer outra coisa seria simular um swap no PumpSwap.
      if (isGraduated(token) || token.venue !== 'curve') throw new PumpSwapSimulationNotValidatedError(order.mint);
      const reserves = curveReservesOf(token);
      if (!reserves) throw new InvalidOrderError(`sem reservas da curva para ${order.mint}`);
      const quoteIn = quoteInForBudget(order.sizeLamports, params.fees);
      if (quoteIn <= 0n) throw new InvalidOrderError('sizeLamports pequeno demais para as taxas da curva');
      const sim = bondingCurveBuy(reserves, quoteIn, params.fees);
      expectedQuote = sim.totalQuoteCost;
      expectedTokens = sim.tokenOut;
    }
  } else {
    if (!Number.isFinite(order.fraction) || order.fraction <= 0 || order.fraction > 1) {
      throw new InvalidOrderError(`fraction fora de (0, 1]: ${String(order.fraction)}`);
    }
    const holding = state.holdings.get(order.mint);
    if (!holding || holding.tokenBalance <= 0n) throw new InvalidOrderError(`sem posição para vender em ${order.mint}`);
    if (state.pending.some((p) => p.order.side === 'sell' && p.order.mint === order.mint)) {
      throw new InvalidOrderError(`já existe venda pendente em ${order.mint}`);
    }
    const tokens = sellTokenAmount(holding.tokenBalance, order.fraction);
    if (tokens <= 0n) throw new InvalidOrderError('quantidade a vender arredonda para 0');
    venue = holding.venue;
    if (holding.venue === 'pumpswap') {
      const ps = pumpSwapOf(token);
      if (!ps) throw new InvalidOrderError(`sem reservas completas do PumpSwap para ${order.mint}`);
      expectedQuote = pumpSwapSell(ps.reserves, tokens, ps.fees).netQuoteOut;
    } else {
      // Posição de curva que graduou: usa as últimas reservas conhecidas da curva (nunca o PumpSwap).
      const reserves = curveReservesOf(token);
      if (!reserves) throw new InvalidOrderError(`sem reservas da curva para ${order.mint}`);
      expectedQuote = bondingCurveSell(reserves, tokens, params.fees).netQuoteOut;
    }
    expectedTokens = tokens;
  }

  const seq = state.orderSeq + 1;
  return {
    ...state,
    orderSeq: seq,
    pending: [...state.pending, { order, venue, seq, dueMs: nowMs + params.latencyMs, expectedQuote, expectedTokens }],
  };
}

function priceOf(quote: Lamports, tokens: TokenAmount): number {
  return tokens > 0n ? Number(quote) / Number(tokens) : Number.NaN;
}

interface CostsForFill {
  priorityFee: Lamports;
  jitoTip: Lamports;
  capped: boolean;
}

/** Custos limitados por `limits` e pelos hard limits; o fill nunca ultrapassa nenhum dos dois. */
function cappedCosts(params: PaperExecutorParams): CostsForFill {
  const maxPriority = minBigint(params.limits.maxPriorityFeeLamports, HARD_LIMITS.maxPriorityFeeLamports);
  const maxTip = minBigint(params.limits.maxJitoTipLamports, HARD_LIMITS.maxJitoTipLamports);
  const priorityFee = minBigint(params.costs.priorityFeeLamports, maxPriority);
  const jitoTip = minBigint(params.costs.jitoTipLamports, maxTip);
  return {
    priorityFee,
    jitoTip,
    capped: priorityFee < params.costs.priorityFeeLamports || jitoTip < params.costs.jitoTipLamports,
  };
}

function baseFill(p: PendingOrder, params: PaperExecutorParams, costs: CostsForFill): Fill {
  return {
    runId: params.runId,
    ts: p.dueMs,
    decisionId: p.order.decisionId,
    mint: p.order.mint,
    side: p.order.side,
    solIn: 0n,
    solOut: 0n,
    tokenDelta: 0n,
    protocolFee: 0n,
    creatorFee: 0n,
    priorityFee: costs.priorityFee,
    jitoTip: 0n,
    rent: 0n,
    rentRefund: 0n,
    // Toda transação que entra no bloco paga a taxa base, inclusive as que falham ou expiram.
    baseFee: params.baseFeeLamportsPerSignature * SIGNATURES_PER_TX,
    expectedPriceLamportsPerUnit: priceOf(p.expectedQuote, p.expectedTokens),
    realizedPriceLamportsPerUnit: Number.NaN,
    slippageBps: 0,
    landedSlot: null,
    status: 'failed',
    error: null,
    venueUnverified: false,
    costEstimateSource: combinedCostSource(params.costs.priorityFeeSource, params.costs.jitoTipSource),
    priorityFeeSource: params.costs.priorityFeeSource,
    jitoTipSource: params.costs.jitoTipSource,
    costCappedByHardLimit: costs.capped,
    virtualQuoteBefore: null,
    virtualTokenBefore: null,
  };
}

function withReserves(fill: Fill, reserves: CurveReserves | null): Fill {
  if (!reserves) return fill;
  return { ...fill, virtualQuoteBefore: reserves.virtualQuote, virtualTokenBefore: reserves.virtualToken };
}

/** PumpSwap: "reservas antes" do fill = quote EFETIVO (vault + offset virtual) e base, o par do constant product. */
function withPumpSwapReserves(fill: Fill, ps: { reserves: PumpSwapReserves } | null): Fill {
  if (!ps) return fill;
  return { ...fill, virtualQuoteBefore: effectiveQuoteReserves(ps.reserves), virtualTokenBefore: ps.reserves.base };
}

/** Taxas do PumpSwap no `Fill`: `protocolFee` = lp + protocolo + cashback (tudo que não é do criador), `creatorFee` = criador. */
function pumpSwapFillFees(f: { lpFee: Lamports; protocolFee: Lamports; creatorFee: Lamports; cashbackFee: Lamports }): { protocolFee: Lamports; creatorFee: Lamports } {
  return { protocolFee: f.lpFee + f.protocolFee + f.cashbackFee, creatorFee: f.creatorFee };
}

function fillPumpSwapBuy(p: PendingOrder, order: BuyOrder, params: PaperExecutorParams, token: TokenState | undefined,
  holdings: ReadonlyMap<string, Holding>, failedDraw: boolean): FillOutcome {
  const costs = cappedCosts(params);
  const ps = token && token.venue === 'pumpswap' ? pumpSwapOf(token) : null;
  const fill = withPumpSwapReserves(baseFill(p, params, costs), ps);
  if (failedDraw) return { fill: unexecuted(fill, 'failed', 'simulated_tx_failure'), holdings };
  if (!ps) return { fill: unexecuted(fill, 'failed', 'pumpswap_unavailable_at_fill'), holdings };
  let sim: ReturnType<typeof pumpSwapBuyExactQuoteIn>;
  try {
    sim = pumpSwapBuyExactQuoteIn(ps.reserves, order.sizeLamports, ps.fees);
  } catch {
    return { fill: unexecuted(fill, 'failed', 'pumpswap_unavailable_at_fill'), holdings };
  }
  const realized = priceOf(sim.totalQuoteCost, sim.baseOut);
  const slippage = slippageBpsBuy(p.expectedQuote, p.expectedTokens, sim.totalQuoteCost, sim.baseOut);
  if (sim.baseOut <= 0n || buyExceedsSlippage(p, sim.totalQuoteCost, sim.baseOut, order.maxSlippageBps)) {
    return { fill: unexecuted(fill, 'expired', 'slippage_exceeded', realized, slippage), holdings };
  }
  const existing = holdings.get(order.mint);
  const rent = existing ? 0n : params.tokenAccountRentLamports;
  const next = new Map(holdings);
  next.set(order.mint, { venue: 'pumpswap', tokenBalance: (existing?.tokenBalance ?? 0n) + sim.baseOut, rentPaid: (existing?.rentPaid ?? 0n) + rent });
  return {
    fill: { ...fill, status: 'filled', solIn: sim.totalQuoteCost, tokenDelta: sim.baseOut, ...pumpSwapFillFees(sim), jitoTip: costs.jitoTip, rent, realizedPriceLamportsPerUnit: realized, slippageBps: slippage },
    holdings: next,
  };
}

function fillPumpSwapSell(p: PendingOrder, order: SellOrder, params: PaperExecutorParams, token: TokenState | undefined,
  holdings: ReadonlyMap<string, Holding>, failedDraw: boolean): FillOutcome {
  const costs = cappedCosts(params);
  const holding = holdings.get(order.mint);
  const ps = token ? pumpSwapOf(token) : null;
  const fill = withPumpSwapReserves(baseFill(p, params, costs), ps);
  if (!holding || holding.tokenBalance <= 0n || !ps) return { fill: unexecuted(fill, 'failed', 'no_position_or_reserves_at_fill'), holdings };
  if (failedDraw) return { fill: unexecuted(fill, 'failed', 'simulated_tx_failure'), holdings };
  const tokensIn = p.expectedTokens <= holding.tokenBalance ? p.expectedTokens : holding.tokenBalance;
  let sim: ReturnType<typeof pumpSwapSell>;
  try {
    sim = pumpSwapSell(ps.reserves, tokensIn, ps.fees);
  } catch {
    return { fill: unexecuted(fill, 'failed', 'pumpswap_unavailable_at_fill'), holdings };
  }
  const realized = priceOf(sim.netQuoteOut, tokensIn);
  const slippage = fill.expectedPriceLamportsPerUnit > 0 ? Math.round((1 - realized / fill.expectedPriceLamportsPerUnit) * 10_000) : 0;
  if (sellExceedsSlippage(p, sim.netQuoteOut, order.maxSlippageBps)) {
    return { fill: unexecuted(fill, 'expired', 'slippage_exceeded', realized, slippage), holdings };
  }
  const remaining = holding.tokenBalance - tokensIn;
  const next = new Map(holdings);
  let rentRefund = 0n;
  if (remaining === 0n) {
    next.delete(order.mint);
    rentRefund = holding.rentPaid;
  } else {
    next.set(order.mint, { ...holding, tokenBalance: remaining });
  }
  return {
    fill: { ...fill, status: 'filled', solOut: sim.netQuoteOut, tokenDelta: -tokensIn, ...pumpSwapFillFees(sim), jitoTip: costs.jitoTip, rentRefund, realizedPriceLamportsPerUnit: realized, slippageBps: slippage },
    holdings: next,
  };
}

/**
 * Transação que não executou (`failed`) ou expirou por slippage (`expired`): paga a priority fee e a
 * taxa base (pessimista: a transação entrou no bloco e falhou), NÃO paga o tip — o tip do Jito é uma
 * transferência dentro do bundle e reverte junto (bundle que falha não cobra tip). Posição intacta.
 */
function unexecuted(fill: Fill, status: Exclude<FillStatus, 'filled'>, error: string, realized = Number.NaN, slippageBps = 0): Fill {
  return { ...fill, status, error, jitoTip: 0n, realizedPriceLamportsPerUnit: realized, slippageBps };
}

function slippageBpsBuy(expectedQuote: bigint, expectedTokens: bigint, realQuote: bigint, realTokens: bigint): number {
  // (realQuote/realTokens) / (expectedQuote/expectedTokens) − 1
  if (realTokens <= 0n || expectedQuote <= 0n) return Number.POSITIVE_INFINITY;
  return Math.round((Number(realQuote * expectedTokens) / Number(expectedQuote * realTokens) - 1) * 10_000);
}

function buyExceedsSlippage(p: PendingOrder, realQuote: bigint, realTokens: bigint, maxBps: number): boolean {
  // realizado > esperado × (1 + max): exato em bigint, sem ponto flutuante.
  return realQuote * p.expectedTokens * 10_000n > p.expectedQuote * realTokens * (10_000n + BigInt(maxBps));
}

function sellExceedsSlippage(p: PendingOrder, realNet: bigint, maxBps: number): boolean {
  // mesma quantidade vendida: realizado < esperado × (1 − max)
  return realNet * 10_000n < p.expectedQuote * (10_000n - BigInt(maxBps));
}

interface FillOutcome {
  fill: Fill;
  holdings: ReadonlyMap<string, Holding>;
}

function fillBuy(p: PendingOrder, order: BuyOrder, params: PaperExecutorParams, token: TokenState | undefined,
  holdings: ReadonlyMap<string, Holding>, failedDraw: boolean): FillOutcome {
  const costs = cappedCosts(params);
  const reserves = token ? curveReservesOf(token) : null;
  const fill = withReserves(baseFill(p, params, costs), reserves);
  if (failedDraw) return { fill: unexecuted(fill, 'failed', 'simulated_tx_failure'), holdings };
  // A curva encerrou entre a decisão e o preenchimento: a compra na curva falharia on-chain.
  if (!token || !reserves || isGraduated(token)) return { fill: unexecuted(fill, 'failed', 'curve_unavailable_at_fill'), holdings };

  const sim = bondingCurveBuy(reserves, quoteInForBudget(order.sizeLamports, params.fees), params.fees);
  const realized = priceOf(sim.totalQuoteCost, sim.tokenOut);
  const slippage = slippageBpsBuy(p.expectedQuote, p.expectedTokens, sim.totalQuoteCost, sim.tokenOut);
  if (sim.tokenOut <= 0n || buyExceedsSlippage(p, sim.totalQuoteCost, sim.tokenOut, order.maxSlippageBps)) {
    return { fill: unexecuted(fill, 'expired', 'slippage_exceeded', realized, slippage), holdings };
  }

  const existing = holdings.get(order.mint);
  const rent = existing ? 0n : params.tokenAccountRentLamports;
  const next = new Map(holdings);
  next.set(order.mint, {
    venue: 'curve',
    tokenBalance: (existing?.tokenBalance ?? 0n) + sim.tokenOut,
    rentPaid: (existing?.rentPaid ?? 0n) + rent,
  });
  return {
    fill: {
      ...fill,
      status: 'filled',
      solIn: sim.totalQuoteCost,
      tokenDelta: sim.tokenOut,
      protocolFee: sim.protocolFee,
      creatorFee: sim.creatorFee,
      jitoTip: costs.jitoTip,
      rent,
      realizedPriceLamportsPerUnit: realized,
      slippageBps: slippage,
    },
    holdings: next,
  };
}

function fillSell(p: PendingOrder, order: SellOrder, params: PaperExecutorParams, token: TokenState | undefined,
  holdings: ReadonlyMap<string, Holding>, failedDraw: boolean): FillOutcome {
  const costs = cappedCosts(params);
  const holding = holdings.get(order.mint);
  const reserves = token ? curveReservesOf(token) : null;
  const fill = withReserves(baseFill(p, params, costs), reserves);
  if (!holding || holding.tokenBalance <= 0n || !token || !reserves) {
    return { fill: unexecuted(fill, 'failed', 'no_position_or_reserves_at_fill'), holdings };
  }

  const graduated = isGraduated(token);
  // Graduação com posição aberta (STRATEGY §2): fecha TUDO no último preço da curva, sem simular o
  // PumpSwap, sem sorteio de falha/slippage (não há execução real a simular), marcado venueUnverified.
  const tokensIn = graduated ? holding.tokenBalance : p.expectedTokens <= holding.tokenBalance ? p.expectedTokens : holding.tokenBalance;
  if (!graduated && failedDraw) return { fill: unexecuted(fill, 'failed', 'simulated_tx_failure'), holdings };

  const sim = bondingCurveSell(reserves, tokensIn, params.fees);
  const realized = priceOf(sim.netQuoteOut, tokensIn);
  // Comparação por preço (líquido por token): na graduação a quantidade pode diferir da submetida.
  const slippage = fill.expectedPriceLamportsPerUnit > 0 ? Math.round((1 - realized / fill.expectedPriceLamportsPerUnit) * 10_000) : 0;
  if (!graduated && sellExceedsSlippage(p, sim.netQuoteOut, order.maxSlippageBps)) {
    return { fill: unexecuted(fill, 'expired', 'slippage_exceeded', realized, slippage), holdings };
  }

  const remaining = holding.tokenBalance - tokensIn;
  const next = new Map(holdings);
  let rentRefund = 0n;
  if (remaining === 0n) {
    next.delete(order.mint);
    rentRefund = holding.rentPaid;
  } else {
    next.set(order.mint, { ...holding, tokenBalance: remaining });
  }
  return {
    fill: {
      ...fill,
      status: 'filled',
      solOut: sim.netQuoteOut,
      tokenDelta: -tokensIn,
      protocolFee: sim.protocolFee,
      creatorFee: sim.creatorFee,
      jitoTip: costs.jitoTip,
      rentRefund,
      realizedPriceLamportsPerUnit: realized,
      slippageBps: slippage,
      venueUnverified: graduated,
      error: graduated ? 'graduated_closed_at_last_curve_price' : null,
    },
    holdings: next,
  };
}

function settle(
  state: PaperExecutorState,
  params: PaperExecutorParams,
  market: MarketState,
  isDue: (dueMs: number) => boolean,
): { state: PaperExecutorState; fills: Fill[] } {
  validateParams(params);
  const fills: Fill[] = [];
  const remaining: PendingOrder[] = [];
  let holdings = state.holdings;
  let rngState = state.rngState;

  // `pending` está em ordem de submissão; com latência constante, também em ordem de vencimento.
  for (const p of state.pending) {
    if (!isDue(p.dueMs)) {
      remaining.push(p);
      continue;
    }
    // Um sorteio por ordem SEMPRE (mesmo quando não usado): a sequência do PRNG não depende de
    // ramificações, o que mantém o replay estável.
    const draw = mulberry32Next(rngState);
    rngState = draw.state;
    const failedDraw = draw.value < params.failRate;
    const token = market.tokens.get(p.order.mint);
    const outcome = p.venue === 'pumpswap'
      ? (p.order.side === 'buy' ? fillPumpSwapBuy(p, p.order, params, token, holdings, failedDraw) : fillPumpSwapSell(p, p.order, params, token, holdings, failedDraw))
      : p.order.side === 'buy'
        ? fillBuy(p, p.order, params, token, holdings, failedDraw)
        : fillSell(p, p.order, params, token, holdings, failedDraw);
    holdings = outcome.holdings;
    fills.push(outcome.fill);
  }

  return { state: { ...state, pending: remaining, holdings, rngState }, fills };
}

/** Antes de aplicar um evento com `ts = eventTs`: preenche as ordens com vencimento `< eventTs`. */
export function settleBeforeEvent(
  state: PaperExecutorState,
  params: PaperExecutorParams,
  marketBeforeEvent: MarketState,
  eventTs: number,
): { state: PaperExecutorState; fills: Fill[] } {
  return settle(state, params, marketBeforeEvent, (due) => due < eventTs);
}

/** Tick do relógio sem evento: preenche as ordens com vencimento `≤ nowMs`. */
export function settleOnTick(
  state: PaperExecutorState,
  params: PaperExecutorParams,
  market: MarketState,
  nowMs: number,
): { state: PaperExecutorState; fills: Fill[] } {
  return settle(state, params, market, (due) => due <= nowMs);
}
