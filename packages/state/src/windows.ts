import type { Lamports, TokenAmount } from '@memebot/core';
import type { TokenState, TradeRecord } from './types.ts';

/**
 * Agregados de uma janela de tempo (ex.: últimos 60 s) usados pelo gatilho de entrada em
 * `docs/STRATEGY.md` §4. Todos os seletores aqui são puros: recebem `nowMs` explícito (nunca
 * `Date.now()`) — quem chama decide o instante (tempo do evento atual, em tempo real ou replay).
 */
export interface WindowStats {
  buyVolumeQuote: Lamports;
  sellVolumeQuote: Lamports;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  /** Maior venda individual na janela, em token (para o filtro "nenhuma venda > 3% do supply"). */
  largestSellToken: TokenAmount;
}

function tradesInWindow(trades: readonly TradeRecord[], nowMs: number, windowMs: number): readonly TradeRecord[] {
  const from = nowMs - windowMs;
  // Supõe `trades` cronológico (mais antigo primeiro) — verdade enquanto quem chama `applyEvent`
  // alimentar os eventos em ordem (ingest ao vivo ou replay ordenado, nunca fora de ordem).
  // Varre do fim para parar assim que saturar a janela.
  const result: TradeRecord[] = [];
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (!t) continue;
    if (t.ts < from) break;
    if (t.ts > nowMs) continue; // nunca olha para o "futuro" relativo a nowMs (replay determinístico).
    result.push(t);
  }
  return result;
}

export function computeWindowStats(token: TokenState, nowMs: number, windowMs: number): WindowStats {
  const trades = tradesInWindow(token.trades, nowMs, windowMs);
  let buyVolumeQuote = 0n;
  let sellVolumeQuote = 0n;
  let buyCount = 0;
  let sellCount = 0;
  let largestSellToken = 0n;
  const buyers = new Set<string>();
  const sellers = new Set<string>();

  for (const t of trades) {
    if (t.side === 'buy') {
      buyVolumeQuote += t.quoteAmount;
      buyCount++;
      buyers.add(t.trader);
    } else {
      sellVolumeQuote += t.quoteAmount;
      sellCount++;
      sellers.add(t.trader);
      if (t.tokenAmount > largestSellToken) largestSellToken = t.tokenAmount;
    }
  }

  return {
    buyVolumeQuote,
    sellVolumeQuote,
    buyCount,
    sellCount,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    largestSellToken,
  };
}

/** Razão buy/sell em volume (quote) na janela; `null` se não houver volume de venda (evita divisão por zero). */
export function buySellRatio(stats: WindowStats): number | null {
  if (stats.sellVolumeQuote === 0n) return stats.buyVolumeQuote > 0n ? Number.POSITIVE_INFINITY : null;
  return Number(stats.buyVolumeQuote) / Number(stats.sellVolumeQuote);
}

/** Idade do token em ms no instante `nowMs`; `null` se `createdAtMs` ainda não é conhecido. */
export function tokenAgeMs(token: TokenState, nowMs: number): number | null {
  if (token.createdAtMs === null) return null;
  return nowMs - token.createdAtMs;
}

/** % do supply concentrado nos top-N holders (excluindo a própria curva/pool, que não aparece em `holderBalances`). */
export function topHolderConcentration(token: TokenState, topN: number): number | null {
  if (token.tokenTotalSupply === null || token.tokenTotalSupply === 0n) return null;
  const balances = [...token.holderBalances.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const top = balances.slice(0, topN).reduce((acc, b) => acc + b, 0n);
  return Number(top) / Number(token.tokenTotalSupply);
}
