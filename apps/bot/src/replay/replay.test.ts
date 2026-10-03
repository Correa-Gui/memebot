import { fileURLToPath } from 'node:url';
import type { CurveTradeEvent, TokenCreatedEvent } from '@memebot/core';
import { loadStrategyConfig } from '@memebot/strategy';
import type { StrategyV0Config } from '@memebot/strategy';
import { describe, expect, it } from 'vitest';
import { ClickHouseReplaySource, type QueryFn } from './clickhouse.ts';
import { compareEntries } from './compare.ts';
import { mergeIntervals, overlapsAny, silenceGaps, tokenAffectedByGap } from './gaps.ts';
import { compareReplayEvents, sortAndDedupe, type ReplayEvent } from './order.ts';
import { ArrayEventSource, executeReplay, replayRunId, type ReplayParams, type ReplayVariant } from './run.ts';
import { CostSchedule, ProtocolSchedule, type ProtocolRow } from './schedules.ts';
import { summarizeVariant, toReportDecision, toReportFill } from './summary.ts';

const CONFIG_PATH = fileURLToPath(new URL('../../../../config/strategy.v0.yaml', import.meta.url));
const CONFIG = loadStrategyConfig(CONFIG_PATH);
const T0 = 1_790_000_000_000;
const K = 30_000_000_000n * 1_073_000_000_000_000n;
const SOL_QUOTE = '11111111111111111111111111111111';

const GLOBAL_JSON = JSON.stringify({ initial_virtual_token_reserves: '1073000000000000', initial_virtual_sol_reserves: '30000000000', initial_real_token_reserves: '793100000000000' });
const FEES = { lp_fee_bps: '0', protocol_fee_bps: '95', creator_fee_bps: '30' };
const FEE_JSON = JSON.stringify({ flat_fees: FEES, fee_tiers: [{ market_cap_lamports_threshold: '0', fees: FEES }], stable_fee_tiers: [], exotic_flat_fees: FEES });
const PROTOCOL: ProtocolRow[] = [
  { tsMs: T0 - 60_000, accountType: 'Global', configJson: GLOBAL_JSON },
  { tsMs: T0 - 60_000, accountType: 'FeeConfig', configJson: FEE_JSON },
];

let seq = 0;
function base(ts: number, slot?: bigint) {
  seq++;
  return { slot: slot ?? BigInt(Math.floor(ts / 400)), ts, sig: `s${String(seq)}`, eventIndex: 0, receivedAtMs: ts + 300, recvSeq: seq, rawB64: '' };
}
function created(mint: string, ts: number, creator = 'creator'): TokenCreatedEvent {
  return { kind: 'token_created', ...base(ts), mint, creator, name: 'N', symbol: `S${mint}`, uri: '', bondingCurve: 'bc', quoteMint: SOL_QUOTE, tokenTotalSupply: 1_000_000_000_000_000n };
}
function trade(mint: string, ts: number, vq: bigint, trader: string, side: 'buy' | 'sell' = 'buy'): CurveTradeEvent {
  return {
    kind: 'trade', venue: 'curve', ...base(ts), mint, trader, side, quoteMint: SOL_QUOTE, quoteAmount: 300_000_000n, tokenAmount: 1_000_000_000_000n,
    virtualQuoteReserves: vq, virtualTokenReserves: K / vq, realQuoteReserves: 0n, realTokenReserves: 0n, protocolFee: 0n, creatorFee: 0n, ixName: side,
  };
}
/** Token que passa em todos os filtros (70 compradores, preço subindo) e depois cai (stop). */
function pumpAndDump(mint: string, t0: number): ReplayEvent[] {
  const ev: ReplayEvent[] = [created(mint, t0)];
  for (let i = 1; i <= 70; i++) ev.push(trade(mint, t0 + i * 1_000, 30_000_000_000n + BigInt(i) * 200_000_000n, `${mint}-w${String(i)}`));
  for (let i = 1; i <= 20; i++) ev.push(trade(mint, t0 + 70_000 + i * 2_000, 44_000_000_000n - BigInt(i) * 600_000_000n, `${mint}-s${String(i)}`, 'sell'));
  return ev;
}

