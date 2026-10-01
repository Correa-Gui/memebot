import type { Lamports, TokenAmount } from '@memebot/core';

/** Reservas conhecidas da bonding curve (venue `curve`), como emitidas pelo `TradeEvent`. */
export interface CurveReservesSnapshot {
  virtualQuote: bigint;
  virtualToken: TokenAmount;
  realQuote: bigint;
  realToken: TokenAmount;
}

/** Reservas conhecidas do pool PumpSwap (venue `pumpswap`), como emitidas pelo evento. */
export interface PumpSwapReservesSnapshot {
  pool: string;
  base: TokenAmount;
  quote: bigint;
}

/**
 * Registro mínimo de um trade observado, guardado para permitir recalcular janelas de tempo
 * (buy/sell volume, compradores únicos etc.) sob demanda — ver `windows.ts`. `ts` é o timestamp
 * do próprio evento on-chain (determinístico no replay), nunca `Date.now()`.
 */
export interface TradeRecord {
  ts: number;
  slot: bigint;
  venue: 'curve' | 'pumpswap';
  side: 'buy' | 'sell';
  trader: string;
  quoteAmount: Lamports;
  tokenAmount: TokenAmount;
  /**
   * Reservas virtuais da curva logo após este trade, como emitidas no próprio `TradeEvent`
   * (preço marginal = `virtualQuoteAfter / virtualTokenAfter`). `null` para trades do PumpSwap.
   */
  virtualQuoteAfter: bigint | null;
  virtualTokenAfter: TokenAmount | null;
}

/**
 * Estado conhecido de um token, inferido só pelos eventos observados dos programas Pump.fun e
 * PumpSwap (ver `docs/ARCHITECTURE.md` §8, "Holders e concentração são aproximações"):
 * transferências diretas de token fora desses programas NÃO aparecem aqui.
 */
export interface TokenState {
  mint: string;
  quoteMint: string | null;
  creator: string | null;
  tokenTotalSupply: TokenAmount | null;
  createdAtMs: number | null;
  /**
   * Slot do evento `token_created` (lacuna #1 do pedido da Fase 3/parte A: antes só havia
   * `createdAtMs`). Necessário para o filtro "% comprado no mesmo slot da criação" (proxy de
   * bundle, `docs/STRATEGY.md` §3), que precisa comparar `TradeRecord.slot` com o slot exato de
   * criação, não só o timestamp (dois eventos podem ter o mesmo `ts` em ms e slots diferentes).
   */
  createdAtSlot: bigint | null;
  bondingCurve: string | null;
  /** `curve` enquanto não migrou; `pumpswap` depois de `curve_completed`/`pool_created` + primeiro trade na pool. */
  venue: 'curve' | 'pumpswap' | 'unknown';
  /**
   * `true` depois de `curve_completed` (Fase 3/parte B): a curva não aceita mais trades, mesmo que
   * `venue` continue `curve` até o `pool_created`. O paper executor e `packages/positions` usam isso
   * para tratar a graduação assim que ela acontece (fechar no último preço da curva), sem esperar o
   * `pool_created`, e para nunca simular compra numa curva encerrada.
   */
  curveCompleted: boolean;
  curveReserves: CurveReservesSnapshot | null;
  pumpSwapReserves: PumpSwapReservesSnapshot | null;
  /**
   * Saldo de token inferido por carteira, só a partir de trades observados nos dois programas
   * (compra soma, venda subtrai). Não inclui transferências diretas (spl-token transfer, outra
   * DEX) — ver limitação documentada em `docs/ARCHITECTURE.md` §8. Nunca negativo por construção
   * (uma venda maior que o saldo conhecido indica saldo pré-existente fora da nossa visão; nesse
   * caso o saldo é truncado em 0, não fica negativo).
   */
  holderBalances: ReadonlyMap<string, TokenAmount>;
  /** Carteiras únicas que compraram, na ordem de chegada (primeiros compradores). */
  firstBuyers: readonly string[];
  /** Carteiras do criador observadas: pelo menos `creator` (de `token_created`); outras fontes ficam para `wallets/` (Fase 5). */
  creatorWallets: ReadonlySet<string>;
  /** Histórico de trades, mais antigo primeiro — usado pelos seletores de janela (`windows.ts`). */
  trades: readonly TradeRecord[];
}

/** Estado de todo o mercado conhecido: um `TokenState` por mint. */
export interface MarketState {
  tokens: ReadonlyMap<string, TokenState>;
  /** pool -> mint base, alimentado por `pool_created`; resolve trades do PumpSwap com `mint` vazio. */
  poolToMint: ReadonlyMap<string, string>;
}

/** Limite de carteiras guardadas em `firstBuyers` (evita crescimento sem limite em tokens muito negociados). */
export const FIRST_BUYERS_LIMIT = 50;

/** Limite de trades guardados por token em `trades` (mantém só os mais recentes; afeta só janelas longas). */
export const TRADE_HISTORY_LIMIT = 20_000;
