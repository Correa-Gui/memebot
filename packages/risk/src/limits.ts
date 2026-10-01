import type { Lamports } from '@memebot/core';
import type { StrategyV0Config } from '@memebot/strategy';
import { HARD_LIMITS } from './hard-limits.ts';

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Algum valor configurado passou do hard limit correspondente. Nunca é corrigido em silêncio. */
export class HardLimitExceededError extends Error {
  readonly limitKey: string;
  readonly configured: string;
  readonly hardLimit: string;

  constructor(limitKey: string, configured: bigint | number, hardLimit: bigint | number) {
    super(
      `Config acima do hard limit: ${limitKey} = ${configured.toString()} > ${hardLimit.toString()} ` +
        '(packages/risk/src/hard-limits.ts; a config só pode reduzir).',
    );
    this.name = 'HardLimitExceededError';
    this.limitKey = limitKey;
    this.configured = configured.toString();
    this.hardLimit = hardLimit.toString();
  }
}

export class InvalidRiskConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRiskConfigError';
  }
}

/**
 * Converte SOL (número da config YAML) em lamports. Recusa valores com precisão abaixo de 1 lamport
 * ou não finitos — o valor monetário vira bigint uma única vez, aqui na borda.
 */
export function solToLamports(sol: number, field: string): Lamports {
  if (!Number.isFinite(sol) || sol < 0) throw new InvalidRiskConfigError(`${field}: valor inválido (${String(sol)})`);
  const scaled = sol * LAMPORTS_PER_SOL;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-3) {
    throw new InvalidRiskConfigError(`${field}: precisão abaixo de 1 lamport (${String(sol)} SOL)`);
  }
  return BigInt(rounded);
}

/** Limites efetivos = config, validada contra os hard limits. Tudo que é monetário em bigint. */
export interface EffectiveRiskLimits {
  /** Tamanho fixo por operação (`sizing.sizeSol`): teto do SOL pago à curva, já com as taxas da curva. */
  sizeLamports: Lamports;
  maxPositionLamports: Lamports;
  maxOpenPositions: number;
  maxDailyLossLamports: Lamports;
  maxHotWalletLamports: Lamports;
  maxSlippageBps: number;
  maxPriorityFeeLamports: Lamports;
  maxJitoTipLamports: Lamports;
  /** `sizing.maxOwnPriceImpactPct` (fração, ex.: 0.02 = 2%). */
  maxOwnPriceImpactPct: number;
  /**
   * Se o impacto obrigar a reduzir o tamanho para menos que esta fração de `sizeLamports`, rejeita
   * (`maxOwnPriceImpactPct`) em vez de entrar pequeno. Ver `computeEntrySize` em `sizing.ts`.
   */
  minSizeFraction: number;
}

/**
 * Parâmetros de risco que não estão no YAML da estratégia (vêm do código que monta o app). Só podem
 * reduzir os hard limits; omitidos = o próprio hard limit.
 */
export interface RiskOverrides {
  maxSlippageBps?: number;
  maxPriorityFeeLamports?: Lamports;
  maxJitoTipLamports?: Lamports;
  maxHotWalletLamports?: Lamports;
  minSizeFraction?: number;
}

/** Fração mínima padrão do tamanho depois de reduzir por impacto (ver `EffectiveRiskLimits.minSizeFraction`). */
export const DEFAULT_MIN_SIZE_FRACTION = 0.5;

function checkBigint(key: string, configured: bigint, hard: bigint): bigint {
  if (configured > hard) throw new HardLimitExceededError(key, configured, hard);
  if (configured < 0n) throw new InvalidRiskConfigError(`${key}: não pode ser negativo`);
  return configured;
}

function checkNumber(key: string, configured: number, hard: number): number {
  if (!Number.isFinite(configured) || configured < 0) throw new InvalidRiskConfigError(`${key}: valor inválido`);
  if (configured > hard) throw new HardLimitExceededError(key, configured, hard);
  return configured;
}

