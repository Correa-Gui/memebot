import { parseArgs } from 'node:util';
import { createClient } from '@clickhouse/client';
import type { CurveCompletedEvent, CurveTradeEvent, PumpEvent, TokenCreatedEvent } from '@memebot/core';
import { loadConfigFromEnvFile } from '@memebot/core';
import { parseCurveInitialParams } from '@memebot/curve-math';
import { MarketStore } from '@memebot/state';
import { loadStrategyConfig } from '@memebot/strategy';
import { z } from 'zod';
import { computeFunnel, funnelSteps, percentile, snapshot, type FunnelSnapshot } from './funnel/compute.ts';

/**
 * `pnpm funnel --run=<id> [--to=<ISO>] [--step=10]` — funil de rejeição de um run de paper (análise
 * offline; não decide nada, não grava nada). Refaz o mercado com os eventos gravados no intervalo do
 * run (+ token_created das 24 h anteriores, só para o filtro de criador) e avalia cada token criado
 * DURANTE o run a cada `step` s da janela de idade [minAgeSec, maxAgeSec], só nos intervalos em que
 * houve trade dele (o engine avalia em trade, no máximo 1×/s — aqui a grade é mais grossa).
 */

const u = z.coerce.bigint();
const n = z.coerce.number();
const TradeRow = z.object({ slot: u, ts_ms: n, recv_ms: n, recv_seq: n, sig: z.string(), event_index: n, mint: z.string(), trader: z.string(), side: z.enum(['buy', 'sell']), quote_mint: z.string(), quote_amount: u, token_amount: u, vq: u, vt: u, rq: u, rt: u, protocol_fee: u, creator_fee: u, ix_name: z.string().nullable() });
const TokenRow = z.object({ slot: u, ts_ms: n, recv_ms: n, recv_seq: n, sig: z.string(), event_index: n, mint: z.string(), creator: z.string(), quote_mint: z.string(), bonding_curve: z.string(), token_total_supply: u });
const LifeRow = z.object({ slot: u, ts_ms: n, recv_ms: n, recv_seq: n, sig: z.string(), event_index: n, mint: z.string(), bonding_curve: z.string() });

interface Timed { ev: PumpEvent; recvMs: number; recvSeq: number }

