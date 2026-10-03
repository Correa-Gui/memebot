import { describe, expect, it } from 'vitest';
import type { CurveTradeEvent, PumpEvent, TokenCreatedEvent } from '@memebot/core';
import { bondingCurveBuy, bondingCurveSell, parseCurveInitialParams } from '@memebot/curve-math';
import { creatorTokensCreated24h } from '@memebot/features';
import { quoteInForBudget } from '@memebot/risk';
import { applyEvent, createEmptyMarketState } from '@memebot/state';
import { DatasetBuilder, type DatasetOptions, type DatasetRow } from './dataset.ts';

const CURVE = parseCurveInitialParams({ initial_virtual_token_reserves: '1073000000000000', initial_virtual_sol_reserves: '30000000000', initial_real_token_reserves: '793100000000000' });
const FEES = { protocolFeeBps: 95n, creatorFeeBps: 30n };
const K = 30_000_000_000n * 1_073_000_000_000_000n;
const T0 = 1_790_000_000_000;
let seq = 0;
const base = (ts: number) => ({ slot: BigInt(ts), ts, sig: `s${String(++seq)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: seq, rawB64: '' });
const created = (mint: string, ts: number, creator = 'dev'): TokenCreatedEvent => ({ kind: 'token_created', ...base(ts), mint, creator, name: 'n', symbol: 's', uri: 'u', bondingCurve: 'bc', quoteMint: '11111111111111111111111111111111', tokenTotalSupply: 1_000_000_000_000_000n });
const trade = (mint: string, ts: number, vq: bigint, trader = 'w'): CurveTradeEvent => ({
  kind: 'trade', venue: 'curve', ...base(ts), mint, trader, side: 'buy', quoteMint: '11111111111111111111111111111111', quoteAmount: 100_000_000n, tokenAmount: 1_000_000_000n,
  virtualQuoteReserves: vq, virtualTokenReserves: K / vq, realQuoteReserves: 0n, realTokenReserves: 0n, protocolFee: 0n, creatorFee: 0n, ixName: 'buy',
});

function build(events: readonly PumpEvent[], over: Partial<DatasetOptions> = {}): { rows: DatasetRow[]; b: DatasetBuilder } {
  const rows: DatasetRow[] = [];
  const b = new DatasetBuilder({
    curveParams: CURVE, fees: FEES, costsAt: () => ({ priority: 100_000n, tip: 0n }), rentLamports: 1_513_840n, baseFeeLamports: 5_000n, sizeLamports: 50_000_000n,
    latencyMs: 800, tpPct: 0.4, slPct: 0.2, horizonMs: 600_000, sampleEveryMs: 15_000, minAgeMs: 30_000, maxAgeMs: 60_000, eligible: () => true,
    onRow: (r) => rows.push(r), ...over,
  });
  for (const e of events) b.onEvent(e);
  b.finish(Number.MAX_SAFE_INTEGER);
  return { rows, b };
}

describe('DatasetBuilder', () => {
  it('amostra a cada 15 s (30–60 s) só com trade no intervalo; rótulo +40% com a matemática e os custos do executor', () => {
    // 1 trade/s a vq = 30 SOL até 70 s; depois sobe forte para 60 SOL (preço ×4) aos 100 s
    const ev: PumpEvent[] = [created('A', T0)];
    for (let s = 1; s <= 70; s++) ev.push(trade('A', T0 + s * 1000, 30_000_000_000n, `w${String(s)}`));
    ev.push(trade('A', T0 + 100_000, 60_000_000_000n, 'whale'));
    ev.push(trade('A', T0 + 101_000, 60_000_000_000n, 'x'));
    const { rows } = build(ev);
    expect(rows.map((r) => (r.t - T0) / 1000)).toEqual([30, 45, 60]);
    const r = rows[0];
    if (!r) throw new Error('sem linha');
    expect(r).toMatchObject({ hitTp: 1, exitReason: 'take_profit' });
    // reproduz o retorno: compra a vq 30 SOL em t+0,8 s, venda no estado de 100,8 s (vq 60 SOL)
    const quoteIn = quoteInForBudget(50_000_000n, FEES);
    const buy = bondingCurveBuy({ virtualQuote: 30_000_000_000n, virtualToken: K / 30_000_000_000n }, quoteIn, FEES);
    const entry = buy.totalQuoteCost + 100_000n + 5_000n + 1_513_840n;
    const out = bondingCurveSell({ virtualQuote: 60_000_000_000n, virtualToken: K / 60_000_000_000n }, buy.tokenOut, FEES).netQuoteOut - 100_000n - 5_000n + 1_513_840n;
    expect(r.netReturn).toBeCloseTo(Number(out - entry) / Number(entry), 12);
    // features só com eventos ≤ t: aos 30 s há 30 compradores na janela de 60 s e o trade da baleia não aparece
    expect(r.features['uniqueBuyers60s']).toBe(30);
    expect(r.features['vol300s']).toBeCloseTo(3, 9);
  });

  it('sem trade no intervalo não amostra; queda leva a stop_loss; token inelegível é ignorado', () => {
    const ev: PumpEvent[] = [created('B', T0), trade('B', T0 + 29_000, 30_000_000_000n), trade('B', T0 + 50_000, 15_000_000_000n)];
    const { rows, b } = build(ev);
    // 30 s: compra a 30 SOL, o trade de 50 s derruba o preço → stop; 60 s: compra já no preço baixo, sem mais
    // trades → venda no fim do horizonte (time_stop)
    expect(rows.map((r) => [(r.t - T0) / 1000, r.exitReason])).toEqual([[30, 'stop_loss'], [60, 'time_stop']]);
    expect(b.stats.samplesNoTrade).toBe(1); // 45 s: nenhum trade em (30 s, 45 s]
    expect(build(ev, { eligible: () => false }).rows).toHaveLength(0);
  });

  it('tokens do criador em 24 h: mesmo valor da feature do bot', () => {
    const ev: PumpEvent[] = [created('C1', T0 - 3_600_000, 'dev'), created('C2', T0 - 60_000, 'dev'), created('C3', T0, 'dev')];
    for (let s = 1; s <= 31; s++) ev.push(trade('C3', T0 + s * 1000, 30_000_000_000n));
    const { rows } = build(ev, { maxAgeMs: 30_000 });
    const market = ev.reduce(applyEvent, createEmptyMarketState());
    const token = market.tokens.get('C3');
    if (!token) throw new Error('sem token');
    expect(rows[0]?.features['creatorTokensCreated24h']).toBe(creatorTokensCreated24h(market, token, T0 + 30_000));
    expect(rows[0]?.features['creatorTokensCreated24h']).toBe(2);
  });
});