const PARAMS: ReplayParams = {
  fromMs: T0, entriesUntilMs: T0 + 30 * 60_000, drainMs: 30 * 60_000, seed: 7, latencyMs: 800, failRate: 0.2, killSwitchEnabled: true, excludeGapTokens: false,
  rentLamports: 1_513_840n, costParams: { minSamples: 30, fallbackPriorityFeeLamports: 500_000n, fallbackJitoTipLamports: 500_000n },
  costLookbackMs: 24 * 3_600_000, costReloadMs: 600_000,
};
const variant = (config: StrategyV0Config = CONFIG, label = 'v0.1'): ReplayVariant => ({ label, config, configText: JSON.stringify(config) });

function scenario(): ReplayEvent[] {
  return sortAndDedupe([...pumpAndDump('A', T0 + 1_000), ...pumpAndDump('B', T0 + 5_000), ...pumpAndDump('C', T0 + 200_000)]).events;
}
const inputs = (events: readonly ReplayEvent[]) => ({ source: new ArrayEventSource(events), skeletons: [], costSamples: [], protocolRows: PROTOCOL, gaps: [] });

describe('ordem do replay', () => {
  it('slot → chegada → recv_seq → event_index; remove duplicata exata', () => {
    const a = { ...trade('X', 1_000, 30_000_000_000n, 'w'), slot: 10n, receivedAtMs: 5, recvSeq: 2, sig: 'b' };
    const b = { ...a, slot: 9n, receivedAtMs: 99, sig: 'a' };
    const c = { ...a, receivedAtMs: 5, recvSeq: 1, sig: 'c' };
    const d = { ...a, eventIndex: 1, sig: 'b' };
    const { events, duplicates } = sortAndDedupe([a, b, c, d, { ...a }]);
    expect(events.map((e) => [e.slot, e.sig, e.eventIndex])).toEqual([[9n, 'a', 0], [10n, 'c', 0], [10n, 'b', 0], [10n, 'b', 1]]);
    expect(duplicates).toBe(1);
    expect(compareReplayEvents(a, a)).toBe(0);
  });
});

describe('lacunas', () => {
  it('segundos vazios seguidos ≥ limiar viram lacuna; token afetado se a lacuna cai na janela de avaliação', () => {
    const secs = [100, 101, 102, 110, 111, 112, 113];
    const gaps = mergeIntervals(silenceGaps(secs, 100_000, 114_000, 4));
    expect(gaps).toEqual([{ fromMs: 103_000, toMs: 110_000 }]);
    expect(overlapsAny(gaps, 0, 102_000)).toBe(false);
    expect(tokenAffectedByGap(gaps, 50_000, 60)).toBe(true);
    expect(tokenAffectedByGap(gaps, 110_001, 600)).toBe(false);
    expect(mergeIntervals([{ fromMs: 5, toMs: 9 }, { fromMs: 1, toMs: 5 }])).toEqual([{ fromMs: 1, toMs: 9 }]);
  });
});