const brt = (ms: number): string =>
  `${new Date(ms - 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')} BRT (${new Date(ms).toISOString().slice(11, 19)} UTC)`;

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { run: { type: 'string' }, to: { type: 'string' }, step: { type: 'string' }, config: { type: 'string' } }, strict: true });
  const runId = values.run;
  if (!runId) throw new Error('uso: pnpm funnel --run=<run_id> [--to=<ISO>] [--step=10]');
  const stepMs = Number(values.step ?? '10') * 1000;
  const cfg = loadConfigFromEnvFile();
  const strategy = loadStrategyConfig(values.config ?? 'config/strategy.v0.yaml');
  const client = createClient({ url: cfg.CLICKHOUSE_URL, username: cfg.CLICKHOUSE_USER, password: cfg.CLICKHOUSE_PASSWORD, database: cfg.CLICKHOUSE_DB, request_timeout: 300_000 });
  const q = async (query: string, params: Record<string, unknown>): Promise<unknown[]> => (await client.query({ query, query_params: params, format: 'JSONEachRow' })).json<unknown>();

  try {
    const run = z.object({ started_ms: n }).parse((await q('SELECT toUnixTimestamp64Milli(started_at) AS started_ms FROM runs WHERE run_id = {runId:String}', { runId }))[0]);
    const endRow = z.object({ end_ms: n }).parse((await q('SELECT toUnixTimestamp64Milli(max(ts)) AS end_ms FROM decisions WHERE run_id = {runId:String}', { runId }))[0]);
    const startMs = run.started_ms;
    const endMs = values.to ? Date.parse(values.to) : endRow.end_ms;
    const global = z.object({ config_json: z.string() }).parse(
      (await q("SELECT config_json FROM protocol_config WHERE account_type = 'Global' AND ts <= fromUnixTimestamp64Milli({end:Int64}) ORDER BY ts DESC LIMIT 1", { end: endMs }))[0],
    );
    const curveParams = parseCurveInitialParams(JSON.parse(global.config_json));
    const p = { from: startMs, to: endMs, seedFrom: startMs - 24 * 3_600_000 };
    const time = 'toUnixTimestamp64Milli(ts) AS ts_ms, toUnixTimestamp64Milli(received_at) AS recv_ms, recv_seq, sig, event_index';
    const win = 'ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts <= fromUnixTimestamp64Milli({to:Int64})';

    const store = new MarketStore();
    for (const r of (await q(`SELECT slot, ${time}, mint, creator, quote_mint, bonding_curve, token_total_supply FROM events_token WHERE ts >= fromUnixTimestamp64Milli({seedFrom:Int64}) AND ts < fromUnixTimestamp64Milli({from:Int64})`, p)).map((x) => TokenRow.parse(x))) {
      store.seedSkeleton({ mint: r.mint, creator: r.creator, createdAtMs: r.ts_ms, createdAtSlot: r.slot, quoteMint: r.quote_mint, tokenTotalSupply: r.token_total_supply });
    }

    const events: Timed[] = [];
    const base = (r: { slot: bigint; ts_ms: number; sig: string; event_index: number; recv_ms: number; recv_seq: number }) => ({ slot: r.slot, ts: r.ts_ms, sig: r.sig, eventIndex: r.event_index, receivedAtMs: r.recv_ms, recvSeq: r.recv_seq, rawB64: '' });
    const liveMints = new Map<string, number>();
    for (const r of (await q(`SELECT slot, ${time}, mint, creator, quote_mint, bonding_curve, token_total_supply FROM events_token WHERE ${win}`, p)).map((x) => TokenRow.parse(x))) {
      const ev: TokenCreatedEvent = { kind: 'token_created', ...base(r), mint: r.mint, creator: r.creator, name: '', symbol: '', uri: '', bondingCurve: r.bonding_curve, quoteMint: r.quote_mint, tokenTotalSupply: r.token_total_supply };
      events.push({ ev, recvMs: r.recv_ms, recvSeq: r.recv_seq });
      liveMints.set(r.mint, r.ts_ms);
    }
    for (const r of (await q(`SELECT slot, ${time}, mint, bonding_curve FROM events_lifecycle WHERE kind = 'curve_completed' AND ${win}`, p)).map((x) => LifeRow.parse(x))) {
      const ev: CurveCompletedEvent = { kind: 'curve_completed', ...base(r), mint: r.mint, bondingCurve: r.bonding_curve };
      events.push({ ev, recvMs: r.recv_ms, recvSeq: r.recv_seq });
    }
    const trades = await q(
      `SELECT slot, ${time}, mint, trader, side, quote_mint, quote_amount, token_amount, virtual_quote_reserves AS vq, virtual_token_reserves AS vt, real_quote_reserves AS rq, real_token_reserves AS rt, protocol_fee, creator_fee, ix_name FROM events_trade WHERE venue = 'curve' AND ${win}`,
      p,
    );
    for (const x of trades) {
      const r = TradeRow.parse(x);
      const ev: CurveTradeEvent = { kind: 'trade', venue: 'curve', ...base(r), mint: r.mint, trader: r.trader, side: r.side, quoteMint: r.quote_mint, quoteAmount: r.quote_amount, tokenAmount: r.token_amount, virtualQuoteReserves: r.vq, virtualTokenReserves: r.vt, realQuoteReserves: r.rq, realTokenReserves: r.rt, protocolFee: r.protocol_fee, creatorFee: r.creator_fee, ixName: r.ix_name ?? '' };
      events.push({ ev, recvMs: r.recv_ms, recvSeq: r.recv_seq });
    }
    // ordem do engine: ordem de chegada (slot, depois chegada)
    events.sort((a, b) => (a.ev.slot === b.ev.slot ? a.recvMs - b.recvMs || a.recvSeq - b.recvSeq : a.ev.slot < b.ev.slot ? -1 : 1));

    // grade de avaliação: token vivo, idade em [min, max], só se houve trade dele desde a última marca
    const minAge = strategy.entry.minAgeSec * 1000;
    const maxAge = strategy.entry.maxAgeSec * 1000;
    const tradedSinceLast = new Set<string>();
    const evaluations: FunnelSnapshot[] = [];
    let nextGrid = startMs + stepMs;
    const evaluateGrid = (t: number): void => {
      for (const mint of tradedSinceLast) {
        const created = liveMints.get(mint);
        const token = store.state.tokens.get(mint);
        if (created === undefined || !token || token.curveCompleted) continue;
        const age = t - created;
        if (age < minAge || age > maxAge) continue;
        evaluations.push(snapshot(store.state, token, t, strategy, curveParams));
      }
      tradedSinceLast.clear();
    };
    for (const { ev } of events) {
      while ('ts' in ev && ev.ts > nextGrid) {
        evaluateGrid(nextGrid);
        nextGrid += stepMs;
      }
      const mint = store.apply(ev);
      if (mint && ev.kind === 'trade') tradedSinceLast.add(mint);
    }
    evaluateGrid(nextGrid);

    const fmt = (x: number | null, d = 3): string => (x === null ? '—' : x.toLocaleString('pt-BR', { maximumFractionDigits: d }));
    console.log(`Funil — run ${runId}`);
    console.log(`Janela: ${brt(startMs)} → ${brt(endMs)}; grade ${String(stepMs / 1000)} s; ${String(trades.length)} trades de curva; ${String(liveMints.size)} tokens criados no run.`);
    for (const version of ['v0', 'v0.1'] as const) {
      const steps = funnelSteps(strategy, version);
      const r = computeFunnel(evaluations, steps);
      console.log(`\n${version === 'v0' ? 'Como rodou (v0: slot de criação inclui o criador)' : 'v0.1 (slot de criação sem o criador)'} — ${String(r.tokens)} tokens avaliados, ${String(r.evaluations)} avaliações`);
      let prev = r.tokens;
      steps.forEach((s, i) => {
        const now = r.passed[i] ?? 0;
        console.log(`  ${String(i + 1).padStart(2)}. ${s.label.padEnd(42)} passam ${String(now).padStart(5)}  (barrados aqui: ${String(prev - now)})`);
        prev = now;
      });
      console.log(`  → chegam ao gatilho: ${String(r.passed[6] ?? 0)}; passam o gatilho (entrariam): ${String(r.passed[steps.length - 1] ?? 0)}`);
      if (version === 'v0') {
        const snaps = r.bestSnapshots;
        console.log('\nDistribuição por token (snapshot no momento do melhor estágio), p10 / p25 / p50 / p75 / p90:');
        const keys: (keyof FunnelSnapshot)[] = ['top10HolderPct', 'sameSlotBuyPctV0', 'sameSlotBuyPct', 'creatorInitialBuyPct', 'creatorHoldingPct', 'creatorTokensCreated24h', 'uniqueHolders', 'volume60sSol', 'buySellVolumeRatio60s', 'uniqueBuyers60s', 'largestSingleSellPctSupply60s', 'curveProgress', 'ageSec'];
        for (const k of keys) {
          const vals = snaps.map((s) => s[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
          console.log(`  ${k.padEnd(30)} ${[0.1, 0.25, 0.5, 0.75, 0.9].map((q) => fmt(percentile(vals, q))).join(' / ')}  (n=${String(vals.length)})`);
        }
        const above = snaps.filter((s) => s.priceAboveMean120s === true).length;
        console.log(`  priceAboveMean120s             true em ${String(above)} de ${String(snaps.length)} tokens`);
      }
    }
  } finally {
    await client.close();
  }
}

await main();
