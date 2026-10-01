import { describe, expect, it } from 'vitest';
import { feeFromBps, lookupFeeTier, resolveFees } from '../src/fees.ts';
import type { FeeTier } from '../src/fees.ts';

describe('feeFromBps', () => {
  it('arredonda para cima (ceiling), nunca para baixo', () => {
    // 987 * 95 / 10000 = 9.3765 -> ceil = 10 (confirmado contra trade real, ver fixtures golden)
    expect(feeFromBps(987n, 95n)).toBe(10n);
  });

  it('retorna 0 para bps 0', () => {
    expect(feeFromBps(1_000_000n, 0n)).toBe(0n);
  });

  it('é exata quando a divisão é exata', () => {
    expect(feeFromBps(10_000n, 95n)).toBe(95n);
  });

  it('rejeita amount negativo', () => {
    expect(() => feeFromBps(-1n, 10n)).toThrow();
  });
});

describe('lookupFeeTier', () => {
  // Tiers reais do PumpSwap (protocol_config, FeeConfig 5PHirr8...), subconjunto.
  const tiers: FeeTier[] = [
    { marketCapLamportsThreshold: 0n, fees: { lpFeeBps: 2n, protocolFeeBps: 93n, creatorFeeBps: 30n } },
    { marketCapLamportsThreshold: 420_000_000_000n, fees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n } },
    { marketCapLamportsThreshold: 1_470_000_000_000n, fees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 90n } },
    { marketCapLamportsThreshold: 2_460_000_000_000n, fees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 85n } },
  ];

  it('escolhe o tier 0 para market cap abaixo do primeiro threshold', () => {
    expect(lookupFeeTier(tiers, 100n).creatorFeeBps).toBe(30n);
  });

  it('escolhe o tier exato no threshold', () => {
    expect(lookupFeeTier(tiers, 420_000_000_000n).creatorFeeBps).toBe(95n);
  });

  it('escolhe o maior tier <= market cap (caso real confirmado: 1790,3 SOL -> tier 1470 SOL, creator 90bps)', () => {
    expect(lookupFeeTier(tiers, 1_790_300_000_000n).creatorFeeBps).toBe(90n);
  });

  it('escolhe o último tier para market cap muito alto', () => {
    expect(lookupFeeTier(tiers, 999_999_999_999_999n).creatorFeeBps).toBe(85n);
  });

  it('rejeita lista vazia', () => {
    expect(() => lookupFeeTier([], 1n)).toThrow();
  });
});

describe('resolveFees', () => {
  const flatFees = { lpFeeBps: 0n, protocolFeeBps: 95n, creatorFeeBps: 30n };
  const feeTiers: FeeTier[] = [{ marketCapLamportsThreshold: 0n, fees: flatFees }];

  it('usa feeTiers quando a quote não é estável', () => {
    const fees = resolveFees({ flatFees, feeTiers, stableFeeTiers: [], exoticFlatFees: flatFees }, 100n, false);
    expect(fees).toEqual(flatFees);
  });

  it('cai para flatFees quando a lista de tiers relevante está vazia', () => {
    const fees = resolveFees({ flatFees, feeTiers: [], stableFeeTiers: [], exoticFlatFees: flatFees }, 100n, false);
    expect(fees).toEqual(flatFees);
  });
});
