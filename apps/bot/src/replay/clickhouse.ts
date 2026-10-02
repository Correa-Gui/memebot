import type { CurveCompletedEvent, CurveTradeEvent, EventSource, PoolCreatedEvent, PumpEvent, PumpSwapTradeEvent, SocialEvent, TokenCreatedEvent } from '@memebot/core';
import type { TokenSkeleton } from '@memebot/state';
import { z } from 'zod';
import { reconnectIntervals, silenceGaps, mergeIntervals, type Interval } from './gaps.ts';
import { sortAndDedupe, type ReplayEvent } from './order.ts';
import type { ProtocolRow, TimedCostSample } from './schedules.ts';

/**
 * Adaptador de leitura do ClickHouse para o replay (Fase 4). Toda linha passa por zod (fronteira
 * externa, CLAUDE.md §6). O acesso ao banco é injetado (`QueryFn`) — o teste usa um falso, sem rede.
 */
export type QueryFn = (query: string, params: Record<string, unknown>) => Promise<unknown[]>;

const u = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const n = z.union([z.string(), z.number()]).transform((v) => Number(v)).pipe(z.number().finite());
const PROGRAM_PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const Base = { slot: u, ts_ms: n, recv_ms: n, recv_seq: n, sig: z.string(), event_index: n };
const CurveRow = z.object({
  ...Base, mint: z.string(), trader: z.string(), side: z.enum(['buy', 'sell']), quote_mint: z.string(), quote_amount: u, token_amount: u,
  vq: u, vt: u, rq: u, rt: u, protocol_fee: u, creator_fee: u, ix_name: z.string().nullable(),
});
const SwapRow = z.object({
  ...Base, pool: z.string(), mint: z.string(), trader: z.string(), side: z.enum(['buy', 'sell']), quote_mint: z.string(), quote_amount: u, token_amount: u,
  user_quote_amount: u.nullable(), pool_base_reserves: u.nullable(), pool_quote_reserves: u.nullable(), lp_fee: u.nullable(), protocol_fee: u, creator_fee: u, ix_name: z.string().nullable(),
});
const TokenRow = z.object({ ...Base, mint: z.string(), creator: z.string(), name: z.string(), symbol: z.string(), uri: z.string(), bonding_curve: z.string(), quote_mint: z.string(), token_total_supply: u });
const LifeRow = z.object({ ...Base, kind: z.enum(['curve_completed', 'pool_created']), mint: z.string(), bonding_curve: z.string().nullable(), pool: z.string().nullable(), quote_mint: z.string().nullable(), creator: z.string().nullable() });

const TIME = 'slot, toUnixTimestamp64Milli(ts) AS ts_ms, toUnixTimestamp64Milli(received_at) AS recv_ms, recv_seq, sig, event_index';
const WINDOW = 'ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64}) AND slot >= {a:UInt64} AND slot < {b:UInt64}';

function base(r: { slot: bigint; ts_ms: number; recv_ms: number; recv_seq: number; sig: string; event_index: number }) {
  return { slot: r.slot, ts: r.ts_ms, sig: r.sig, eventIndex: r.event_index, receivedAtMs: r.recv_ms, recvSeq: r.recv_seq, rawB64: '' };
}

export interface ClickHouseReplaySourceOptions {
  /** Janela de eventos [fromMs, toMs) por `ts` (inclui a drenagem depois do fim das entradas). */
  fromMs: number;
  toMs: number;
  /**
   * Trades do PumpSwap só dos tokens CRIADOS em [liveCreatedFromMs, liveCreatedToMs) — os únicos que o
   * engine pode operar. Os demais (~80% do volume gravado) não mudam nenhuma decisão: o engine só avalia
   * tokens com `token_created` visto no run, só usa trades de curva nas features, e tokens sem criação
   * conhecida são descartados na compactação. Documentado em docs/ARCHITECTURE.md (replay).
   */
  liveCreatedFromMs: number;
  liveCreatedToMs: number;
  /** Tamanho do bloco de leitura em slots (padrão 1.500 ≈ 10 min): limita a memória do Node e do ClickHouse. */
  chunkSlots?: number;
}

