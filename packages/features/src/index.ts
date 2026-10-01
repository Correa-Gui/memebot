import type { TokenAmount } from '@memebot/core';
import { marginalPrice } from '@memebot/curve-math';
import type { CurveInitialParams } from '@memebot/curve-math';
import type { MarketState, TokenState } from '@memebot/state';
import { buySellRatio, computeWindowStats, tokenAgeMs, topHolderConcentration } from '@memebot/state';

/**
 * `packages/features` v0 — Fase 3/parte A do `docs/ROADMAP.md`.
 *
 * Só regras (sem ML): cada função é pura, recebe o estado já calculado por `packages/state` e um
 * `nowMs`/`marketState` explícitos (nunca `Date.now()`), e devolve um número (ou `null` quando o
 * dado necessário ainda não é conhecido — ex.: token sem nenhum trade). `packages/strategy`
 * decide o que fazer com `null` (hoje: nunca usado como motivo de rejeição por si só, ver
 * `evaluate.ts`; dados insuficientes rejeitam antes de qualquer filtro específico).
 *
 * Toda feature documenta: fórmula, janela (se houver) e se é aproximação — pedido explícito da
 * tarefa, não decoração. A limitação de fundo (`docs/ARCHITECTURE.md` §8, "Holders e concentração
 * são aproximações") vale para toda feature que usa `holderBalances`/`trades`: só vê compras e
 * vendas através dos programas Pump.fun/PumpSwap, nunca transferências diretas de token.
 */

