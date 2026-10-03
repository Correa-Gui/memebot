export { HARD_LIMITS } from './hard-limits.ts';
export type { HardLimits } from './hard-limits.ts';

export type { EffectiveRiskLimits, RiskOverrides } from './limits.ts';
export {
  DEFAULT_MIN_SIZE_FRACTION,
  HardLimitExceededError,
  InvalidRiskConfigError,
  assertWithinHardLimits,
  buildEffectiveRiskLimits,
  solToLamports,
} from './limits.ts';

export type { EntrySizeResult } from './sizing.ts';
export { computeEntrySize, computePumpSwapEntrySize, ownPriceImpactPct, pumpSwapImpactPct, quoteInForBudget } from './sizing.ts';

export type { RiskState } from './risk-state.ts';
export {
  createRiskState,
  dailyRealizedLoss,
  nextDecisionId,
  recordRealizedPnl,
  recordTxOutcome,
  rollDay,
  utcDayIndex,
} from './risk-state.ts';

export type { KillSwitchInputs, KillSwitchParams, KillSwitchReason, KillSwitchStatus } from './kill-switch.ts';
export { KILL_SWITCH_DEFAULTS, evaluateKillSwitch } from './kill-switch.ts';

export { DEFAULT_STOP_FILE_PATH, isStopFilePresent } from './stop-file.ts';

export type { ApprovalResult, ApproveEntryInput, ApprovedEntry, PortfolioSnapshot, RejectedEntry } from './approve.ts';
export { approveEntry } from './approve.ts';
