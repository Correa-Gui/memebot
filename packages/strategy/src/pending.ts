import type { CurveInitialParams } from '@memebot/curve-math';
import { buySellVolumeRatio60s, currentMarginalPrice, largestSingleSellPctSupply60s, tokenAgeSec, uniqueBuyers60s } from '@memebot/features';
import type { MarketState } from '@memebot/state';
import type { StrategyV0Config } from './config.ts';
import type { Decision, EnterDecision } from './decision.ts';
import { enterFeatures, evaluateHardFilters, universeRejection } from './evaluate.ts';

/**
 * Sinal de entrada pendente — hipóteses (a) "confirmação" e (c) "recuo" do experimento de 2026-10-02
 * (docs/STRATEGY.md §8). Desligado por padrão: com a v0.1 (`entryMode(config) === 'immediate'`) nada
 * aqui é usado e o orquestrador entra na hora, como antes.
 *
 * Tudo é puro: o orquestrador (`PaperEngine`) guarda um `PendingSignal` por mint, chama
 * `observePendingPrice` a cada trade daquele mint (preço marginal após o trade), `decidePendingSignal`
 * a cada trade e a cada tick (janelas por tempo) e, no disparo, `confirmPendingEntry` (reavaliação).
 * Preço = preço marginal da curva (`virtualQuote/virtualToken` após o último trade), lamports/unidade.
 */
export interface PendingSignal {
  mint: string;
  mode: 'confirmation' | 'pullback';
  /** Instante do gatilho (relógio do orquestrador). */
  signalMs: number;
  /** Preço marginal no instante do gatilho. */
  signalPrice: number;
  /** Mínimo / máximo / último preço marginal observados desde o gatilho (inclui o preço do sinal). */
  minPrice: number;
  maxPrice: number;
  lastPrice: number;
  /** Snapshot de features do gatilho (vai para o `enter`, prefixado com `signal_`). */
  signalFeatures: Readonly<Record<string, number>>;
}

export type PendingAction =
  | { action: 'wait' }
  | { action: 'fire' }
  | { action: 'cancel'; reason: string };

/** Cria o sinal a partir do `enter` da strategy; `null` sem preço (sem reservas — não deveria ocorrer). */
export function createPendingSignal(
  decision: EnterDecision,
  marketState: MarketState,
  nowMs: number,
  config: StrategyV0Config,
): PendingSignal | null {
  const token = marketState.tokens.get(decision.mint);
  const price = token ? currentMarginalPrice(token) : null;
  if (price === null || !(price > 0)) return null;
  const mode = config.entry.confirmation ? 'confirmation' : config.entry.pullback ? 'pullback' : null;
  if (mode === null) return null;
  return { mint: decision.mint, mode, signalMs: nowMs, signalPrice: price, minPrice: price, maxPrice: price, lastPrice: price, signalFeatures: decision.features };
}

/** Registra um novo preço marginal observado (trade do mint). */
export function observePendingPrice(signal: PendingSignal, price: number): PendingSignal {
  if (!(price > 0)) return signal;
  return {
    ...signal,
    lastPrice: price,
    minPrice: price < signal.minPrice ? price : signal.minPrice,
    maxPrice: price > signal.maxPrice ? price : signal.maxPrice,
  };
}

/**
 * Decide o sinal no instante `nowMs` (pura):
 *
 * (a) confirmação (`entry.confirmation = { windowSec, maxDipPct }`):
 *   - mínimo desde o sinal < preçoSinal × (1 − maxDipPct) → `cancel('confirmation_dip')` (na hora);
 *   - passou `windowSec` desde o sinal: último preço ≥ preço do sinal → `fire`; senão
 *     `cancel('confirmation_below_signal')`;
 *   - senão `wait`.
 *   "Sustentar" = nunca cair mais que `maxDipPct` abaixo do preço do sinal durante a janela E fechar a
 *   janela no preço do sinal ou acima.
 *
 * (c) recuo (`entry.pullback = { retracePct, windowSec, minUniqueBuyers60s }`):
 *   - último preço ≤ máximoDesdeOSinal × (1 − retracePct) → `fire` (o "pico" é o máximo do preço
 *     marginal observado do sinal até agora — a janela do máximo é a própria janela armada);
 *   - passou `windowSec` sem recuo → `cancel('pullback_expired')`;
 *   - senão `wait`.
 */
