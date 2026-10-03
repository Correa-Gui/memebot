import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CurveCompletedEvent, PumpEvent, PumpSwapTradeEvent, TokenCreatedEvent } from '@memebot/core';
import { marketCapLamports, parseCurveInitialParams } from '@memebot/curve-math';
import { applyEvent, createEmptyMarketState } from '@memebot/state';
import type { MarketState } from '@memebot/state';
import { StrategyConfigSchema, evaluate, loadStrategyConfig } from '../src/index.ts';

/**
 * Universo graduado (experimento de 2026-10-03): janela desde a graduação (`curve_completed`), market cap
 * em US$ e o mesmo gatilho/filtros da v0.1 sobre os trades do PumpSwap. Configs reais de config/variants/.
 */
const cfg = (name: string) => loadStrategyConfig(fileURLToPath(new URL(`../../../config/variants/${name}.yaml`, import.meta.url)));
const G0 = cfg('g0-grad-1-10m');
const G2 = cfg('g2-grad-mcap-100k-1m');
const CURVE = parseCurveInitialParams({ initial_virtual_token_reserves: '1073000000000000', initial_virtual_sol_reserves: '30000000000', initial_real_token_reserves: '793100000000000' });
const T0 = 1_790_000_000_000;
const MINT = 'gradA';
const SUPPLY = 1_000_000_000_000_000n;
const B0 = 206_900_000_000_000n;
const Q0 = 67_000_000_000n;
const VQ = 17_584_505_396n;
const STEP_T = 1_000_000_000_000n;
const STEP_Q = 300_000_000n;
const clock = (ms: number) => ({ nowMs: () => ms, slot: () => 0n });

