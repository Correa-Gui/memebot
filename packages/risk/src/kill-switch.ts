import type { Lamports } from '@memebot/core';

/** Gatilhos do kill switch (docs/RISK_AND_SECURITY.md §3), na ordem em que são avaliados. */
export type KillSwitchReason = 'stop_file' | 'daily_loss' | 'consecutive_failures' | 'stream_stale' | 'balance_divergence';

/** Parâmetros do kill switch com os valores de RISK §3. */
export interface KillSwitchParams {
  maxConsecutiveTxFailures: number;
  streamStaleMs: number;
  /** Divergência máxima saldo esperado × on-chain, em bps do esperado (100 = 1%). */
  maxBalanceDivergenceBps: bigint;
}

export const KILL_SWITCH_DEFAULTS: KillSwitchParams = {
  maxConsecutiveTxFailures: 5,
  streamStaleMs: 30_000,
  maxBalanceDivergenceBps: 100n,
};

/**
 * Entradas do kill switch. Tudo já calculado por quem chama — a lógica é pura:
 * - `stopFilePresent`: vem do adaptador `isStopFilePresent` (`stop-file.ts`), único I/O do pacote.
 * - `lastStreamEventMs`: ts (relógio do `Clock`) do último evento recebido; `null` = nenhum ainda,
 *   tratado como stream parado (conservador: sem dados não há base para entrar).
 * - `balance`: só no live (saldo esperado pelo ledger × saldo on-chain). No paper não existe saldo
 *   on-chain para comparar: passe `null` e o gatilho fica inativo (documentado).
 */
export interface KillSwitchInputs {
  nowMs: number;
  dailyRealizedLossLamports: Lamports;
  consecutiveTxFailures: number;
  lastStreamEventMs: number | null;
  balance: { expectedLamports: Lamports; onchainLamports: Lamports } | null;
  stopFilePresent: boolean;
}

export interface KillSwitchStatus {
  active: boolean;
  reasons: KillSwitchReason[];
}

function balanceDiverges(balance: NonNullable<KillSwitchInputs['balance']>, maxBps: bigint): boolean {
  const diff = balance.expectedLamports > balance.onchainLamports
    ? balance.expectedLamports - balance.onchainLamports
    : balance.onchainLamports - balance.expectedLamports;
  if (balance.expectedLamports <= 0n) return diff > 0n;
  return diff * 10_000n > balance.expectedLamports * maxBps;
}

/**
 * Avalia o kill switch. Ativo bloqueia só NOVAS entradas (`approveEntry`); posições abertas
 * continuam sendo gerenciadas até a saída (RISK §3) — `packages/positions` não consulta isto.
 */
export function evaluateKillSwitch(
  inputs: KillSwitchInputs,
  maxDailyLossLamports: Lamports,
  params: KillSwitchParams = KILL_SWITCH_DEFAULTS,
): KillSwitchStatus {
  const reasons: KillSwitchReason[] = [];
  if (inputs.stopFilePresent) reasons.push('stop_file');
  if (inputs.dailyRealizedLossLamports >= maxDailyLossLamports) reasons.push('daily_loss');
  if (inputs.consecutiveTxFailures >= params.maxConsecutiveTxFailures) reasons.push('consecutive_failures');
  if (inputs.lastStreamEventMs === null || inputs.nowMs - inputs.lastStreamEventMs >= params.streamStaleMs) {
    reasons.push('stream_stale');
  }
  if (inputs.balance !== null && balanceDiverges(inputs.balance, params.maxBalanceDivergenceBps)) {
    reasons.push('balance_divergence');
  }
  return { active: reasons.length > 0, reasons };
}