const ONE_MINUTE_MS = 60_000;
const TWO_MINUTES_MS = 120_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function toRatio(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  return Number(numerator) / Number(denominator);
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Idade do token em segundos no instante `nowMs`.
 * Fórmula: `(nowMs - token.createdAtMs) / 1000`. Sem janela (valor instantâneo).
 * Não é aproximação: `createdAtMs` vem direto do evento `token_created` (ts do próprio evento).
 * `null` se o token ainda não tem `token_created` conhecido.
 */
export function tokenAgeSec(token: TokenState, nowMs: number): number | null {
  const ageMs = tokenAgeMs(token, nowMs);
  return ageMs === null ? null : ageMs / 1000;
}

/**
 * Progresso da bonding curve: fração da reserva real inicial de tokens já vendida, `0` = curva
 * intacta, `1` = reserva esgotada (curva completa / prestes a migrar).
 * Fórmula: `(initialRealToken - curveReserves.realToken) / initialRealToken`, limitado a [0, 1].
 * `initialRealToken` = campo `initial_real_token_reserves` (u64) da conta `Global` do Pump.fun
 * (IDL `pump.json`, tipo `Global`), lido de `protocol_config` e convertido por
 * `parseCurveInitialParams` (`@memebot/curve-math`) — nunca hardcoded (CLAUDE.md §7).
 * Sem janela (valor instantâneo das últimas reservas conhecidas). Não é aproximação: `realToken`
 * vem direto do `TradeEvent`.
 * `0` se ainda não houve nenhum trade na curva (reservas não observadas — curva intacta).
 */
export function curveProgress(token: TokenState, curveParams: CurveInitialParams): number {
  if (token.curveReserves === null) return 0;
  const sold = curveParams.initialRealToken - token.curveReserves.realToken;
  return clamp01(toRatio(sold, curveParams.initialRealToken) ?? 0);
}

/**
 * Holders únicos observados (saldo inferido > 0).
 * Fórmula: conta as entradas de `holderBalances` com valor `> 0n` (lacuna #3: `holderBalances`
 * pode ter entradas com saldo 0, de quem vendeu tudo — essas não contam como "holder").
 * Sem janela (estado acumulado desde o início do token).
 * **Aproximação**: só conta carteiras que compraram/venderam via Pump.fun/PumpSwap observados
 * pelo ingest (`docs/ARCHITECTURE.md` §8) — transferências diretas não aparecem aqui.
 */
export function uniqueHolderCount(token: TokenState): number {
  let count = 0;
  for (const balance of token.holderBalances.values()) {
    if (balance > 0n) count++;
  }
  return count;
}

/**
 * % do supply concentrado nos top-10 holders (excluindo a própria curva/pool, que não aparece em
 * `holderBalances`). Reexporta `topHolderConcentration(token, 10)` de `packages/state/windows.ts`
 * (mesma fórmula e mesma aproximação documentada lá e em `docs/ARCHITECTURE.md` §8).
 * Sem janela (estado acumulado). `null` se `tokenTotalSupply` é desconhecido.
 */
export function top10HolderPct(token: TokenState): number | null {
  return topHolderConcentration(token, 10);
}

/**
 * % do supply comprado no slot de criação por carteiras DIFERENTES do criador (proxy de bundle,
 * `docs/STRATEGY.md` §3, v0.1). Fórmula: soma de `tokenAmount` das **compras** com `slot ===
 * token.createdAtSlot` e `trader ∉ token.creatorWallets`, dividido por `tokenTotalSupply`.
 * v0.1 (2026-10-01): a compra inicial do criador (72% dos tokens a fazem na mesma tx do create) saiu
 * daqui e é medida em `creatorInitialBuyPct`.
 * Sem janela de tempo (usa o slot exato, não uma janela de ms) — ver lacuna #1: exige
 * `TokenState.createdAtSlot`, adicionado em `packages/state` nesta tarefa.
 * **Aproximação**: (a) só conta compras no venue `curve` observadas pelo ingest — um bundle pode
 * usar carteiras que também vendem no mesmo slot, não capturado aqui; (b) herda a limitação geral
 * de `docs/ARCHITECTURE.md` §8 (sem transferências diretas).
 * `null` se `createdAtSlot` ou `tokenTotalSupply` são desconhecidos.
 */
export function sameSlotBuyPct(token: TokenState): number | null {
  if (token.createdAtSlot === null || token.tokenTotalSupply === null || token.tokenTotalSupply <= 0n) return null;
  let boughtInCreationSlot: TokenAmount = 0n;
  for (const t of token.trades) {
    if (t.side === 'buy' && t.slot === token.createdAtSlot && !token.creatorWallets.has(t.trader)) {
      boughtInCreationSlot += t.tokenAmount;
    }
  }
  return toRatio(boughtInCreationSlot, token.tokenTotalSupply);
}

/**
 * % do supply comprado pelo(s) criador(es) no slot de criação (a "compra inicial", que no Pump.fun
 * costuma vir na mesma transação do create). Fórmula: soma de `tokenAmount` das compras com
 * `slot === createdAtSlot` e `trader ∈ creatorWallets`, dividido por `tokenTotalSupply`.
 * Informativa (snapshot da decisão): o risco do criador é filtrado por `maxCreatorHoldingPct`
 * (quanto ainda segura). Herda as aproximações de `creatorHoldingPct`/ARCHITECTURE §8.
 * `null` se `createdAtSlot` ou `tokenTotalSupply` são desconhecidos.
 */
export function creatorInitialBuyPct(token: TokenState): number | null {
  if (token.createdAtSlot === null || token.tokenTotalSupply === null || token.tokenTotalSupply <= 0n) return null;
  let bought: TokenAmount = 0n;
  for (const t of token.trades) {
    if (t.side === 'buy' && t.slot === token.createdAtSlot && token.creatorWallets.has(t.trader)) bought += t.tokenAmount;
  }
  return toRatio(bought, token.tokenTotalSupply);
}

/**
 * Razão buy/sell em volume (quote) nos últimos 60 s.
 * Fórmula: `buyVolumeQuote / sellVolumeQuote` da janela (reexporta `computeWindowStats` +
 * `buySellRatio` de `packages/state/windows.ts`). Janela: 60 s a partir de `nowMs`.
 * `null` se não há volume de venda e nem de compra na janela; `+Infinity` se há compra e nenhuma
 * venda (ver `buySellRatio` em `packages/state`).
 */
export function buySellVolumeRatio60s(token: TokenState, nowMs: number): number | null {
  return buySellRatio(computeWindowStats(token, nowMs, ONE_MINUTE_MS));
}

/**
 * Compradores únicos nos últimos 60 s.
 * Fórmula: `computeWindowStats(token, nowMs, 60_000).uniqueBuyers`. Janela: 60 s.
 * Aproximação herdada de `docs/ARCHITECTURE.md` §8 (só trades observados nos dois programas).
 */
export function uniqueBuyers60s(token: TokenState, nowMs: number): number {
  return computeWindowStats(token, nowMs, ONE_MINUTE_MS).uniqueBuyers;
}

/**
 * Volume total (compra + venda) em quote (SOL) nos últimos 60 s, em SOL (float — métrica de
 * exibição/filtro, não valor monetário manipulado; o valor interno em lamports é `bigint`).
 * Fórmula: `(buyVolumeQuote + sellVolumeQuote) / 1_000_000_000` da janela de 60 s.
 * Decisão: usa volume **total** (compra + venda), não só compra — o filtro `minVolume60sSol` mede
 * atividade/liquidez do token, não só pressão compradora (isso já é o gatilho de momentum, §4).
 */
export function volume60sSol(token: TokenState, nowMs: number): number {
  const stats = computeWindowStats(token, nowMs, ONE_MINUTE_MS);
  const totalLamports = stats.buyVolumeQuote + stats.sellVolumeQuote;
  return Number(totalLamports) / 1_000_000_000;
}

/**
 * Maior venda individual nos últimos 60 s, como % do supply total.
 * Fórmula: `computeWindowStats(token, nowMs, 60_000).largestSellToken / tokenTotalSupply`.
 * Janela: 60 s. `null` se `tokenTotalSupply` é desconhecido.
 */
export function largestSingleSellPctSupply60s(token: TokenState, nowMs: number): number | null {
  if (token.tokenTotalSupply === null || token.tokenTotalSupply <= 0n) return null;
  const stats = computeWindowStats(token, nowMs, ONE_MINUTE_MS);
  return toRatio(stats.largestSellToken, token.tokenTotalSupply);
}

/**
 * Se o preço atual está acima da média dos últimos 120 s (`docs/STRATEGY.md` §4).
 *
 * Fórmula: para cada trade de curva em `[nowMs - 120 s, nowMs]`, preço marginal após o trade =
 * `virtualQuoteAfter / virtualTokenAfter` (reservas virtuais emitidas no próprio `TradeEvent`).
 * Preço atual = preço marginal após o trade mais recente da janela; média = média aritmética
 * simples (por trade, não ponderada por volume nem por tempo) dos preços marginais da janela,
 * incluindo o mais recente. Retorna `atual > média` (estrito).
 * Janela: 120 s. Não é aproximação: as reservas vêm direto dos eventos. Trades do PumpSwap
 * (sem reservas virtuais) são ignorados — fora do universo da v0 (`filters.allowedVenues`).
 *
 * `null` se não há nenhum trade de curva na janela.
 */
export function priceAboveMean120s(token: TokenState, nowMs: number): boolean | null {
  const from = nowMs - TWO_MINUTES_MS;
  const prices: number[] = [];
  for (const t of token.trades) {
    if (t.ts < from || t.ts > nowMs) continue;
    if (t.virtualQuoteAfter === null || t.virtualTokenAfter === null) continue;
    prices.push(marginalPrice({ virtualQuote: t.virtualQuoteAfter, virtualToken: t.virtualTokenAfter }));
  }
  const current = prices.at(-1);
  if (current === undefined) return null;
  const mean = prices.reduce((acc, p) => acc + p, 0) / prices.length;
  return current > mean;
}

/**
 * % do supply que o(s) criador(es) ainda segura(m).
 * Fórmula: soma de `holderBalances[w]` para toda carteira `w` em `token.creatorWallets`, dividido
 * por `tokenTotalSupply`. Sem janela (estado acumulado).
 * **Aproximação**: `creatorWallets` hoje só inclui o `creator` de `token_created` (outras
 * carteiras do criador são `packages/wallets`, Fase 5); e herda `docs/ARCHITECTURE.md` §8.
 * `null` se `tokenTotalSupply` é desconhecido.
 */
export function creatorHoldingPct(token: TokenState): number | null {
  if (token.tokenTotalSupply === null || token.tokenTotalSupply <= 0n) return null;
  let held: TokenAmount = 0n;
  for (const wallet of token.creatorWallets) {
    held += token.holderBalances.get(wallet) ?? 0n;
  }
  return toRatio(held, token.tokenTotalSupply);
}

/**
 * Quantos outros tokens o mesmo criador criou nas últimas 24 h (não conta o próprio `token`).
 * Fórmula: varre `marketState.tokens`, conta quantos têm `creator === token.creator` (não nulo),
 * mint diferente do avaliado, e `createdAtMs` dentro de `[nowMs - 24h, nowMs]`.
 * Janela: 24 h, ancorada em `nowMs`.
 *
 * **Decisão de design** (lacuna #4): esta é a única feature que recebe o `MarketState` inteiro em
 * vez de só o `TokenState` — precisa comparar contra outros tokens do mesmo criador, não dá para
 * calcular a partir de um único `TokenState`. Custo: varredura O(n) de todos os tokens conhecidos
 * em memória a cada chamada; aceitável para v0 (sem otimizar prematuramente — não há índice
 * `creator -> mints` ainda; se o volume de tokens tornar isso lento, criar esse índice é trabalho
 * futuro, não bloqueante aqui).
 * `0` se `token.creator` é desconhecido (não há como contar).
 */
export function creatorTokensCreated24h(marketState: MarketState, token: TokenState, nowMs: number): number {
  if (token.creator === null) return 0;
  const from = nowMs - ONE_DAY_MS;
  let count = 0;
  for (const other of marketState.tokens.values()) {
    if (other.mint === token.mint) continue;
    if (other.creator !== token.creator) continue;
    if (other.createdAtMs === null) continue;
    if (other.createdAtMs < from || other.createdAtMs > nowMs) continue;
    count++;
  }
  return count;
}

/**
 * Score do modelo de risco on-chain (`signals/risk-model`, XGBoost → ONNX).
 *
 * O modelo ainda não existe (`docs/ROADMAP.md` Fase 5, condicional). Segue a convenção de
 * `CLAUDE.md` §3 para serviços externos/sinais ausentes: valor `NaN` + flag `missing: true`,
 * **nunca** um valor que pareça real. `packages/strategy` deve tratar `missing: true` como "não
 * filtra por isso" (o filtro `maxRiskScore` nunca rejeita enquanto o sinal estiver ausente) — ver
 * `evaluate.ts`.
 */
export function riskScore(): { value: number; missing: boolean } {
  return { value: Number.NaN, missing: true };
}
