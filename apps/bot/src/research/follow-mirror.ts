/** Offline exploratory replay. SELECT only; never starts the bot or modifies strategy/pm2. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createClient, ClickHouseLogLevel } from '@clickhouse/client';
import { loadConfigFromEnvFile } from '@memebot/core';
import { pumpSwapBuyExactBaseOut, pumpSwapBuyExactQuoteIn, pumpSwapSell, effectivePumpSwapFeeBps } from '@memebot/curve-math';
import { PUMP_IDL, PUMP_AMM_IDL } from '../../../../packages/ingest/src/idl.ts';
import { FollowSimulation, clusterCI, checkpointName, type Market, type Outcome, type Signal, type WalletType } from './follow-mirror-engine.ts';

const FROM = Date.parse('2026-10-03T22:56:12.222Z');
const SPLIT = Date.parse('2026-10-04T20:46:40Z');
const END = Date.parse('2026-10-05T18:37:07.729Z');
const DIR = 'data/reports/follow-mirror-2026-10-06';
const cfg = loadConfigFromEnvFile();
const client = createClient({ url: cfg.CLICKHOUSE_URL, username: cfg.CLICKHOUSE_USER, password: cfg.CLICKHOUSE_PASSWORD,
  database: cfg.CLICKHOUSE_DB, request_timeout: 900_000, log: { level: ClickHouseLogLevel.ERROR } });
const integer = z.union([z.string(), z.number()]).transform((v) => BigInt(v));
const msNumber = z.union([z.string(), z.number()]).transform(Number);
const rowSchema = z.object({ mint: z.string(), trader: z.string(), ms: msNumber, sig: z.string(), event_index: msNumber,
  side: z.enum(['buy', 'sell']), venue: z.enum(['curve', 'pumpswap']), pool: z.string(), token_amount: integer, raw_b64: z.string() });
type Row = z.infer<typeof rowSchema>;
const fillSchema = z.object({ ms: z.number(), dueMs: z.number(), side: z.enum(['buy', 'sell']), reason: z.string(),
  tokens: integer, quote: integer, dexFee: integer, networkFee: integer, venue: z.string(), pool: z.string() });
const outcomeSchema = z.object({ trader: z.string(), mint: z.string(), signalMs: z.number(),
  type: z.enum(['human probable', 'bot probable', 'sniper', 'creator']), delay: z.number(), policy: z.enum(['mirror', 'fixed']),
  status: z.enum(['closed', 'no_entry', 'censored', 'unfilled']), entryMs: z.number().nullable(), exitMs: z.number().nullable(),
  pnl: integer, dexFees: integer, networkFees: integer, remaining: integer, reason: z.string(), unknownInventory: z.boolean(), fills: z.array(fillSchema) });
const checkpointSchema = z.object({ version: z.literal('mirror-v1-2026-10-06'), prefix: z.string(), inputHash: z.string(),
  stats: z.record(z.number()), outcomes: z.array(outcomeSchema) });
const stats: Record<string, number> = {};
function count(key: string): void { stats[key] = (stats[key] ?? 0) + 1; }
function stringify(v: unknown): string { return JSON.stringify(v, (_k, x: unknown) => typeof x === 'bigint' ? x.toString() : x, 2); }
async function stream(sql: string, params: Record<string, unknown>, consume: (x: unknown) => void): Promise<void> {
  const r = await client.query({ query: sql, query_params: params, format: 'JSONEachRow', clickhouse_settings: {
    max_threads: 1, max_memory_usage: '450000000', max_bytes_before_external_sort: '48000000',
    max_bytes_before_external_group_by: '48000000', max_execution_time: 900, max_block_size: '512',
  } });
  for await (const block of r.stream()) for (const line of block) consume(line.json());
}

function market(r: Row): Market | null {
  if (!r.raw_b64) { count('missing_raw'); return null; }
  try {
    const ev = (r.venue === 'curve' ? PUMP_IDL : PUMP_AMM_IDL).decodeEvent(Buffer.from(r.raw_b64, 'base64'));
    if (!ev) { count('unknown_event'); return null; }
    const n = (key: string): bigint => {
      const v = ev.data[key];
      if (typeof v !== 'bigint' && typeof v !== 'number') throw new Error(`missing_integer:${key}`);
      return BigInt(v);
    };
    if (r.venue === 'curve') {
      // The current curve-math contract has two fee components; never invent support for cashback.
      if (n('cashback_fee_basis_points') !== 0n) { count('unsupported_curve_cashback'); return null; }
      return { venue: 'curve', pool: r.mint, quote: n('virtual_quote_reserves'), base: n('virtual_token_reserves'),
        realQuote: n('real_quote_reserves'), realBase: n('real_token_reserves'),
        fees: { protocolFeeBps: n('fee_basis_points'), creatorFeeBps: n('creator_fee_basis_points') } };
    }
    const fees = effectivePumpSwapFeeBps({ lpFeeBps: n('lp_fee_basis_points'), protocolFeeBps: n('protocol_fee_basis_points'),
      creatorFeeBps: n('coin_creator_fee_basis_points'), cashbackFeeBps: n('cashback_fee_basis_points') }, n('coin_creator_fee') !== 0n);
    const before = { base: n('pool_base_token_reserves'), quote: n('pool_quote_token_reserves'), virtualQuote: n('virtual_quote_reserves') };
    const ix = ev.data['ix_name'];
    const actual = r.side === 'sell' ? pumpSwapSell(before, r.token_amount, fees)
      : ix === 'buy_exact_quote_in' ? pumpSwapBuyExactQuoteIn(before, n('quote_amount_in'), fees)
        : pumpSwapBuyExactBaseOut(before, r.token_amount, fees);
    // Verify the decoded state/formula against the actual recorded swap before quoting our own trade.
    if ('baseOut' in actual ? actual.baseOut !== r.token_amount : actual.netQuoteOut !== n('user_quote_amount_out')) {
      count('swap_reconstruction_mismatch'); return null;
    }
    count('swap_reconstruction_exact');
    return { venue: 'pumpswap', pool: r.pool, ...actual.reservesAfter, fees };
  } catch (e) {
    count(`invalid_market:${e instanceof Error ? e.message.slice(0, 90) : 'unknown'}`); return null;
  }
}

async function main(): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await mkdir(`${DIR}/parts`, { recursive: true });
  const selectedText = await readFile('data/reports/_wallet_final_analysis_2026-10-05.json', 'utf8');
  const previousText = await readFile('data/reports/_wallet_follow_2026-10-05.json', 'utf8');
  const inputHash = createHash('sha256').update(selectedText).update(previousText).digest('hex');
  const selected = z.object({ top: z.array(z.object({ wallet: z.string(), flags: z.object({ sniper: z.boolean(), bot: z.boolean(), creator: z.boolean() }) })) }).parse(JSON.parse(selectedText));
  const types = new Map(selected.top.map((w): [string, WalletType] => [w.wallet, w.flags.sniper ? 'sniper' : w.flags.bot ? 'bot probable' : w.flags.creator ? 'creator' : 'human probable']));
  const previous = z.object({ signals: z.record(z.array(z.object({ trader: z.string(), mint: z.string(), signalMs: z.number(), pnlLamports: z.number() }))), summary: z.unknown() }).parse(JSON.parse(previousText));
  const previousSignals = previous.signals['1'];
  if (!previousSignals || previousSignals.length !== 10124 || types.size !== 50) throw new Error('Previous experiment inputs changed');
  const signals: Signal[] = previousSignals.map((s) => ({ trader: s.trader, mint: s.mint, signalMs: s.signalMs, type: types.get(s.trader) ?? 'human probable' }));
  // Predeclared time-only exclusion; use a shared 60-minute horizon for the fixed/mirror comparison.
  const eligible = signals.filter((s) => s.signalMs + 3_630_000 < END);
  const byMint = new Map<string, Signal[]>();
  for (const s of eligible) byMint.set(s.mint, [...(byMint.get(s.mint) ?? []), s]);
  const costSchema = z.object({ ms: msNumber, fee: integer, priority_fee: integer, jito_tip: integer.nullable(), num_signatures: msNumber });
  const costs: z.infer<typeof costSchema>[] = [];
  await stream('SELECT toUnixTimestamp64Milli(sampled_at) ms,fee,priority_fee,jito_tip,num_signatures FROM tx_costs WHERE sampled_at < fromUnixTimestamp64Milli({end:Int64}) ORDER BY sampled_at', { end: END }, (x) => { costs.push(costSchema.parse(x)); });
  const costHours = new Map<number, { fee: bigint; samples: number }>();
  for (let h = Math.floor(SPLIT / 3_600_000); h <= Math.floor(END / 3_600_000); h++) {
    const t = h * 3_600_000;
    const sample = costs.filter((x) => x.ms < t && x.ms >= t - 86_400_000 && x.num_signatures === 1);
    if (sample.length < 30) throw new Error(`Insufficient causal network samples at hour ${String(h)}`);
    const vals = sample.map((x) => x.fee + (x.jito_tip ?? 0n)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    costHours.set(h, { fee: vals[Math.floor(vals.length / 2)] ?? 0n, samples: vals.length });
  }
  const network = (ms: number): bigint => {
    const c = costHours.get(Math.floor(ms / 3_600_000));
    if (!c) throw new Error('Missing causal cost window'); return c.fee;
  };
  const all: Outcome[] = [];
  const prefixes = [...new Set([...byMint.keys()].map((m) => m[0] ?? ''))].sort();
  const selectedColumns = 'mint,trader,toUnixTimestamp64Milli(ts) ms,sig,event_index,toString(side) side,toString(venue) venue,pool,token_amount';
  for (const prefix of prefixes) {
    // ASCII codes avoid A/a checkpoint collisions on Windows filesystems.
    const checkpoint = `${DIR}/parts/${checkpointName(prefix)}`;
    if (process.argv.includes('--resume')) {
      const text = await readFile(checkpoint, 'utf8').catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return null; throw e;
      });
      if (text !== null) {
        const saved = checkpointSchema.parse(JSON.parse(text));
        if (saved.prefix !== prefix || saved.inputHash !== inputHash || saved.outcomes.some((x) => !x.mint.startsWith(prefix))) throw new Error('Checkpoint input mismatch');
        all.push(...saved.outcomes);
        for (const [k, v] of Object.entries(saved.stats)) stats[k] = (stats[k] ?? 0) + v;
        console.log(JSON.stringify({ prefix, resumed: saved.outcomes.length }));
        continue;
      }
    }
    const statsBefore = { ...stats };
    const mints = [...byMint.keys()].filter((m) => m.startsWith(prefix));
    const balances = new Map<string, { balance: bigint; unknown: boolean }>();
    let lastMint = ''; let seen = new Set<string>();
    await stream(`SELECT ${selectedColumns},'' raw_b64 FROM events_trade
      WHERE ts < fromUnixTimestamp64Milli({split:Int64}) AND mint IN {mints:Array(String)} AND trader IN {wallets:Array(String)}
      AND quote_mint IN ('11111111111111111111111111111111','So11111111111111111111111111111111111111112')
      ORDER BY mint,ts,slot,received_at,recv_seq,sig,event_index`, { split: SPLIT, mints, wallets: [...types.keys()] }, (x) => {
      const r = rowSchema.parse(x); if (r.mint !== lastMint) { lastMint = r.mint; seen = new Set(); }
      const id = `${r.sig}:${String(r.event_index)}`; if (seen.has(id)) return; seen.add(id);
      const key = `${r.trader}|${r.mint}`; const state = balances.get(key) ?? { balance: 0n, unknown: false };
      state.balance += r.side === 'buy' ? r.token_amount : -r.token_amount;
      if (state.balance < 0n) { state.balance = 0n; state.unknown = true; }
      balances.set(key, state);
    });
    const simulations = new Map<string, FollowSimulation[]>();
    for (const mint of mints) simulations.set(mint, (byMint.get(mint) ?? []).map((s) => {
      const b = balances.get(`${s.trader}|${s.mint}`);
      return new FollowSimulation(s, b?.balance ?? 0n, b?.unknown ?? false, END, network);
    }));
    lastMint = ''; seen = new Set(); let rows = 0;
    await stream(`SELECT ${selectedColumns},raw_b64 FROM events_trade
      WHERE ts >= fromUnixTimestamp64Milli({split:Int64}) AND ts < fromUnixTimestamp64Milli({end:Int64})
      AND mint IN {mints:Array(String)}
      AND quote_mint IN ('11111111111111111111111111111111','So11111111111111111111111111111111111111112')
      ORDER BY mint,ts,slot,received_at,recv_seq,sig,event_index`, { split: SPLIT, end: END, mints }, (x) => {
      const r = rowSchema.parse(x); rows++;
      if (r.mint !== lastMint) { lastMint = r.mint; seen = new Set(); }
      const id = `${r.sig}:${String(r.event_index)}`;
      if (seen.has(id)) { count('duplicates'); return; } seen.add(id);
      const sims = simulations.get(r.mint) ?? [];
      const t = { trader: r.trader, side: r.side, amount: r.token_amount, ms: r.ms, id };
      for (const sim of sims) sim.observeLeader(t);
      if (!sims.some((s) => s.needsQuote(r.ms))) return;
      const m = market(r); count('market_observations');
      for (const sim of sims) sim.quote(r.ms, id, m);
    });
    const outcomes = [...simulations.values()].flatMap((ss) => ss.flatMap((s) => s.results()));
    const partStats: Record<string, number> = {};
    for (const [k, v] of Object.entries(stats)) if (v !== (statsBefore[k] ?? 0)) partStats[k] = v - (statsBefore[k] ?? 0);
    await writeFile(checkpoint, stringify({ version: 'mirror-v1-2026-10-06', prefix, inputHash, stats: partStats, outcomes }));
    all.push(...outcomes);
    console.log(JSON.stringify({ prefix, mints: mints.length, marketRows: rows, outcomes: outcomes.length, stats }));
  }
  if (all.length !== eligible.length * 6 || new Set(all.map((x) => `${x.trader}|${x.mint}|${String(x.delay)}|${x.policy}`)).size !== all.length) throw new Error('Incomplete or duplicate outcome ledger');
  const summary: unknown[] = [];
  const kinds = ['human probable', 'bot probable', 'sniper', 'creator', 'total'];
  for (const kind of kinds) for (const delay of [1, 5, 30]) {
    const rows = all.filter((x) => (kind === 'total' || x.type === kind) && x.delay === delay);
    const mirror = rows.filter((x) => x.policy === 'mirror' && x.entryMs !== null);
    const fixed = rows.filter((x) => x.policy === 'fixed' && x.entryMs !== null);
    const fixedMap = new Map(fixed.map((x) => [`${x.trader}|${x.mint}`, x]));
    const paired = mirror.flatMap((x) => { const f = fixedMap.get(`${x.trader}|${x.mint}`); return f ? [{ mint: x.mint, pnl: x.pnl - f.pnl }] : []; });
    const historic = previous.signals[String(delay)] ?? [];
    const keys = new Set(mirror.map((x) => `${x.trader}|${x.mint}`));
    const historicMatched = historic.filter((x) => keys.has(`${x.trader}|${x.mint}`)).map((x) => ({ mint: x.mint, pnl: BigInt(Math.round(x.pnlLamports)) }));
    const summarize = (rs: Outcome[]): unknown => ({ ...clusterCI(rs), entries: rs.length, closed: rs.filter((x) => x.status === 'closed').length,
      unfilled: rs.filter((x) => x.status === 'unfilled').length, unknownInventory: rs.filter((x) => x.unknownInventory).length,
      dexFeesSol: Number(rs.reduce((s, x) => s + x.dexFees, 0n)) / 1e9, networkFeesSol: Number(rs.reduce((s, x) => s + x.networkFees, 0n)) / 1e9,
      reasons: Object.fromEntries([...new Set(rs.map((x) => x.reason))].map((reason) => [reason, rs.filter((x) => x.reason === reason).length])),
      closedOnly: clusterCI(rs.filter((x) => x.status === 'closed')),
      knownInventoryOnly: clusterCI(rs.filter((x) => !x.unknownInventory)),
    });
    summary.push({ kind, delay, wallets: kind === 'total' ? types.size : [...types.values()].filter((v) => v === kind).length,
      signals: rows.length / 2, noEntry: rows.filter((x) => x.policy === 'mirror' && x.status === 'no_entry').length,
      censored: rows.filter((x) => x.policy === 'mirror' && x.status === 'censored').length,
      mirror: summarize(mirror), fixed: summarize(fixed), pairedDelta: clusterCI(paired), historicMatched: { entries: historicMatched.length, ...clusterCI(historicMatched) } });
  }
  const result = { exploratory: true, from: new Date(FROM).toISOString(), split: new Date(SPLIT).toISOString(), end: new Date(END).toISOString(),
    inputSha256: { selection: createHash('sha256').update(selectedText).digest('hex'), previous: createHash('sha256').update(previousText).digest('hex') },
    inputSignals: signals.length, eligibleSignals: eligible.length, lateSignalsExcluded: signals.length - eligible.length,
    networkCostHours: [...costHours].map(([hour, value]) => ({ utc: new Date(hour * 3_600_000).toISOString(), ...value })),
    stats, summary, historicSummary: previous.summary };
  await writeFile(`${DIR}/summary.json`, stringify(result));
  await writeFile(`${DIR}/inputs.json`, stringify({ signals, wallets: [...types] }));
  console.log(`DONE ${DIR}/summary.json`);
}
try { await main(); } finally { await client.close(); }
