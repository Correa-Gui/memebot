/**
 * Qualquer pedido de simulação de swap no PumpSwap. O valor do swap do PumpSwap (`baseOut` /
 * `quoteOutGross`) ainda não bate com os dados reais (docs/ROADMAP.md Fase 2, "Resolver swap exato
 * do PumpSwap"): o paper executor NUNCA aproxima — lança este erro.
 */
export class PumpSwapSimulationNotValidatedError extends Error {
  readonly mint: string;

  constructor(mint: string) {
    super(
      `Simulação de swap no PumpSwap não validada (mint ${mint}): a matemática do swap do PumpSwap ainda ` +
        'não bate com dados reais (docs/ROADMAP.md Fase 2). Recusado em vez de aproximar.',
    );
    this.name = 'PumpSwapSimulationNotValidatedError';
    this.mint = mint;
  }
}

/** Uma ordem chegou ao executor acima de um hard limit (defesa em profundidade além de `packages/risk`). */
export class HardLimitViolationError extends Error {
  readonly limitKey: string;

  constructor(limitKey: string, detail: string) {
    super(`Ordem acima do hard limit ${limitKey}: ${detail}`);
    this.name = 'HardLimitViolationError';
    this.limitKey = limitKey;
  }
}

/** Ordem estruturalmente inválida (sem posição para vender, fração fora de (0, 1], mint sem curva...). */
export class InvalidOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrderError';
  }
}

/** Sempre lança: ponto único para "simular swap no PumpSwap" enquanto a limitação existir. */
export function simulatePumpSwapSwap(mint: string): never {
  throw new PumpSwapSimulationNotValidatedError(mint);
}