export interface SourceStats {
  chunks: number;
  rows: number;
  duplicates: number;
  byKind: Record<string, number>;
}

/**
 * `EventSource` (interface do `packages/core`) de replay a partir do ClickHouse: lê em blocos de slots
 * (streaming — nunca o período inteiro em memória) `events_trade` (curva + PumpSwap filtrado),
 * `events_token` e `events_lifecycle` (curve_completed, pool_created), ordena cada bloco com
 * `compareReplayEvents` e remove linhas duplicadas. Blocos por SLOT (não por ts) para a ordem global ser
 * exata entre blocos. `start` resolve quando todos os eventos foram entregues (ou após `stop()`).
 */
export class ClickHouseReplaySource implements EventSource {
  private stopped = false;
  readonly stats: SourceStats = { chunks: 0, rows: 0, duplicates: 0, byKind: {} };

  private readonly query: QueryFn;
  private readonly o: ClickHouseReplaySourceOptions;

  constructor(query: QueryFn, o: ClickHouseReplaySourceOptions) {
    this.query = query;
    this.o = o;
  }

  async start(onEvent: (e: PumpEvent | SocialEvent) => void): Promise<void> {
    const bounds = z.object({ lo: u, hi: u }).parse((await this.query(
      'SELECT min(slot) AS lo, max(slot) AS hi FROM events_trade WHERE ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})',
      { from: this.o.fromMs, to: this.o.toMs },
    ))[0]);
    if (bounds.hi < bounds.lo || bounds.hi === 0n) return;
    const step = BigInt(this.o.chunkSlots ?? 1_500);
    // pré-carga do próximo bloco enquanto o atual é processado (I/O × CPU em paralelo)
    let next: Promise<ReplayEvent[]> | null = this.loadChunk(bounds.lo, bounds.lo + step);
    for (let a = bounds.lo; a <= bounds.hi && next; a += step) {
      const events = await next;
      const nb = a + step;
      next = !this.stopped && nb <= bounds.hi ? this.loadChunk(nb, nb + step) : null;
      for (const e of events) {
        if (this.stopped) break;
        onEvent(e);
      }
      if (this.stopped) break;
    }
    if (next) await next.catch(() => undefined);
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  private async loadChunk(a: bigint, b: bigint): Promise<ReplayEvent[]> {
    const p = { from: this.o.fromMs, to: this.o.toMs, a: a.toString(), b: b.toString(), liveFrom: this.o.liveCreatedFromMs, liveTo: this.o.liveCreatedToMs };
    const live = 'SELECT mint FROM events_token WHERE ts >= fromUnixTimestamp64Milli({liveFrom:Int64}) AND ts < fromUnixTimestamp64Milli({liveTo:Int64})';
    const [curve, swap, tokens, life] = await Promise.all([
      this.query(
        `SELECT ${TIME}, mint, trader, side, quote_mint, quote_amount, token_amount, virtual_quote_reserves AS vq, virtual_token_reserves AS vt, ` +
          `real_quote_reserves AS rq, real_token_reserves AS rt, protocol_fee, creator_fee, ix_name FROM events_trade WHERE venue = 'curve' AND ${WINDOW}`,
        p,
      ),
      this.query(
        `SELECT ${TIME}, pool, mint, trader, side, quote_mint, quote_amount, token_amount, user_quote_amount, pool_base_reserves, pool_quote_reserves, lp_fee, ` +
          `protocol_fee, creator_fee, ix_name FROM events_trade WHERE venue = 'pumpswap' AND ${WINDOW} AND (mint IN (${live}) OR ` +
          `(mint = '' AND pool IN (SELECT pool FROM events_lifecycle WHERE kind = 'pool_created' AND mint IN (${live}))))`,
        p,
      ),
      this.query(`SELECT ${TIME}, mint, creator, name, symbol, uri, bonding_curve, quote_mint, token_total_supply FROM events_token WHERE ${WINDOW}`, p),
      this.query(`SELECT ${TIME}, kind, mint, bonding_curve, pool, quote_mint, creator FROM events_lifecycle WHERE ${WINDOW}`, p),
    ]);
    const out: ReplayEvent[] = [];
    for (const x of curve) {
      const r = CurveRow.parse(x);
      out.push({
        kind: 'trade', venue: 'curve', ...base(r), mint: r.mint, trader: r.trader, side: r.side, quoteMint: r.quote_mint, quoteAmount: r.quote_amount,
        tokenAmount: r.token_amount, virtualQuoteReserves: r.vq, virtualTokenReserves: r.vt, realQuoteReserves: r.rq, realTokenReserves: r.rt,
        protocolFee: r.protocol_fee, creatorFee: r.creator_fee, ixName: r.ix_name ?? '',
      } satisfies CurveTradeEvent);
    }
    for (const x of swap) {
      const r = SwapRow.parse(x);
      out.push({
        kind: 'trade', venue: 'pumpswap', ...base(r), pool: r.pool, mint: r.mint, quoteMint: r.quote_mint, poolUnresolved: r.mint === '', trader: r.trader,
        side: r.side, tokenAmount: r.token_amount, quoteAmount: r.quote_amount, userQuoteAmount: r.user_quote_amount ?? 0n,
        poolBaseReserves: r.pool_base_reserves ?? 0n, poolQuoteReserves: r.pool_quote_reserves ?? 0n, lpFee: r.lp_fee ?? 0n,
        protocolFee: r.protocol_fee, creatorFee: r.creator_fee, ixName: r.ix_name,
      } satisfies PumpSwapTradeEvent);
    }
    for (const x of tokens) {
      const r = TokenRow.parse(x);
      out.push({
        kind: 'token_created', ...base(r), mint: r.mint, creator: r.creator, name: r.name, symbol: r.symbol, uri: r.uri, bondingCurve: r.bonding_curve,
        quoteMint: r.quote_mint, tokenTotalSupply: r.token_total_supply,
      } satisfies TokenCreatedEvent);
    }
    for (const x of life) {
      const r = LifeRow.parse(x);
      if (r.kind === 'curve_completed') out.push({ kind: 'curve_completed', ...base(r), mint: r.mint, bondingCurve: r.bonding_curve ?? '' } satisfies CurveCompletedEvent);
      else out.push({ kind: 'pool_created', ...base(r), pool: r.pool ?? '', mint: r.mint, quoteMint: r.quote_mint ?? '', creator: r.creator ?? '' } satisfies PoolCreatedEvent);
    }
    const { events, duplicates } = sortAndDedupe(out);
    this.stats.chunks++;
    this.stats.rows += out.length;
    this.stats.duplicates += duplicates;
    for (const e of events) {
      const k = e.kind === 'trade' ? `trade_${e.venue}` : e.kind;
      this.stats.byKind[k] = (this.stats.byKind[k] ?? 0) + 1;
    }
    return events;
  }
}

// ---------- leituras de apoio (uma vez por período) ----------

const SkeletonRow = z.object({ mint: z.string(), creator: z.string(), ts_ms: n, slot: u, quote_mint: z.string(), token_total_supply: u });

/** `token_created` com ts em [fromMs, toMs) como esqueletos (pré-carga de 24 h, igual ao paper). */
export async function loadSkeletons(query: QueryFn, fromMs: number, toMs: number): Promise<TokenSkeleton[]> {
  const rows = await query(
    'SELECT mint, creator, toUnixTimestamp64Milli(ts) AS ts_ms, slot, quote_mint, token_total_supply FROM events_token ' +
      'WHERE ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64}) ORDER BY ts, mint',
    { from: fromMs, to: toMs },
  );
  return rows.map((x) => {
    const r = SkeletonRow.parse(x);
    return { mint: r.mint, creator: r.creator, createdAtMs: r.ts_ms, createdAtSlot: r.slot, quoteMint: r.quote_mint, tokenTotalSupply: r.token_total_supply };
  });
}

const CostRow = z.object({ sampled_ms: n, priority_fee: u, jito_tip: u.nullable() });

/** Amostras de `tx_costs` com `sampled_at` em [fromMs, toMs]. */
export async function loadCostSamples(query: QueryFn, fromMs: number, toMs: number): Promise<TimedCostSample[]> {
  const rows = await query(
    'SELECT toUnixTimestamp64Milli(sampled_at) AS sampled_ms, priority_fee, jito_tip FROM tx_costs ' +
      'WHERE sampled_at >= fromUnixTimestamp64Milli({from:Int64}) AND sampled_at <= fromUnixTimestamp64Milli({to:Int64}) ORDER BY sampled_at, sig',
    { from: fromMs, to: toMs },
  );
  return rows.map((x) => {
    const r = CostRow.parse(x);
    return { sampledAtMs: r.sampled_ms, priorityFee: r.priority_fee, jitoTip: r.jito_tip };
  });
}

const ProtoRow = z.object({ ts_ms: n, account_type: z.enum(['Global', 'FeeConfig']), config_json: z.string() });

/** `protocol_config` do Pump.fun (Global, FeeConfig) com ts ≤ toMs. */
export async function loadProtocolRows(query: QueryFn, toMs: number): Promise<ProtocolRow[]> {
  const rows = await query(
    "SELECT toUnixTimestamp64Milli(ts) AS ts_ms, account_type, config_json FROM protocol_config WHERE program_id = {program:String} " +
      "AND account_type IN ('Global', 'FeeConfig') AND ts <= fromUnixTimestamp64Milli({to:Int64}) ORDER BY ts, account_type",
    { program: PROGRAM_PUMP, to: toMs },
  );
  return rows.map((x) => {
    const r = ProtoRow.parse(x);
    return { tsMs: r.ts_ms, accountType: r.account_type, configJson: r.config_json };
  });
}

/** Lacunas de gravação em [fromMs, toMs): segundos sem trade de curva (≥ `minMissingSec`) ∪ reconnects. */
export async function loadGaps(query: QueryFn, fromMs: number, toMs: number, minMissingSec = 4): Promise<Interval[]> {
  const secs = (await query(
    "SELECT DISTINCT toUnixTimestamp(ts) AS s FROM events_trade WHERE venue = 'curve' AND ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64}) ORDER BY s",
    { from: fromMs, to: toMs },
  )).map((x) => z.object({ s: n }).parse(x).s);
  const rec = (await query(
    "SELECT toUnixTimestamp64Milli(detected_at) AS detected_ms, duration_ms FROM ingest_gaps WHERE kind = 'reconnect' " +
      'AND detected_at >= fromUnixTimestamp64Milli({from:Int64}) AND detected_at < fromUnixTimestamp64Milli({to:Int64})',
    { from: fromMs, to: toMs },
  )).map((x) => {
    const r = z.object({ detected_ms: n, duration_ms: n }).parse(x);
    return { detectedAtMs: r.detected_ms, durationMs: r.duration_ms };
  });
  return mergeIntervals([...silenceGaps(secs, fromMs, toMs, minMissingSec), ...reconnectIntervals(rec)]);
}

/** Último `ts` gravado em `events_trade` (fim dos dados). */
export async function loadDataEndMs(query: QueryFn): Promise<number> {
  return z.object({ m: n }).parse((await query('SELECT toUnixTimestamp64Milli(max(ts)) AS m FROM events_trade', {}))[0]).m;
}