/**
 * Monta os limites efetivos a partir de `config/strategy.v0.yaml` (já validado por zod em
 * `loadStrategyConfig`) + overrides. Qualquer valor acima do hard limit é ERRO explícito
 * (`HardLimitExceededError`), nunca clamp silencioso (RISK_AND_SECURITY §2, CLAUDE.md §3).
 */
export function buildEffectiveRiskLimits(config: StrategyV0Config, overrides: RiskOverrides = {}): EffectiveRiskLimits {
  const sizeLamports = checkBigint(
    'sizing.sizeSol',
    solToLamports(config.sizing.sizeSol, 'sizing.sizeSol'),
    HARD_LIMITS.maxPositionLamports,
  );
  if (sizeLamports === 0n) throw new InvalidRiskConfigError('sizing.sizeSol deve ser positivo');

  const maxDailyLossLamports = checkBigint(
    'risk.maxDailyLossSol',
    solToLamports(config.risk.maxDailyLossSol, 'risk.maxDailyLossSol'),
    HARD_LIMITS.maxDailyLossLamports,
  );
  const maxOpenPositions = checkNumber('risk.maxOpenPositions', config.risk.maxOpenPositions, HARD_LIMITS.maxOpenPositions);

  const minSizeFraction = overrides.minSizeFraction ?? DEFAULT_MIN_SIZE_FRACTION;
  if (!(minSizeFraction > 0 && minSizeFraction <= 1)) {
    throw new InvalidRiskConfigError('minSizeFraction deve estar em (0, 1]');
  }

  return {
    sizeLamports,
    maxPositionLamports: sizeLamports,
    maxOpenPositions,
    maxDailyLossLamports,
    maxHotWalletLamports: checkBigint(
      'maxHotWalletLamports',
      overrides.maxHotWalletLamports ?? HARD_LIMITS.maxHotWalletLamports,
      HARD_LIMITS.maxHotWalletLamports,
    ),
    maxSlippageBps: checkNumber('maxSlippageBps', overrides.maxSlippageBps ?? HARD_LIMITS.maxSlippageBps, HARD_LIMITS.maxSlippageBps),
    maxPriorityFeeLamports: checkBigint(
      'maxPriorityFeeLamports',
      overrides.maxPriorityFeeLamports ?? HARD_LIMITS.maxPriorityFeeLamports,
      HARD_LIMITS.maxPriorityFeeLamports,
    ),
    maxJitoTipLamports: checkBigint(
      'maxJitoTipLamports',
      overrides.maxJitoTipLamports ?? HARD_LIMITS.maxJitoTipLamports,
      HARD_LIMITS.maxJitoTipLamports,
    ),
    maxOwnPriceImpactPct: config.sizing.maxOwnPriceImpactPct,
    minSizeFraction,
  };
}

/**
 * Confere de novo um `EffectiveRiskLimits` contra os hard limits (defesa em profundidade: quem
 * recebe limites prontos — ex. o paper executor — não confia que vieram de `buildEffectiveRiskLimits`).
 */
export function assertWithinHardLimits(limits: EffectiveRiskLimits): void {
  checkBigint('sizeLamports', limits.sizeLamports, HARD_LIMITS.maxPositionLamports);
  checkBigint('maxPositionLamports', limits.maxPositionLamports, HARD_LIMITS.maxPositionLamports);
  checkNumber('maxOpenPositions', limits.maxOpenPositions, HARD_LIMITS.maxOpenPositions);
  checkBigint('maxDailyLossLamports', limits.maxDailyLossLamports, HARD_LIMITS.maxDailyLossLamports);
  checkBigint('maxHotWalletLamports', limits.maxHotWalletLamports, HARD_LIMITS.maxHotWalletLamports);
  checkNumber('maxSlippageBps', limits.maxSlippageBps, HARD_LIMITS.maxSlippageBps);
  checkBigint('maxPriorityFeeLamports', limits.maxPriorityFeeLamports, HARD_LIMITS.maxPriorityFeeLamports);
  checkBigint('maxJitoTipLamports', limits.maxJitoTipLamports, HARD_LIMITS.maxJitoTipLamports);
}