describe('agendas de parâmetros externos', () => {
  it('custos: só amostras com sampled_at ≤ t e dentro da janela; recarga a cada intervalo', () => {
    const params = { minSamples: 2, fallbackPriorityFeeLamports: 999n, fallbackJitoTipLamports: 888n };
    const s = new CostSchedule([
      { sampledAtMs: 1_000, priorityFee: 100n, jitoTip: 10n },
      { sampledAtMs: 2_000, priorityFee: 300n, jitoTip: 30n },
      { sampledAtMs: 50_000, priorityFee: 10_000n, jitoTip: 1_000n },
    ], params, 10_000, 5_000, 0);
    expect(s.estimateAt(500).priorityFeeSource).toBe('fallback');
    expect(s.estimateAt(2_000)).toMatchObject({ priorityFeeLamports: 300n, priorityFeeSource: 'tx_costs_median' }); // mediana 200 × 1,5
    expect(s.estimateAt(55_000)).toMatchObject({ priorityFeeSource: 'tx_costs_p75', prioritySampleCount: 1 });
    expect(s.due(0)).not.toBeNull();
    expect(s.due(4_999)).toBeNull();
    expect(s.due(10_000)?.prioritySampleCount).toBe(2);
  });

  it('protocol_config: vigente no início; linhas novas aplicadas quando o relógio passa; erro sem Global', () => {
    const p = new ProtocolSchedule([...PROTOCOL, { tsMs: T0 + 10_000, accountType: 'FeeConfig', configJson: FEE_JSON.replaceAll('"95"', '"100"') }]);
    expect(p.initial(T0).fees).toEqual({ protocolFeeBps: 95n, creatorFeeBps: 30n });
    expect(p.due(T0 + 9_999)).toBeNull();
    expect(p.due(T0 + 10_000)?.fees).toEqual({ protocolFeeBps: 100n, creatorFeeBps: 30n });
    expect(() => new ProtocolSchedule([]).initial(T0)).toThrow(/Global/);
  });
});

describe('executeReplay — mesmo PaperEngine, relógio simulado', () => {
  it('determinismo: mesmo intervalo rodado 2× → decisões e fills idênticos (deep equal)', async () => {
    const a = await executeReplay(inputs(scenario()), [variant()], PARAMS);
    const b = await executeReplay(inputs(scenario()), [variant()], PARAMS);
    expect(a.variants[0]?.fills.length).toBeGreaterThan(0);
    expect(b.variants[0]?.decisions).toEqual(a.variants[0]?.decisions);
    expect(b.variants[0]?.fills).toEqual(a.variants[0]?.fills);
    expect(a.variants[0]?.runId).toBe(replayRunId(variant(), PARAMS));
  });

  it('várias variantes na mesma passada = cada uma rodada sozinha', async () => {
    const strict = { ...CONFIG, entry: { ...CONFIG.entry, confirmation: { windowSec: 10, maxDipPct: 0.1 } } };
    const together = await executeReplay(inputs(scenario()), [variant(), variant(strict, 'a10')], PARAMS);
    const alone = await executeReplay(inputs(scenario()), [variant(strict, 'a10')], PARAMS);
    expect(together.variants[1]?.decisions).toEqual(alone.variants[0]?.decisions);
    expect(together.variants[1]?.fills).toEqual(alone.variants[0]?.fills);
  });

  it('decisões em segundos cheios do ts; saídas por tick (sem evento) e fim das entradas respeitado', async () => {
    const r = await executeReplay(inputs(scenario()), [variant()], { ...PARAMS, entriesUntilMs: T0 + 100_000 });
    const v = r.variants[0];
    if (!v) throw new Error('variant');
    const enters = v.decisions.filter((d) => d.type === 'enter');
    expect([...new Set(enters.map((d) => d.mint))].sort()).toEqual(['A', 'B']); // C nasce depois do fim das entradas
    expect(v.decisions.every((d) => d.ts % 1000 === 0)).toBe(true);
    expect(v.fills.filter((f) => f.side === 'buy').every((f) => f.ts % 1000 === 800)).toBe(true);
    expect(v.openPositionsAtEnd).toBe(0);
    const s = summarizeVariant(v, []);
    expect(s.closed).toBe(v.fills.filter((f) => f.side === 'buy' && f.status === 'filled').length);
  });

  it('token afetado por lacuna vira só esqueleto (nunca avaliado), com o filtro ligado', async () => {
    const r = await executeReplay({ ...inputs(scenario()), gaps: [{ fromMs: T0 + 30_000, toMs: T0 + 31_000 }] }, [variant()], { ...PARAMS, excludeGapTokens: true });
    expect(r.driver.excludedTokens).toBe(2);
    expect(r.variants[0]?.decisions.some((d) => d.mint === 'A' || d.mint === 'B')).toBe(false);
    expect(r.variants[0]?.decisions.some((d) => d.mint === 'C' && d.type === 'enter')).toBe(true);
  });

  it('aquecimento só de estado: tokens criados antes de eligibleFromMs nunca são avaliados', async () => {
    const r = await executeReplay(inputs(scenario()), [variant()], { ...PARAMS, eligibleFromMs: T0 + 100_000 });
    expect(r.warmupTokens).toBe(2);
    expect(r.variants[0]?.decisions.some((d) => d.mint === 'A' || d.mint === 'B')).toBe(false);
    expect(r.variants[0]?.decisions.some((d) => d.mint === 'C' && d.type === 'enter')).toBe(true);
  });

  it('relógio paper_wall: agora = max(ts, received_at − 2 s) — janelas truncadas pelo atraso de chegada', async () => {
    const late = scenario().map((e) => ({ ...e, receivedAtMs: e.ts + 20_000 }));
    const r = await executeReplay(inputs(late), [variant()], { ...PARAMS, clockMode: 'paper_wall' });
    const firstEnter = r.variants[0]?.decisions.find((d) => d.type === 'enter');
    const ev = await executeReplay(inputs(scenario()), [variant()], PARAMS);
    const evEnter = ev.variants[0]?.decisions.find((d) => d.type === 'enter');
    // mesmo "agora" (idade 60 s no relógio), mas com 18 s de trades ainda não chegados: janela de 60 s efetiva de ~42 s
    expect(firstEnter?.ts).toBe(evEnter?.ts);
    expect(Number(firstEnter?.features['uniqueBuyers60s'])).toBeLessThan(Number(evEnter?.features['uniqueBuyers60s']));
  });

  it('kill switch: ligado por padrão (perda diária bloqueia); desligado só quando pedido', async () => {
    const lossy = { ...CONFIG, risk: { ...CONFIG.risk, maxDailyLossSol: 0.001 } };
    const on = await executeReplay(inputs(scenario()), [variant(lossy)], { ...PARAMS, failRate: 0 });
    const off = await executeReplay(inputs(scenario()), [variant(lossy)], { ...PARAMS, failRate: 0, killSwitchEnabled: false });
    expect(on.variants[0]?.decisions.some((d) => d.reason === 'kill_switch:daily_loss')).toBe(true);
    expect(off.variants[0]?.decisions.some((d) => d.reason.startsWith('kill_switch'))).toBe(false);
    expect(off.variants[0]?.decisions.filter((d) => d.type === 'enter').length).toBeGreaterThan(on.variants[0]?.decisions.filter((d) => d.type === 'enter').length ?? 0);
  });
});

