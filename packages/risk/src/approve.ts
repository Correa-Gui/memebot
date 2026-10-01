import type { Clock, Lamports } from '@memebot/core';
import type { CurveFeeBps } from '@memebot/curve-math';
import type { TokenState } from '@memebot/state';
import type { EnterDecision } from '@memebot/strategy';
import { evaluateKillSwitch, KILL_SWITCH_DEFAULTS } from './kill-switch.ts';
import type { KillSwitchInputs, KillSwitchParams } from './kill-switch.ts';
import type { EffectiveRiskLimits } from './limits.ts';
import { dailyRealizedLoss, nextDecisionId, rollDay } from './risk-state.ts';
import type { RiskState } from './risk-state.ts';
import { computeEntrySize } from './sizing.ts';

/** Posições do run vistas pelo risco. Inclui compras ainda pendentes no executor (latência). */
export interface PortfolioSnapshot {
  /** Mints com posição aberta OU compra pendente. */
  openMints: ReadonlySet<string>;
  /** Soma do custo de entrada das posições abertas + tamanho das compras pendentes. */
  openExposureLamports: Lamports;
}

export interface ApproveEntryInput {
  decision: EnterDecision;
  token: TokenState | undefined;
  runId: string;
  limits: EffectiveRiskLimits;
  /** Taxas da curva já resolvidas de `protocol_config` (FeeConfig). */
  fees: CurveFeeBps;
  riskState: RiskState;
  portfolio: PortfolioSnapshot;
  /** Entradas do kill switch que não vêm do `RiskState` (perda diária e falhas seguidas vêm dele). */
  killSwitch: Pick<KillSwitchInputs, 'lastStreamEventMs' | 'balance' | 'stopFilePresent'>;
  killSwitchParams?: KillSwitchParams;
}

export interface ApprovedEntry {
  approved: true;
  decisionId: string;
  mint: string;
  /** Total a pagar à curva (com taxas da curva); ≤ `limits.maxPositionLamports`. */
  sizeLamports: Lamports;
  quoteAmountIn: Lamports;
  maxSlippageBps: number;
  priceImpactPct: number;
  sizeReduced: boolean;
}

export interface RejectedEntry {
  approved: false;
  decisionId: string;
  mint: string;
  /**
   * Chave do limite que barrou: `kill_switch:<gatilho>`, `position_already_open`, `maxOpenPositions`,
   * `maxHotWalletLamports`, `curve_unavailable`, `maxOwnPriceImpactPct`, `size_too_small`.
   */
  reason: string;
}

export type ApprovalResult = ApprovedEntry | RejectedEntry;

/**
 * Aprovação de risco de um `enter` da strategy (função pura). Ordem das checagens (para na primeira):
 * kill switch → posição já aberta no mint → máx. de posições → curva disponível (venue curve, não
 * completada, com reservas) → sizing/impacto → exposição máx. da carteira quente (precisa do tamanho).
 * Sempre devolve um `decisionId` determinístico (aprovado ou não: toda decisão é gravada).
 */
export function approveEntry(input: ApproveEntryInput, clock: Clock): { result: ApprovalResult; riskState: RiskState } {
  const nowMs = clock.nowMs();
  const { decision, limits } = input;
  const rolled = rollDay(input.riskState, nowMs);
  const { decisionId, state: riskState } = nextDecisionId(rolled, input.runId, decision.mint, nowMs);
  const reject = (reason: string): { result: ApprovalResult; riskState: RiskState } => ({
    result: { approved: false, decisionId, mint: decision.mint, reason },
    riskState,
  });

  const kill = evaluateKillSwitch(
    {
      nowMs,
      dailyRealizedLossLamports: dailyRealizedLoss(riskState, nowMs),
      consecutiveTxFailures: riskState.consecutiveTxFailures,
      ...input.killSwitch,
    },
    limits.maxDailyLossLamports,
    input.killSwitchParams ?? KILL_SWITCH_DEFAULTS,
  );
  const firstReason = kill.reasons[0];
  if (firstReason !== undefined) return reject(`kill_switch:${firstReason}`);

  if (input.portfolio.openMints.has(decision.mint)) return reject('position_already_open');
  if (input.portfolio.openMints.size >= limits.maxOpenPositions) return reject('maxOpenPositions');

  const token = input.token;
  if (!token?.curveReserves || token.venue !== 'curve' || token.curveCompleted) return reject('curve_unavailable');

  const sizing = computeEntrySize(
    { virtualQuote: token.curveReserves.virtualQuote, virtualToken: token.curveReserves.virtualToken },
    limits,
    input.fees,
  );
  if (!sizing.ok) return reject(sizing.reason);

  if (input.portfolio.openExposureLamports + sizing.sizeLamports > limits.maxHotWalletLamports) {
    return reject('maxHotWalletLamports');
  }

  return {
    result: {
      approved: true,
      decisionId,
      mint: decision.mint,
      sizeLamports: sizing.sizeLamports,
      quoteAmountIn: sizing.quoteAmountIn,
      maxSlippageBps: limits.maxSlippageBps,
      priceImpactPct: sizing.priceImpactPct,
      sizeReduced: sizing.reduced,
    },
    riskState,
  };
}
