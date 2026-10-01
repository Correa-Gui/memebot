import type { PumpEvent, TokenAmount } from '@memebot/core';
import { tokenUpdateFor } from './market-state.ts';
import { emptyTokenState } from './token-state.ts';
import type { MarketState, TokenState } from './types.ts';

/**
 * Política de compactação de memória do estado ao vivo (`MarketStore.compact`).
 *
 * `applyEvent` nunca descarta tokens: ao vivo isso cresce sem limite (dezenas de milhares de tokens
 * por dia, cada um com histórico de trades e saldos). Mas a estratégia só olha tokens dentro da
 * janela de idade de entrada (`entry.maxAgeSec`) e, fora dela, só precisa de `creator`/`createdAtMs`
 * de cada token das últimas 24 h (feature `creatorTokensCreated24h`).
 */
export interface CompactionPolicy {
  /** Até esta idade (ms) o token mantém o estado completo (trades, saldos, primeiros compradores). */
  fullStateMaxAgeMs: number;
  /** Depois desta idade (ms) o token é removido de vez (ex.: 24 h). Deve ser ≥ `fullStateMaxAgeMs`. */
  skeletonRetentionMs: number;
}

export type CompactionAction = 'keep' | 'compact' | 'drop';

function isCompact(token: TokenState): boolean {
  return token.trades.length === 0 && token.holderBalances.size === 0 && token.firstBuyers.length === 0;
}

/**
 * Decide o que fazer com um token na compactação (puro):
 * - `protectedToken` (posição aberta ou ordem pendente): `keep` sempre — saídas precisam dos trades;
 * - sem `createdAtMs` (criação não observada — token antigo negociando): `drop` (nunca entra no
 *   universo, que exige idade, nem conta para o filtro de criador; se negociar de novo, volta e é
 *   removido na próxima compactação);
 * - idade > `skeletonRetentionMs`: `drop`;
 * - idade > `fullStateMaxAgeMs` ou graduado (curva completou / migrou — fora do universo para
 *   sempre): `compact` (se ainda não estiver compacto);
 * - senão: `keep`.
 */
export function compactionActionFor(token: TokenState, nowMs: number, policy: CompactionPolicy, protectedToken: boolean): CompactionAction {
  if (protectedToken) return 'keep';
  if (token.createdAtMs === null) return 'drop';
  const ageMs = nowMs - token.createdAtMs;
  if (ageMs > policy.skeletonRetentionMs) return 'drop';
  const graduated = token.curveCompleted || token.venue === 'pumpswap';
  if ((ageMs > policy.fullStateMaxAgeMs || graduated) && !isCompact(token)) return 'compact';
  return 'keep';
}

/**
 * Esqueleto do token: mantém identidade, criador, horário/slot de criação, venue e reservas (poucos
 * bytes); descarta histórico de trades, saldos inferidos e primeiros compradores. Puro.
 */
export function compactTokenState(token: TokenState): TokenState {
  return { ...token, trades: [], holderBalances: new Map(), firstBuyers: [] };
}

/** Dados mínimos de um `token_created` gravado (pré-carga das últimas 24 h na partida). */
export interface TokenSkeleton {
  mint: string;
  creator: string;
  createdAtMs: number;
  createdAtSlot: bigint | null;
  quoteMint: string | null;
  tokenTotalSupply: TokenAmount | null;
}

/**
 * `TokenState` de um token pré-carregado do banco: só criador e horário (com `venue: 'unknown'` —
 * o histórico de trades não existe em memória). O orquestrador NÃO avalia esses tokens para entrada
 * (features de holders/volume estariam incompletas); servem só para o filtro de criador.
 */
export function skeletonTokenState(s: TokenSkeleton): TokenState {
  return {
    ...emptyTokenState(s.mint),
    creator: s.creator,
    createdAtMs: s.createdAtMs,
    createdAtSlot: s.createdAtSlot,
    quoteMint: s.quoteMint,
    tokenTotalSupply: s.tokenTotalSupply,
    creatorWallets: new Set([s.creator]),
  };
}

/**
 * Estado de mercado MUTÁVEL para o orquestrador ao vivo (paper/live). Usa o mesmo núcleo puro de
 * `applyEvent` (`tokenUpdateFor`) — mesmo resultado, garantido por teste de equivalência —, mas
 * atualiza os mapas no lugar em vez de copiar o `Map` de todos os tokens a cada evento (com ~300
 * eventos/s e dezenas de milhares de tokens, a cópia dominaria a CPU).
 *
 * `state` é uma visão viva (`MarketState`) para as funções puras (strategy, executor, positions):
 * não guarde referências a ela entre eventos esperando que fique congelada.
 */
export class MarketStore {
  private readonly tokens = new Map<string, TokenState>();
  private readonly poolToMint = new Map<string, string>();
  readonly state: MarketState = { tokens: this.tokens, poolToMint: this.poolToMint };

  get size(): number {
    return this.tokens.size;
  }

  /** Aplica um evento. Devolve o mint afetado (ou `null` se o evento não muda o mercado). */
  apply(event: PumpEvent): string | null {
    const update = tokenUpdateFor(this.state, event);
    if (!update) return null;
    this.tokens.set(update.mint, update.token);
    if (update.pool !== null) this.poolToMint.set(update.pool, update.mint);
    return update.mint;
  }

  /** Pré-carga: insere o esqueleto só se o mint ainda não estiver no estado (eventos ao vivo vencem). */
  seedSkeleton(skeleton: TokenSkeleton): boolean {
    if (this.tokens.has(skeleton.mint)) return false;
    this.tokens.set(skeleton.mint, skeletonTokenState(skeleton));
    return true;
  }

  /** Aplica `compactionActionFor` a todos os tokens. `isProtected(mint)`: posição aberta / ordem pendente. */
  compact(nowMs: number, policy: CompactionPolicy, isProtected: (mint: string) => boolean): { compacted: number; dropped: number } {
    let compacted = 0;
    let dropped = 0;
    for (const [mint, token] of this.tokens) {
      const action = compactionActionFor(token, nowMs, policy, isProtected(mint));
      if (action === 'drop') {
        this.tokens.delete(mint);
        dropped++;
      } else if (action === 'compact') {
        this.tokens.set(mint, compactTokenState(token));
        compacted++;
      }
    }
    return { compacted, dropped };
  }
}
