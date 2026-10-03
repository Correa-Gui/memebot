import { describe, expect, it } from 'vitest';
import { pumpSwapSell } from '@memebot/curve-math';
import type { TokenState } from '@memebot/state';
import { evaluateExits, liquidationValue, netPnlRatio, openPosition } from '../src/index.ts';
import { CTX, T0, buyFill, realConfig, tokenAt } from './helpers.ts';

/**
 * Posição comprada no PumpSwap (universo graduado, 2026-10-03): liquidação pelo swap exato com as reservas
 * e os bps efetivos do estado; não sai por `graduated` (o token já está no venue graduado).
 */
const BPS = { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n, cashbackFeeBps: 0n };
const R = { base: 206_900_000_000_000n, quote: 67_000_000_000n, virtualQuote: 17_584_505_396n };

function graduatedToken(r = R, feeBps: typeof BPS | null = BPS): TokenState {
  return { ...tokenAt(30_000_000_000n), venue: 'pumpswap', curveCompleted: true, graduatedAtMs: T0 - 60_000, pumpSwapReserves: { pool: 'p', ...r, feeBps, baseSupply: 1_000_000_000_000_000n, lastSlot: 1n } };
}

describe('posição no PumpSwap', () => {
  const pos = openPosition(buyFill(), 'pumpswap');

  it('liquidationValue = pumpSwapSell(reservas, quantidade, bps).netQuoteOut − custos de saída + rent', () => {
    const expected = pumpSwapSell(R, pos.tokenAmount, BPS).netQuoteOut - CTX.exitPriorityFeeLamports - CTX.exitJitoTipLamports - CTX.exitBaseFeeLamports + pos.rentPaidLamports;
    expect(liquidationValue(pos, graduatedToken(), CTX)).toBe(expected);
  });

  it('sem bps/offset conhecidos: sem valor (não precifica) e nenhuma saída por preço', () => {
    expect(liquidationValue(pos, graduatedToken(R, null), CTX)).toBeNull();
    expect(netPnlRatio(pos, graduatedToken(R, null), CTX)).toBeNull();
  });

  it('não sai por graduated; time stop continua valendo', () => {
    const config = realConfig().exits;
    const early = evaluateExits(pos, graduatedToken(), T0 + 1_000, config, CTX);
    expect(early.orders.map((o) => o.reason)).not.toContain('graduated');
    const late = evaluateExits(pos, graduatedToken(), pos.openedAtMs + config.timeStopSec * 1000, config, CTX);
    expect(late.orders[0]?.reason).toBeDefined();
    expect(late.orders[0]?.reason).not.toBe('graduated');
  });

  it('posição de CURVA no mesmo token graduado sai por graduated (v0.1 inalterada)', () => {
    const curvePos = openPosition(buyFill());
    expect(curvePos.venue).toBe('curve');
    expect(evaluateExits(curvePos, graduatedToken(), T0 + 1_000, realConfig().exits, CTX).orders[0]?.reason).toBe('graduated');
  });
});
