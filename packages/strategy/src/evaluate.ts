import type { Clock } from '@memebot/core';
import type { CurveInitialParams } from '@memebot/curve-math';
import {
  buySellVolumeRatio60s,
  creatorHoldingPct,
  creatorInitialBuyPct,
  creatorTokensCreated24h,
  curveProgress,
  largestSingleSellPctSupply60s,
  priceAboveMean120s,
  priceVsMean120s,
  riskScore,
  sameSlotBuyPct,
  tokenAgeSec,
  top10HolderPct,
  uniqueBuyers60s,
  uniqueHolderCount,
  volume60sSol,
} from '@memebot/features';
import type { MarketState, TokenState } from '@memebot/state';
import type { StrategyV0Config } from './config.ts';
import type { Decision } from './decision.ts';

function reject(mint: string, reason: string): Decision[] {
  return [{ outcome: 'reject', mint, reason }];
}

/** Valores dos filtros duros já calculados (entram no snapshot de features do `enter`). */
export interface HardFilterValues {
  top10Pct: number | null;
  sameSlotPct: number | null;
  creatorHeldPct: number | null;
  creatorTokens24h: number;
  uniqueHolders: number;
  volumeSol: number;
  risk: { value: number; missing: boolean };
}

export type HardFilterResult = { ok: true; values: HardFilterValues } | { ok: false; reason: string };

/**
 * Universo (§2: venue e quote mint; a idade fica com quem chama) + dados mínimos do token. Puro.
 * Devolve o motivo da primeira falha ou `null`.
 */
export function universeRejection(token: TokenState | undefined, config: StrategyV0Config): string | null {
  if (!token) return 'mint_not_found';
  if (token.createdAtMs === null || token.tokenTotalSupply === null || token.quoteMint === null) return 'insufficient_data';
  if (!config.filters.allowedVenues.includes(token.venue as 'curve' | 'pumpswap')) return 'venue_not_allowed';
  if (!config.filters.allowedQuoteMints.includes(token.quoteMint)) return 'allowedQuoteMints';
  return null;
}

/**
 * Filtros duros de `docs/STRATEGY.md` §3, na ordem da tabela, parando na primeira falha (motivo = chave
 * da config). Função pura, compartilhada por `evaluate` e pela reavaliação no disparo de um sinal
 * pendente (`confirmPendingEntry`).
 */
export function evaluateHardFilters(marketState: MarketState, token: TokenState, nowMs: number, config: StrategyV0Config): HardFilterResult {
  const top10Pct = top10HolderPct(token);
  if (top10Pct !== null && top10Pct > config.filters.maxTop10PctSupply) return { ok: false, reason: 'maxTop10PctSupply' };

  const sameSlotPct = sameSlotBuyPct(token);
  if (sameSlotPct !== null && sameSlotPct > config.filters.maxSameSlotAsCreatePct) return { ok: false, reason: 'maxSameSlotAsCreatePct' };

  const creatorHeldPct = creatorHoldingPct(token);
  if (creatorHeldPct !== null && creatorHeldPct > config.filters.maxCreatorHoldingPct) return { ok: false, reason: 'maxCreatorHoldingPct' };

  const creatorTokens24h = creatorTokensCreated24h(marketState, token, nowMs);
  if (creatorTokens24h >= config.filters.maxCreatorTokens24h) return { ok: false, reason: 'maxCreatorTokens24h' };

  const uniqueHolders = uniqueHolderCount(token);
  if (uniqueHolders < config.filters.minUniqueHolders) return { ok: false, reason: 'minUniqueHolders' };

  const volumeSol = volume60sSol(token, nowMs);
  if (volumeSol < config.filters.minVolume60sSol) return { ok: false, reason: 'minVolume60sSol' };

  // Risco (CLAUDE.md §3): modelo não existe ainda — sinal ausente nunca bloqueia a decisão.
  const risk = riskScore();
  if (!risk.missing && risk.value > config.filters.maxRiskScore) return { ok: false, reason: 'maxRiskScore' };

  return { ok: true, values: { top10Pct, sameSlotPct, creatorHeldPct, creatorTokens24h, uniqueHolders, volumeSol, risk } };
}

/** Snapshot de features do `enter` (mesmas chaves da v0/v0.1). */
export function enterFeatures(
  token: TokenState,
  ageSec: number,
  v: HardFilterValues,
  trigger: { ratio60s: number; buyers60s: number; largestSellPct: number | null },
  curveParams: CurveInitialParams,
): Record<string, number> {
  return {
    ageSec,
    curveProgress: curveProgress(token, curveParams),
    uniqueHolders: v.uniqueHolders,
    top10HolderPct: v.top10Pct ?? Number.NaN,
    sameSlotBuyPct: v.sameSlotPct ?? Number.NaN,
    buySellVolumeRatio60s: trigger.ratio60s,
    uniqueBuyers60s: trigger.buyers60s,
    volume60sSol: v.volumeSol,
    largestSingleSellPctSupply60s: trigger.largestSellPct ?? Number.NaN,
    creatorHoldingPct: v.creatorHeldPct ?? Number.NaN,
    creatorInitialBuyPct: creatorInitialBuyPct(token) ?? Number.NaN,
    creatorTokensCreated24h: v.creatorTokens24h,
    riskScore: v.risk.value,
  };
}

