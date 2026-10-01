import type { Lamports } from '@memebot/core';

const MS_PER_DAY = 86_400_000;

/**
 * Estado de risco acumulado do run (puro, imutável). Quem orquestra atualiza com as funções
 * abaixo a cada fill e a cada decisão; nada aqui lê relógio ou disco.
 */
export interface RiskState {
  /** Dia UTC (`floor(ms / 86_400_000)`) a que `dailyRealizedPnlLamports` se refere. */
  dayIndexUtc: number;
  /** PnL realizado no dia UTC corrente (negativo = perda). Inclui custos de transações falhas. */
  dailyRealizedPnlLamports: Lamports;
  /** Transações falhas/expiradas seguidas (zera no primeiro `filled`). */
  consecutiveTxFailures: number;
  /** Contador monotônico de decisões do run: entra no `decisionId` determinístico. */
  decisionSeq: number;
}

export function utcDayIndex(nowMs: number): number {
  return Math.floor(nowMs / MS_PER_DAY);
}

export function createRiskState(nowMs: number): RiskState {
  return { dayIndexUtc: utcDayIndex(nowMs), dailyRealizedPnlLamports: 0n, consecutiveTxFailures: 0, decisionSeq: 0 };
}

/** Vira o dia (UTC) se preciso: a perda diária começa do zero à meia-noite UTC. */
export function rollDay(state: RiskState, nowMs: number): RiskState {
  const day = utcDayIndex(nowMs);
  if (day === state.dayIndexUtc) return state;
  return { ...state, dayIndexUtc: day, dailyRealizedPnlLamports: 0n };
}

/** Soma PnL realizado (positivo ou negativo) ao dia UTC de `nowMs`. */
export function recordRealizedPnl(state: RiskState, pnlLamports: Lamports, nowMs: number): RiskState {
  const rolled = rollDay(state, nowMs);
  return { ...rolled, dailyRealizedPnlLamports: rolled.dailyRealizedPnlLamports + pnlLamports };
}

/**
 * Resultado de uma transação para o gatilho "5 falhas seguidas" (RISK §3). `failed` e `expired`
 * contam como falha (as duas são transações que não executaram); `filled` zera o contador.
 */
export function recordTxOutcome(state: RiskState, status: 'filled' | 'failed' | 'expired'): RiskState {
  return { ...state, consecutiveTxFailures: status === 'filled' ? 0 : state.consecutiveTxFailures + 1 };
}

/** Perda realizada do dia em lamports (≥ 0). */
export function dailyRealizedLoss(state: RiskState, nowMs: number): Lamports {
  const rolled = rollDay(state, nowMs);
  return rolled.dailyRealizedPnlLamports < 0n ? -rolled.dailyRealizedPnlLamports : 0n;
}

/**
 * `decisionId` determinístico (sem UUID aleatório — o replay precisa reproduzir os mesmos ids):
 * `<runId>:<mint>:<nowMs>:<seq>`. O `seq` é único no run, então o id é único mesmo com duas
 * decisões no mesmo ms para o mesmo mint. Devolve o estado com o contador avançado.
 */
export function nextDecisionId(state: RiskState, runId: string, mint: string, nowMs: number): { decisionId: string; state: RiskState } {
  const seq = state.decisionSeq + 1;
  return { decisionId: `${runId}:${mint}:${String(nowMs)}:${String(seq)}`, state: { ...state, decisionSeq: seq } };
}