let seq = 0;
const base = (ts: number) => ({ slot: BigInt(ts), ts, sig: `s${String(++seq)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: seq, rawB64: '' });

function swapBuy(ts: number, i: number): PumpSwapTradeEvent {
  return {
    kind: 'trade', venue: 'pumpswap', ...base(ts), pool: 'poolA', mint: MINT, quoteMint: 'So11111111111111111111111111111111111111112', poolUnresolved: false,
    trader: `w${String(i)}`, side: 'buy', tokenAmount: STEP_T, quoteAmount: STEP_Q, userQuoteAmount: STEP_Q + 3_600_000n,
    poolBaseReserves: B0 - BigInt(i) * STEP_T, poolQuoteReserves: Q0 + BigInt(i) * STEP_Q, lpFee: 600_000n, protocolFee: 150_000n, creatorFee: 2_850_000n, ixName: 'buy_exact_quote_in',
    swapDetails: { instruction: 'buy_exact_quote_in', virtualQuoteReserves: VQ, lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n, cashbackFeeBps: 0n, cashbackFee: 0n, buybackFeeBps: 0n, buybackFee: 0n, holderRewardsBps: 0n, holderRewards: 0n, baseSupply: SUPPLY },
  };
}

/** Token criado há 1 h (fora de qualquer janela da curva), gradua em T0 e recebe 80 compras de carteiras distintas, 1/s. */
function market(opts: { seeGraduation?: boolean } = {}): MarketState {
  const created: TokenCreatedEvent = { kind: 'token_created', ...base(T0 - 3_600_000), mint: MINT, creator: 'dev', name: 'G', symbol: 'G', uri: 'u', bondingCurve: 'bc', quoteMint: '11111111111111111111111111111111', tokenTotalSupply: SUPPLY };
  const done: CurveCompletedEvent = { kind: 'curve_completed', ...base(T0), mint: MINT, bondingCurve: 'bc' };
  const events: PumpEvent[] = [created, ...(opts.seeGraduation === false ? [] : [done])];
  for (let i = 0; i < 80; i++) events.push(swapBuy(T0 + 1_000 + i * 1_000, i));
  return events.reduce(applyEvent, createEmptyMarketState());
}

describe('evaluate — universo graduado', () => {
  it('config: pumpswap em allowedVenues exige o bloco graduated', () => {
    expect(StrategyConfigSchema.safeParse({ ...G0, graduated: undefined }).success).toBe(false);
    expect(StrategyConfigSchema.safeParse(G0).success).toBe(true);
  });

  it('dentro da janela desde a graduação (1–10 min) e com o gatilho da v0.1: enter, com snapshot da graduação', () => {
    const m = market();
    const now = T0 + 81_000;
    const d = evaluate(m, MINT, clock(now), G0, CURVE)[0];
    expect(d).toMatchObject({ outcome: 'enter', reason: 'momentum_trigger' });
    if (d?.outcome !== 'enter') throw new Error('esperava enter');
    expect(d.features['sinceGraduationSec']).toBe(81);
    const r = m.tokens.get(MINT)?.pumpSwapReserves;
    if (!r || r.virtualQuote === null) throw new Error('sem reservas');
    expect(d.features['marketCapSol']).toBeCloseTo(Number(marketCapLamports({ base: r.base, quote: r.quote, virtualQuote: r.virtualQuote }, SUPPLY)) / 1e9, 9);
    // idade desde a CRIAÇÃO (1 h) não barra o graduado
    expect(d.features['ageSec']).toBeGreaterThan(3_600);
  });

  it('antes de 60 s / depois de 600 s da graduação: minSinceGraduationSec / maxSinceGraduationSec', () => {
    const m = market();
    expect(evaluate(m, MINT, clock(T0 + 30_000), G0, CURVE)[0]).toMatchObject({ outcome: 'reject', reason: 'minSinceGraduationSec' });
    expect(evaluate(m, MINT, clock(T0 + 601_000), G0, CURVE)[0]).toMatchObject({ outcome: 'reject', reason: 'maxSinceGraduationSec' });
  });

  it('graduação não vista no run: graduation_not_seen', () => {
    expect(evaluate(market({ seeGraduation: false }), MINT, clock(T0 + 81_000), G0, CURVE)[0]).toMatchObject({ outcome: 'reject', reason: 'graduation_not_seen' });
  });

  it('market cap em US$: sem preço → sol_usd_unavailable; abaixo/acima da faixa → rejeita; dentro → enter', () => {
    const m = market();
    const now = T0 + 81_000;
    const r = m.tokens.get(MINT)?.pumpSwapReserves;
    if (!r || r.virtualQuote === null) throw new Error('sem reservas');
    const mcapSol = Number(marketCapLamports({ base: r.base, quote: r.quote, virtualQuote: r.virtualQuote }, SUPPLY)) / 1e9;
    expect(evaluate(m, MINT, clock(now), G2, CURVE)[0]).toMatchObject({ reason: 'sol_usd_unavailable' });
    expect(evaluate(m, MINT, clock(now), G2, CURVE, { solUsd: 99_000 / mcapSol })[0]).toMatchObject({ reason: 'minMarketCapUsd' });
    expect(evaluate(m, MINT, clock(now), G2, CURVE, { solUsd: 1_001_000 / mcapSol })[0]).toMatchObject({ reason: 'maxMarketCapUsd' });
    const ok = evaluate(m, MINT, clock(now), G2, CURVE, { solUsd: 500_000 / mcapSol })[0];
    expect(ok).toMatchObject({ outcome: 'enter' });
    if (ok?.outcome === 'enter') expect(ok.features['marketCapUsd']).toBeCloseTo(500_000, 3);
  });

  it('a v0.1 (só curva) rejeita o graduado por venue', () => {
    const v01 = loadStrategyConfig(fileURLToPath(new URL('../../../config/strategy.v0.yaml', import.meta.url)));
    expect(evaluate(market(), MINT, clock(T0 + 81_000), v01, CURVE)[0]).toMatchObject({ outcome: 'reject', reason: 'venue_not_allowed' });
  });
});
