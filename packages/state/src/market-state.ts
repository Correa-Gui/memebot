import type { PumpEvent } from '@memebot/core';
import { applyCurveTrade, applyPumpSwapTrade, applyTokenCreated, emptyTokenState, markCurveCompleted, markPoolCreated } from './token-state.ts';
import type { MarketState, TokenState } from './types.ts';

export function createEmptyMarketState(): MarketState {
  return { tokens: new Map(), poolToMint: new Map() };
}

/** Efeito de um evento sobre o mercado: o novo `TokenState` de um mint (+ pool → mint, se houver). */
export interface TokenUpdate {
  mint: string;
  token: TokenState;
  /** `pool_created`: pool nova a registrar em `poolToMint`. */
  pool: string | null;
}

/**
 * Núcleo puro compartilhado por `applyEvent` (imutável) e `MarketStore` (mutável, para o ao vivo):
 * calcula o novo `TokenState` do mint afetado sem tocar no estado recebido. `null` = o evento não
 * muda o mercado (`tx_cost`, ou PumpSwap com pool ainda não resolvida e sem `pool_created` conhecido —
 * fica só no `raw_b64` gravado pelo recorder; a `v_trades` do ClickHouse resolve isso offline).
 */
export function tokenUpdateFor(state: MarketState, event: PumpEvent): TokenUpdate | null {
  const current = (mint: string): TokenState => state.tokens.get(mint) ?? emptyTokenState(mint);
  switch (event.kind) {
    case 'token_created':
      return { mint: event.mint, token: applyTokenCreated(current(event.mint), event), pool: null };

    case 'trade': {
      if (event.venue === 'curve') {
        return { mint: event.mint, token: applyCurveTrade(current(event.mint), event), pool: null };
      }
      const mint = event.mint || state.poolToMint.get(event.pool) || '';
      if (!mint) return null;
      return { mint, token: applyPumpSwapTrade(current(mint), event), pool: null };
    }

    case 'curve_completed':
      return { mint: event.mint, token: markCurveCompleted(current(event.mint)), pool: null };

    case 'pool_created':
      return { mint: event.mint, token: markPoolCreated(current(event.mint)), pool: event.pool };

    case 'tx_cost':
      // Não é por-mint; não afeta o MarketState (fica só gravado via recorder, para calibrar custos).
      return null;

    default:
      return null;
  }
}

/**
 * Função pura `(state, event) => newState` (CLAUDE.md §6): sem I/O, sem `Date.now()`, sem
 * aleatoriedade. `event.ts`/`event.slot` são a única noção de tempo usada. Eventos que não
 * identificam um mint resolvível (PumpSwap com pool ainda não resolvida e sem `pool_created`
 * conhecido) são ignorados.
 *
 * Copia o `Map` de tokens a cada evento (O(nº de tokens)): ótimo para testes e replay curto; o
 * orquestrador ao vivo usa `MarketStore` (mesmo núcleo `tokenUpdateFor`, mapas mutáveis).
 */
export function applyEvent(state: MarketState, event: PumpEvent): MarketState {
  const update = tokenUpdateFor(state, event);
  if (!update) return state;
  const tokens = new Map(state.tokens);
  tokens.set(update.mint, update.token);
  if (update.pool === null) return { ...state, tokens };
  const poolToMint = new Map(state.poolToMint);
  poolToMint.set(update.pool, update.mint);
  return { tokens, poolToMint };
}