describe('ClickHouseReplaySource (QueryFn falso, sem banco)', () => {
  it('lê em blocos de slots, converte as linhas, ordena e remove duplicatas; respeita stop()', async () => {
    const row = (slot: number, recv: number, sig: string, extra: Record<string, unknown>) => ({ slot: String(slot), ts_ms: 1000 * slot, recv_ms: recv, recv_seq: recv, sig, event_index: 0, ...extra });
    const curve = (slot: number, recv: number, sig: string) => row(slot, recv, sig, {
      mint: 'M', trader: 't', side: 'buy', quote_mint: SOL_QUOTE, quote_amount: '1', token_amount: '2', vq: '30000000000', vt: '1073000000000000', rq: '0', rt: '0', protocol_fee: '0', creator_fee: '0', ix_name: null,
    });
    const queries: string[] = [];
    const query: QueryFn = (q, p) => {
      queries.push(q);
      if (q.startsWith('SELECT min(slot)')) return Promise.resolve([{ lo: '10', hi: '25' }]);
      const a = Number(p['a']);
      const inChunk = (s: number) => s >= a && s < Number(p['b']);
      if (q.includes("venue = 'curve'")) return Promise.resolve([curve(21, 5, 'z'), curve(12, 9, 'y'), curve(12, 3, 'x'), curve(12, 3, 'x')].filter((r) => inChunk(Number(r.slot))));
      if (q.includes("venue = 'pumpswap'")) return Promise.resolve(inChunk(24) ? [row(24, 1, 'p', { pool: 'P', mint: '', trader: 't', side: 'sell', quote_mint: '', quote_amount: '5', token_amount: '6', user_quote_amount: null, pool_base_reserves: '7', pool_quote_reserves: '8', lp_fee: null, protocol_fee: '0', creator_fee: '0', ix_name: null })] : []);
      if (q.includes('FROM events_token')) return Promise.resolve(inChunk(12) ? [row(12, 3, 'x', { mint: 'M', creator: 'c', name: 'n', symbol: 's', uri: 'u', bonding_curve: 'b', quote_mint: SOL_QUOTE, token_total_supply: '1000' })] : []);
      if (q.includes('FROM events_lifecycle')) return Promise.resolve(inChunk(22) ? [row(22, 1, 'l', { kind: 'curve_completed', mint: 'M', bonding_curve: 'b', pool: null, quote_mint: null, creator: null })] : []);
      return Promise.resolve([]);
    };
    const src = new ClickHouseReplaySource(query, { fromMs: 0, toMs: 99_000, liveCreatedFromMs: 0, liveCreatedToMs: 99_000, chunkSlots: 10 });
    const got: string[] = [];
    await src.start((e) => {
      if (e.kind === 'social_post' || e.kind === 'tx_cost') return;
      got.push(`${String(e.slot)}:${e.kind}:${e.sig}`);
    });
    expect(got).toEqual(['12:token_created:x', '12:trade:x', '12:trade:y', '21:trade:z', '22:curve_completed:l', '24:trade:p']);
    expect(src.stats).toMatchObject({ chunks: 2, duplicates: 1 });
    // a pumpswap sem mint (pool não resolvida) chega como poolUnresolved
    const stopped = new ClickHouseReplaySource(query, { fromMs: 0, toMs: 99_000, liveCreatedFromMs: 0, liveCreatedToMs: 99_000, chunkSlots: 10 });
    const few: string[] = [];
    await stopped.start((e) => {
      few.push(e.kind);
      void stopped.stop();
    });
    expect(few).toHaveLength(1);
    expect(queries.some((q) => q.includes("venue = 'pumpswap'") && q.includes('mint IN'))).toBe(true);
  });
});

