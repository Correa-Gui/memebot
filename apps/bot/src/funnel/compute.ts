import type { CurveInitialParams } from '@memebot/curve-math';
import {
  buySellVolumeRatio60s,
  creatorHoldingPct,
  creatorInitialBuyPct,
  creatorTokensCreated24h,
  largestSingleSellPctSupply60s,
  priceAboveMean120s,
  sameSlotBuyPct,
  top10HolderPct,
  uniqueBuyers60s,
  uniqueHolderCount,
  volume60sSol,
  curveProgress,
} from '@memebot/features';
import type { MarketState, TokenState } from '@memebot/state';
import type { StrategyV0Config } from '@memebot/strategy';

/**
 * Funil de rejeição (análise offline, não decide nada): para cada avaliação calcula TODAS as
 * features (sem parar no primeiro filtro que reprova, ao contrário de `evaluate`) e conta até onde o
 * token passa na ordem da STRATEGY §2 → §3 → §4.
 */
export interface FunnelSnapshot {
  mint: string;
  ageSec: number;
  quoteAllowed: boolean;
  top10HolderPct: number;
  /** v0 (como rodou no paper de 01/10): inclui a compra do criador no slot de criação. */
  sameSlotBuyPctV0: number;
  /** v0.1: só carteiras diferentes do criador. */
  sameSlotBuyPct: number;
  creatorInitialBuyPct: number;
  creatorHoldingPct: number;
  creatorTokensCreated24h: number;
  uniqueHolders: number;
  volume60sSol: number;
  buySellVolumeRatio60s: number;
  uniqueBuyers60s: number;
  priceAboveMean120s: boolean | null;
  largestSingleSellPctSupply60s: number;
  curveProgress: number;
}

const nan = (x: number | null): number => x ?? Number.NaN;

/** % do supply comprado no slot de criação por QUALQUER carteira (definição v0). */
function sameSlotAllWallets(token: TokenState): number {
  if (token.createdAtSlot === null || token.tokenTotalSupply === null || token.tokenTotalSupply <= 0n) return Number.NaN;
  let bought = 0n;
  for (const t of token.trades) if (t.side === 'buy' && t.slot === token.createdAtSlot) bought += t.tokenAmount;
  return Number(bought) / Number(token.tokenTotalSupply);
}

export function snapshot(
  market: MarketState,
  token: TokenState,
  nowMs: number,
  config: StrategyV0Config,
  curveParams: CurveInitialParams,
): FunnelSnapshot {
  return {
    mint: token.mint,
    ageSec: token.createdAtMs === null ? Number.NaN : (nowMs - token.createdAtMs) / 1000,
    quoteAllowed: token.quoteMint !== null && config.filters.allowedQuoteMints.includes(token.quoteMint),
    top10HolderPct: nan(top10HolderPct(token)),
    sameSlotBuyPctV0: sameSlotAllWallets(token),
    sameSlotBuyPct: nan(sameSlotBuyPct(token)),
    creatorInitialBuyPct: nan(creatorInitialBuyPct(token)),
    creatorHoldingPct: nan(creatorHoldingPct(token)),
    creatorTokensCreated24h: creatorTokensCreated24h(market, token, nowMs),
    uniqueHolders: uniqueHolderCount(token),
    volume60sSol: volume60sSol(token, nowMs),
    buySellVolumeRatio60s: nan(buySellVolumeRatio60s(token, nowMs)),
    uniqueBuyers60s: uniqueBuyers60s(token, nowMs),
    priceAboveMean120s: priceAboveMean120s(token, nowMs),
    largestSingleSellPctSupply60s: nan(largestSingleSellPctSupply60s(token, nowMs)),
    curveProgress: curveProgress(token, curveParams),
  };
}

export interface FunnelStep {
  key: string;
  label: string;
  pass: (s: FunnelSnapshot) => boolean;
}

/**
 * Passos na ordem da STRATEGY (universo → §3 → §4). Valor desconhecido (NaN) passa, como em
 * `evaluate` (que só rejeita filtro com valor conhecido acima do limite), exceto onde `evaluate` exige
 * o valor (razão buy/sell e preço vs média).
 */
