import type { PumpEvent } from '@memebot/core';
import { applyCurveTrade, applyPumpSwapTrade, applyTokenCreated, emptyTokenState, markCurveCompleted, markPoolCreated } from './token-state.ts';
import type { MarketState, TokenState } from './types.ts';

export function createEmptyMarketState(): MarketState {
  return { tokens: new Map(), poolToMint: new Map() };
}

function getOrCreateToken(state: MarketState, mint: string): TokenState {
  return state.tokens.get(mint) ?? emptyTokenState(mint);
}

function withToken(state: MarketState, mint: string, token: TokenState): MarketState {
  const tokens = new Map(state.tokens);
  tokens.set(mint, token);
  return { ...state, tokens };
}

/**
 * Função pura `(state, event) => newState` (CLAUDE.md §6): sem I/O, sem `Date.now()`, sem
 * aleatoriedade. `event.ts`/`event.slot` são a única noção de tempo usada. Eventos que não
 * identificam um mint resolvível (PumpSwap com pool ainda não resolvida e sem `pool_created`
 * conhecido) são ignorados — ficam só no `raw_b64` gravado pelo recorder, não no estado em
 * memória; a `v_trades` do ClickHouse resolve isso para o backtest offline.
 */
export function applyEvent(state: MarketState, event: PumpEvent): MarketState {
  switch (event.kind) {
    case 'token_created': {
      const token = applyTokenCreated(getOrCreateToken(state, event.mint), event);
      return withToken(state, event.mint, token);
    }

    case 'trade': {
      if (event.venue === 'curve') {
        const token = applyCurveTrade(getOrCreateToken(state, event.mint), event);
        return withToken(state, event.mint, token);
      }
      // PumpSwap
      const mint = event.mint || state.poolToMint.get(event.pool) || '';
      if (!mint) return state; // pool ainda não resolvida e sem pool_created conhecido: ignora.
      const token = applyPumpSwapTrade(getOrCreateToken(state, mint), event);
      return withToken(state, mint, token);
    }

    case 'curve_completed': {
      const token = markCurveCompleted(getOrCreateToken(state, event.mint));
      return withToken(state, event.mint, token);
    }

    case 'pool_created': {
      const poolToMint = new Map(state.poolToMint);
      poolToMint.set(event.pool, event.mint);
      const token = markPoolCreated(getOrCreateToken(state, event.mint));
      const withPoolMap = { ...state, poolToMint };
      return withToken(withPoolMap, event.mint, token);
    }

    case 'tx_cost':
      // Não é por-mint; não afeta o MarketState (fica só gravado via recorder, para calibrar custos).
      return state;

    default:
      return state;
  }
}
