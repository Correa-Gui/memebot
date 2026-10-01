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
  riskScore,
  sameSlotBuyPct,
  tokenAgeSec,
  top10HolderPct,
  uniqueBuyers60s,
  uniqueHolderCount,
  volume60sSol,
} from '@memebot/features';
import type { MarketState } from '@memebot/state';
import type { StrategyV0Config } from './config.ts';
import type { Decision } from './decision.ts';

function reject(mint: string, reason: string): Decision[] {
  return [{ outcome: 'reject', mint, reason }];
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
 */
export function evaluate(
  marketState: MarketState,
  mint: string,
  clock: Clock,
  config: StrategyV0Config,
  curveParams: CurveInitialParams,
): Decision[] {
  const token = marketState.tokens.get(mint);
  if (!token) return reject(mint, 'mint_not_found');

  if (token.createdAtMs === null || token.tokenTotalSupply === null || token.quoteMint === null) {
    return reject(mint, 'insufficient_data');
  }

  const nowMs = clock.nowMs();

  // --- Universo (docs/STRATEGY.md §2) ---
  if (!config.filters.allowedVenues.includes(token.venue as 'curve' | 'pumpswap')) {
    return reject(mint, 'venue_not_allowed');
  }
  if (!config.filters.allowedQuoteMints.includes(token.quoteMint)) {
    return reject(mint, 'allowedQuoteMints');
  }

  const ageSec = tokenAgeSec(token, nowMs);
  if (ageSec === null) return reject(mint, 'insufficient_data');
  if (ageSec < config.entry.minAgeSec) return reject(mint, 'minAgeSec');
  if (ageSec > config.entry.maxAgeSec) return reject(mint, 'maxAgeSec');

  // --- Filtros duros (docs/STRATEGY.md §3, ordem da tabela) ---
  const top10Pct = top10HolderPct(token);
  if (top10Pct !== null && top10Pct > config.filters.maxTop10PctSupply) {
    return reject(mint, 'maxTop10PctSupply');
  }

  const sameSlotPct = sameSlotBuyPct(token);
  if (sameSlotPct !== null && sameSlotPct > config.filters.maxSameSlotAsCreatePct) {
    return reject(mint, 'maxSameSlotAsCreatePct');
  }

  const creatorHeldPct = creatorHoldingPct(token);
  if (creatorHeldPct !== null && creatorHeldPct > config.filters.maxCreatorHoldingPct) {
    return reject(mint, 'maxCreatorHoldingPct');
  }

  const creatorTokens24h = creatorTokensCreated24h(marketState, token, nowMs);
  if (creatorTokens24h >= config.filters.maxCreatorTokens24h) {
    return reject(mint, 'maxCreatorTokens24h');
  }

  const uniqueHolders = uniqueHolderCount(token);
  if (uniqueHolders < config.filters.minUniqueHolders) {
    return reject(mint, 'minUniqueHolders');
  }

  const volumeSol = volume60sSol(token, nowMs);
  if (volumeSol < config.filters.minVolume60sSol) {
    return reject(mint, 'minVolume60sSol');
  }

  // Risco (CLAUDE.md §3): modelo não existe ainda — sinal ausente nunca bloqueia a decisão.
  const risk = riskScore();
  if (!risk.missing && risk.value > config.filters.maxRiskScore) {
    return reject(mint, 'maxRiskScore');
  }

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

  const progress = curveProgress(token, curveParams);
  return [
    {
      outcome: 'enter',
      mint,
      reason: 'momentum_trigger',
      features: {
        ageSec,
        curveProgress: progress,
        uniqueHolders,
        top10HolderPct: top10Pct ?? Number.NaN,
        sameSlotBuyPct: sameSlotPct ?? Number.NaN,
        buySellVolumeRatio60s: ratio60s,
        uniqueBuyers60s: buyers60s,
        volume60sSol: volumeSol,
        largestSingleSellPctSupply60s: largestSellPct ?? Number.NaN,
        creatorHoldingPct: creatorHeldPct ?? Number.NaN,
        creatorInitialBuyPct: creatorInitialBuyPct(token) ?? Number.NaN,
        creatorTokensCreated24h: creatorTokens24h,
        riskScore: risk.value,
      },
    },
  ];
}
