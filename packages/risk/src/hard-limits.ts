/**
 * Limites rígidos (docs/RISK_AND_SECURITY.md §2). Constantes no código: a config só pode REDUZIR
 * estes valores, nunca aumentar (ver `buildEffectiveRiskLimits` em `limits.ts`, que lança erro em
 * vez de limitar em silêncio). Valem também no paper, para o paper medir o que o live faria.
 *
 * CLAUDE.md §3: alterar este arquivo exige pedido explícito do usuário.
 * Criado na Fase 3/parte B (2026-10-01) a pedido explícito do usuário.
 */
export const HARD_LIMITS = {
  maxPositionLamports: 50_000_000n, // 0,05 SOL por operação
  maxOpenPositions: 3,
  maxDailyLossLamports: 200_000_000n, // 0,2 SOL/dia → kill switch
  maxHotWalletLamports: 1_000_000_000n, // 1 SOL
  maxSlippageBps: 1500, // 15%
  maxPriorityFeeLamports: 2_000_000n,
  maxJitoTipLamports: 2_000_000n,
} as const;

export type HardLimits = typeof HARD_LIMITS;
