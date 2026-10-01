import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bondingCurveBuy, bondingCurveSell, deriveRealReserves } from '../src/bonding-curve.ts';
import type { CurveInitialParams } from '../src/bonding-curve.ts';

interface CurveFixture {
  description: string;
  before: { virtualQuote: string; virtualToken: string };
  trade: { side: 'buy' | 'sell'; quoteAmount: string; tokenAmount: string; ixName: string };
  after: { virtualQuote: string; virtualToken: string; realQuote: string; realToken: string };
  fees: { protocolFee: string; creatorFee: string };
}

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golden', 'curve.json');
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as CurveFixture[];

// Lidos de protocol_config (Pump.fun FeeConfig, conta 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt,
// snapshot de 2026-09-29): único tier (threshold 0), flat 95 bps protocolo / 30 bps criador.
const CURVE_FEES = { protocolFeeBps: 95n, creatorFeeBps: 30n };

// Pump.fun Global (protocol_config, mesma data): usados para reconstruir reservas reais.
const INITIAL_PARAMS: CurveInitialParams = {
  initialVirtualQuote: 30_000_000_000n,
  initialVirtualToken: 1_073_000_000_000_000n,
  initialRealToken: 793_100_000_000_000n,
};

describe('bondingCurveBuy / bondingCurveSell — fixtures golden (trades reais)', () => {
  it('carregou pelo menos 50 fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(50);
  });

  it.each(fixtures)('$description', (fx) => {
    const before = { virtualQuote: BigInt(fx.before.virtualQuote), virtualToken: BigInt(fx.before.virtualToken) };

    if (fx.trade.side === 'buy') {
      const result = bondingCurveBuy(before, BigInt(fx.trade.quoteAmount), CURVE_FEES);
      expect(result.tokenOut).toBe(BigInt(fx.trade.tokenAmount));
      expect(result.protocolFee).toBe(BigInt(fx.fees.protocolFee));
      expect(result.creatorFee).toBe(BigInt(fx.fees.creatorFee));
      expect(result.reservesAfter.virtualQuote).toBe(BigInt(fx.after.virtualQuote));
      expect(result.reservesAfter.virtualToken).toBe(BigInt(fx.after.virtualToken));

      const real = deriveRealReserves(result.reservesAfter, INITIAL_PARAMS);
      expect(real.realQuote).toBe(BigInt(fx.after.realQuote));
      expect(real.realToken).toBe(BigInt(fx.after.realToken));
    } else {
      const result = bondingCurveSell(before, BigInt(fx.trade.tokenAmount), CURVE_FEES);
      expect(result.quoteOutGross).toBe(BigInt(fx.trade.quoteAmount));
      expect(result.protocolFee).toBe(BigInt(fx.fees.protocolFee));
      expect(result.creatorFee).toBe(BigInt(fx.fees.creatorFee));
      expect(result.reservesAfter.virtualQuote).toBe(BigInt(fx.after.virtualQuote));
      expect(result.reservesAfter.virtualToken).toBe(BigInt(fx.after.virtualToken));

      const real = deriveRealReserves(result.reservesAfter, INITIAL_PARAMS);
      expect(real.realQuote).toBe(BigInt(fx.after.realQuote));
      expect(real.realToken).toBe(BigInt(fx.after.realToken));
    }
  });
});