describe('comparação replay × paper', () => {
  it('pareia por mint ± tolerância e explica as entradas sem par pelo outro lado', async () => {
    const r = await executeReplay(inputs(scenario()), [variant()], { ...PARAMS, failRate: 0 });
    const v = r.variants[0];
    if (!v) throw new Error('variant');
    const replay = { decisions: v.decisions.map(toReportDecision), fills: v.fills.map(toReportFill) };
    const shifted = { decisions: replay.decisions.map((d) => (d.mint === 'C' ? { ...d, ts: d.ts + 60_000 } : d)), fills: replay.fills };
    const paper = { decisions: [...shifted.decisions.filter((d) => d.mint !== 'B'), { ts: T0 + 70_000, decisionId: 'x', mint: 'B', type: 'reject' as const, reason: 'maxOpenPositions' }], fills: shifted.fills };
    const cmp = compareEntries(paper, replay, 10_000);
    const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();
    expect(uniq(cmp.matched.map((m) => m.mint))).toEqual(['A']);
    expect(uniq(cmp.onlyReplay.filter((m) => m.mint === 'B').map((m) => m.otherSide))).toEqual(['reject:maxOpenPositions']);
    expect(cmp.onlyReplay.filter((m) => m.mint === 'C').every((m) => m.otherSide.startsWith('enter em outro horário'))).toBe(true);
    expect(cmp.onlyReplayWhy.find((w) => w.why === 'enter em outro horário (> tolerância)')?.count).toBe(cmp.onlyReplay.filter((m) => m.mint === 'C').length);
    expect(uniq(cmp.onlyPaper.map((m) => m.mint))).toEqual(['C']);
    expect(cmp.matched.every((m) => m.paperNetLamports === m.replayNetLamports)).toBe(true);
  });
});