export function decidePendingSignal(signal: PendingSignal, nowMs: number, config: StrategyV0Config): PendingAction {
  const elapsedMs = nowMs - signal.signalMs;
  if (signal.mode === 'confirmation') {
    const c = config.entry.confirmation;
    if (!c) return { action: 'cancel', reason: 'confirmation_disabled' };
    if (signal.minPrice < signal.signalPrice * (1 - c.maxDipPct)) return { action: 'cancel', reason: 'confirmation_dip' };
    if (elapsedMs < c.windowSec * 1000) return { action: 'wait' };
    return signal.lastPrice >= signal.signalPrice ? { action: 'fire' } : { action: 'cancel', reason: 'confirmation_below_signal' };
  }
  const p = config.entry.pullback;
  if (!p) return { action: 'cancel', reason: 'pullback_disabled' };
  if (signal.lastPrice <= signal.maxPrice * (1 - p.retracePct)) return { action: 'fire' };
  if (elapsedMs >= p.windowSec * 1000) return { action: 'cancel', reason: 'pullback_expired' };
  return { action: 'wait' };
}

/**
 * Reavaliação no disparo de um sinal pendente (pura). Universo (venue/quote; a idade NÃO é checada de
 * novo — o sinal nasceu dentro da janela de idade e a espera pode passar de `maxAgeSec`) e os filtros
 * duros de §3 no instante do disparo. No recuo, também: `uniqueBuyers60s ≥ pullback.minUniqueBuyers60s`
 * e nenhuma venda individual > `entry.maxSingleSellPctSupply60s` nos últimos 60 s. Rejeição com motivo
 * `<modo>:<filtro>` (ex.: `confirmation:minVolume60sSol`). O `enter` leva as features do instante do
 * disparo (mesmas chaves da v0.1) + `signal_*` (gatilho) + `signalWaitMs`, `signalPrice`,
 * `signalMinPrice`, `signalMaxPrice`, `firePrice`.
 */
export function confirmPendingEntry(
  marketState: MarketState,
  signal: PendingSignal,
  nowMs: number,
  config: StrategyV0Config,
  curveParams: CurveInitialParams,
): Decision {
  const mint = signal.mint;
  const prefix = signal.mode;
  const rej = (reason: string): Decision => ({ outcome: 'reject', mint, reason: `${prefix}:${reason}` });
  const token = marketState.tokens.get(mint);
  const universe = universeRejection(token, config);
  if (universe !== null || !token) return rej(universe ?? 'mint_not_found');
  if (token.curveCompleted) return rej('curve_completed');
  const ageSec = tokenAgeSec(token, nowMs);
  if (ageSec === null) return rej('insufficient_data');

  const hard = evaluateHardFilters(marketState, token, nowMs, config);
  if (!hard.ok) return rej(hard.reason);

  const buyers60s = uniqueBuyers60s(token, nowMs);
  const largestSellPct = largestSingleSellPctSupply60s(token, nowMs);
  if (signal.mode === 'pullback') {
    const p = config.entry.pullback;
    if (p && buyers60s < p.minUniqueBuyers60s) return rej('minUniqueBuyers60s');
    if (largestSellPct !== null && largestSellPct > config.entry.maxSingleSellPctSupply60s) return rej('maxSingleSellPctSupply60s');
  }

  const ratio = buySellVolumeRatio60s(token, nowMs) ?? Number.NaN;
  const features: Record<string, number> = enterFeatures(token, ageSec, hard.values, { ratio60s: ratio, buyers60s, largestSellPct }, curveParams);
  for (const [k, v] of Object.entries(signal.signalFeatures)) features[`signal_${k}`] = v;
  features.signalWaitMs = nowMs - signal.signalMs;
  features.signalPrice = signal.signalPrice;
  features.signalMinPrice = signal.minPrice;
  features.signalMaxPrice = signal.maxPrice;
  features.firePrice = signal.lastPrice;
  return { outcome: 'enter', mint, reason: signal.mode === 'confirmation' ? 'momentum_confirmed' : 'momentum_pullback', features };
}