/**
 * Estratégia v0 (`docs/STRATEGY.md`): filtros duros (§3) + gatilho de momentum (§4), restrita ao
 * universo definido em §2 (só bonding curve, idade 60–600 s, quote SOL). Função **pura**: recebe
 * `clock` em vez de chamar `Date.now()` (CLAUDE.md §6), sem I/O — quem chama já carregou a config
 * com `loadStrategyConfig`, os parâmetros da curva com `parseCurveInitialParams` (conta `Global`
 * em `protocol_config`) e já tem o `MarketState` atualizado.
 *
 * Fora de escopo nesta tarefa (Fase 3/parte A do `docs/ROADMAP.md`): sizing, aprovação de risco
 * (`packages/risk`) e saídas (`packages/positions`, §5/§6 de `docs/STRATEGY.md`) — isso é "parte
 * B". Esta função só decide `reject`/`enter`, nunca `exit`, e não calcula `sizeLamports`.
 *
 * Ordem de avaliação (decisão desta tarefa, documentada): universo (§2) primeiro — venue, quote
 * mint, idade —, depois os filtros duros de §3 na ordem da tabela, depois o gatilho de §4.
 * **Para na primeira falha** (não avalia os filtros restantes) em vez de avaliar todos e agregar:
 * mais simples e suficiente para o paper trading decidir entrar/rejeitar; se o relatório de "quantos
 * tokens cada filtro barrou" (`docs/ROADMAP.md` Fase 3, item do `pnpm report`) precisar do motivo
 * de TODOS os filtros que falhariam, não só o primeiro, isso é um ajuste de escopo futuro (parte
 * B), não desta tarefa.
 *
 * Experimento de 2026-10-02 (docs/STRATEGY.md §8): com `entry.maxPriceAboveMean120sPct` definido, o
 * último passo rejeita (`maxPriceAboveMean120sPct`) quem estiver acima da média de 120 s por mais que a
 * fração configurada, e o snapshot ganha `priceVsMean120sPct`. Sem a opção, saída idêntica à v0.1.
 */
export function evaluate(
  marketState: MarketState,
  mint: string,
  clock: Clock,
  config: StrategyV0Config,
  curveParams: CurveInitialParams,
): Decision[] {
  const token = marketState.tokens.get(mint);
  const universe = universeRejection(token, config);
  if (universe !== null || !token) return reject(mint, universe ?? 'mint_not_found');

  const nowMs = clock.nowMs();

  const ageSec = tokenAgeSec(token, nowMs);
  if (ageSec === null) return reject(mint, 'insufficient_data');
  if (ageSec < config.entry.minAgeSec) return reject(mint, 'minAgeSec');
  if (ageSec > config.entry.maxAgeSec) return reject(mint, 'maxAgeSec');

  // --- Filtros duros (docs/STRATEGY.md §3, ordem da tabela) ---
  const hard = evaluateHardFilters(marketState, token, nowMs, config);
  if (!hard.ok) return reject(mint, hard.reason);

  // --- Gatilho de entrada (docs/STRATEGY.md §4, ordem da lista) ---
  const ratio60s = buySellVolumeRatio60s(token, nowMs);
  if (ratio60s === null || ratio60s < config.entry.minBuySellVolumeRatio60s) {
    return reject(mint, 'minBuySellVolumeRatio60s');
  }

  const buyers60s = uniqueBuyers60s(token, nowMs);
  if (buyers60s < config.entry.minUniqueBuyers60s) {
    return reject(mint, 'minUniqueBuyers60s');
  }

  if (config.entry.requirePriceAboveMean120s) {
    const aboveMean = priceAboveMean120s(token, nowMs);
    if (aboveMean !== true) {
      return reject(mint, 'requirePriceAboveMean120s');
    }
  }

  const largestSellPct = largestSingleSellPctSupply60s(token, nowMs);
  if (largestSellPct !== null && largestSellPct > config.entry.maxSingleSellPctSupply60s) {
    return reject(mint, 'maxSingleSellPctSupply60s');
  }

  const features = enterFeatures(token, ageSec, hard.values, { ratio60s, buyers60s, largestSellPct }, curveParams);

  // --- Hipótese (b) "não perseguir" (desligada por padrão) ---
  const maxAbove = config.entry.maxPriceAboveMean120sPct;
  if (maxAbove !== undefined) {
    const vsMean = priceVsMean120s(token, nowMs);
    if (vsMean === null || vsMean > maxAbove) return reject(mint, 'maxPriceAboveMean120sPct');
    features.priceVsMean120sPct = vsMean;
  }

  return [{ outcome: 'enter', mint, reason: 'momentum_trigger', features }];
}