export function funnelSteps(config: StrategyV0Config, sameSlotVersion: 'v0' | 'v0.1'): FunnelStep[] {
  const f = config.filters;
  const e = config.entry;
  const le = (x: number, max: number): boolean => Number.isNaN(x) || x <= max;
  return [
    { key: 'allowedQuoteMints', label: 'universo: quote SOL', pass: (s) => s.quoteAllowed },
    { key: 'maxTop10PctSupply', label: `top10 ≤ ${String(f.maxTop10PctSupply)}`, pass: (s) => le(s.top10HolderPct, f.maxTop10PctSupply) },
    {
      key: 'maxSameSlotAsCreatePct',
      label: `slot de criação ≤ ${String(f.maxSameSlotAsCreatePct)} (${sameSlotVersion})`,
      pass: (s) => le(sameSlotVersion === 'v0' ? s.sameSlotBuyPctV0 : s.sameSlotBuyPct, f.maxSameSlotAsCreatePct),
    },
    { key: 'maxCreatorHoldingPct', label: `criador segura ≤ ${String(f.maxCreatorHoldingPct)}`, pass: (s) => le(s.creatorHoldingPct, f.maxCreatorHoldingPct) },
    { key: 'maxCreatorTokens24h', label: `criador < ${String(f.maxCreatorTokens24h)} tokens/24h`, pass: (s) => s.creatorTokensCreated24h < f.maxCreatorTokens24h },
    { key: 'minUniqueHolders', label: `holders ≥ ${String(f.minUniqueHolders)}`, pass: (s) => s.uniqueHolders >= f.minUniqueHolders },
    { key: 'minVolume60sSol', label: `volume 60s ≥ ${String(f.minVolume60sSol)} SOL`, pass: (s) => s.volume60sSol >= f.minVolume60sSol },
    {
      key: 'minBuySellVolumeRatio60s',
      label: `GATILHO buy/sell 60s ≥ ${String(e.minBuySellVolumeRatio60s)}`,
      pass: (s) => !Number.isNaN(s.buySellVolumeRatio60s) && s.buySellVolumeRatio60s >= e.minBuySellVolumeRatio60s,
    },
    { key: 'minUniqueBuyers60s', label: `GATILHO compradores 60s ≥ ${String(e.minUniqueBuyers60s)}`, pass: (s) => s.uniqueBuyers60s >= e.minUniqueBuyers60s },
    {
      key: 'requirePriceAboveMean120s',
      label: 'GATILHO preço > média 120s',
      pass: (s) => !e.requirePriceAboveMean120s || s.priceAboveMean120s === true,
    },
    {
      key: 'maxSingleSellPctSupply60s',
      label: `GATILHO maior venda 60s ≤ ${String(e.maxSingleSellPctSupply60s)}`,
      pass: (s) => le(s.largestSingleSellPctSupply60s, e.maxSingleSellPctSupply60s),
    },
  ];
}

/** Quantos passos consecutivos (a partir do primeiro) o snapshot passa. */
export function stageReached(s: FunnelSnapshot, steps: readonly FunnelStep[]): number {
  let i = 0;
  while (i < steps.length && steps[i]?.pass(s) === true) i++;
  return i;
}

export interface FunnelResult {
  tokens: number;
  evaluations: number;
  /** passed[k] = tokens que passaram os passos 0..k em ALGUMA avaliação. */
  passed: number[];
  /** Snapshot de cada token no momento em que atingiu o seu melhor estágio pela primeira vez. */
  bestSnapshots: FunnelSnapshot[];
}

/** Agrega as avaliações (em ordem cronológica) de todos os tokens. */
export function computeFunnel(evaluations: readonly FunnelSnapshot[], steps: readonly FunnelStep[]): FunnelResult {
  const best = new Map<string, { stage: number; snap: FunnelSnapshot }>();
  for (const s of evaluations) {
    const stage = stageReached(s, steps);
    const cur = best.get(s.mint);
    if (!cur || stage > cur.stage) best.set(s.mint, { stage, snap: s });
  }
  const passed = steps.map((_, k) => [...best.values()].filter((b) => b.stage > k).length);
  return { tokens: best.size, evaluations: evaluations.length, passed, bestSnapshots: [...best.values()].map((b) => b.snap) };
}

/** Percentil por interpolação linear (ignora NaN). `null` sem valores. */
export function percentile(values: readonly number[], p: number): number | null {
  const v = values.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = v[lo] ?? 0;
  const b = v[hi] ?? a;
  return a + (b - a) * (idx - lo);
}
