import type { IngestGap, PumpEvent, PumpSwapTradeEvent } from '@memebot/core';
import type { Decoded } from './borsh.ts';
import type { ParsedLogs, ParsedProgramEvent } from './log-parser.ts';

export interface PoolInfo {
  baseMint: string;
  quoteMint: string;
}

/**
 * Busca base/quote de uma pool on-chain. `'not_pool'` = a conta não existe ou não é uma Pool do
 * PumpSwap (resultado definitivo). Falha transitória (rede, 429) deve lançar erro.
 */
export type PoolResolver = (pool: string) => Promise<PoolInfo | 'not_pool'>;

/** Espera antes de tentar de novo uma pool cuja resolução falhou: 1 s, 2 s, 4 s... até 5 min. */
export function poolRetryDelayMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

interface LookupOutcome {
  info: PoolInfo | null;
  /** Preenchido só para quem disparou a tentativa que falhou (um gap por tentativa, não por trade). */
  failure?: string;
}

export class NormalizeError extends Error {
  override name = 'NormalizeError';
}

function field<T>(d: { [k: string]: Decoded }, k: string, check: (v: Decoded) => v is T & Decoded, type: string): T {
  const v = d[k];
  if (v === undefined || !check(v)) throw new NormalizeError(`campo ${k} ausente ou não é ${type}`);
  return v;
}
const str = (d: { [k: string]: Decoded }, k: string) =>
  field(d, k, (v): v is string => typeof v === 'string', 'string');
const big = (d: { [k: string]: Decoded }, k: string) =>
  field(d, k, (v): v is bigint => typeof v === 'bigint', 'bigint');
const bool = (d: { [k: string]: Decoded }, k: string) =>
  field(d, k, (v): v is boolean => typeof v === 'boolean', 'bool');

interface Ctx {
  slot: bigint;
  sig: string;
  receivedAtMs: number;
  recvSeq: number;
}

function base(ev: ParsedProgramEvent, ctx: Ctx) {
  return {
    slot: ctx.slot,
    sig: ctx.sig,
    ts: Number(big(ev.data, 'timestamp')) * 1000,
    eventIndex: ev.eventIndex,
    receivedAtMs: ctx.receivedAtMs,
    recvSeq: ctx.recvSeq,
    rawB64: ev.rawB64,
  };
}

export interface NormalizeResult {
  events: PumpEvent[];
  gaps: IngestGap[];
}

/**
 * Converte eventos decodificados em `PumpEvent`. Mantém um cache pool → (base, quote)
 * alimentado por CreatePoolEvent e, para pools criadas antes da gravação, pelo resolver on-chain.
 */
export class Normalizer {
  private readonly pools = new Map<string, PoolInfo>();
  private readonly notPools = new Set<string>();
  private readonly retry = new Map<string, { atMs: number; attempts: number }>();
  private readonly pending = new Map<string, Promise<LookupOutcome>>();
  private readonly resolvePool: PoolResolver;

  constructor(resolvePool: PoolResolver, knownPools?: Iterable<[string, PoolInfo]>) {
    this.resolvePool = resolvePool;
    for (const [pool, info] of knownPools ?? []) this.pools.set(pool, info);
  }

  async normalize(parsed: ParsedLogs, receivedAtMs: number, recvSeq: number): Promise<NormalizeResult> {
    const ctx: Ctx = { slot: parsed.slot, sig: parsed.signature, receivedAtMs, recvSeq };
    const out: NormalizeResult = { events: [], gaps: [] };
    const gap = (kind: IngestGap['kind'], program: string | null, detail: string): void => {
      out.gaps.push({ kind, detectedAtMs: receivedAtMs, fromSlot: parsed.slot, toSlot: parsed.slot, sig: parsed.signature, program, detail });
    };

    if (parsed.truncated) gap('log_truncated', null, 'log da transação truncado; eventos posteriores perdidos');
    for (const p of parsed.problems) gap(p.kind, p.program, `${p.detail} raw=${p.rawB64.slice(0, 120)}`);

    // CreatePoolEvent primeiro: uma mesma transação pode criar a pool e negociar nela.
    const ordered = [...parsed.events].sort((a, b) => Number(b.name === 'CreatePoolEvent') - Number(a.name === 'CreatePoolEvent'));
    for (const ev of ordered) {
      if (ev.trailingBytes > 0) gap('trailing_bytes', ev.program, `${ev.name}: ${String(ev.trailingBytes)} bytes além do IDL`);
      try {
        const { event, poolFailure } = await this.toEvent(ev, ctx);
        if (poolFailure) gap('pool_unresolved', ev.program, poolFailure);
        if (event) out.events.push(event);
      } catch (err) {
        if (!(err instanceof NormalizeError)) throw err;
        gap('parse_error', ev.program, `${ev.name}: ${err.message}`);
      }
    }
    out.events.sort((a, b) => ('eventIndex' in a && 'eventIndex' in b ? a.eventIndex - b.eventIndex : 0));
    return out;
  }

  private async toEvent(ev: ParsedProgramEvent, ctx: Ctx): Promise<{ event: PumpEvent | null; poolFailure?: string }> {
    if (ev.name === 'BuyEvent' || ev.name === 'SellEvent') return this.swapTrade(ev, ctx);
    return { event: this.simpleEvent(ev, ctx) };
  }

  private simpleEvent(ev: ParsedProgramEvent, ctx: Ctx): PumpEvent | null {
    const d = ev.data;
    switch (ev.name) {
      case 'CreateEvent':
        return {
          kind: 'token_created',
          ...base(ev, ctx),
          mint: str(d, 'mint'),
          creator: str(d, 'creator'),
          name: str(d, 'name'),
          symbol: str(d, 'symbol'),
          uri: str(d, 'uri'),
          bondingCurve: str(d, 'bonding_curve'),
          quoteMint: str(d, 'quote_mint'),
          tokenTotalSupply: big(d, 'token_total_supply'),
        };
      case 'TradeEvent':
        return {
          kind: 'trade',
          venue: 'curve',
          ...base(ev, ctx),
          mint: str(d, 'mint'),
          trader: str(d, 'user'),
          side: bool(d, 'is_buy') ? 'buy' : 'sell',
          quoteMint: str(d, 'quote_mint'),
          quoteAmount: big(d, 'quote_amount'),
          tokenAmount: big(d, 'token_amount'),
          virtualQuoteReserves: big(d, 'virtual_quote_reserves'),
          virtualTokenReserves: big(d, 'virtual_token_reserves'),
          realQuoteReserves: big(d, 'real_quote_reserves'),
          realTokenReserves: big(d, 'real_token_reserves'),
          protocolFee: big(d, 'fee'),
          creatorFee: big(d, 'creator_fee'),
          ixName: str(d, 'ix_name'),
        };
      case 'CompleteEvent':
        return { kind: 'curve_completed', ...base(ev, ctx), mint: str(d, 'mint'), bondingCurve: str(d, 'bonding_curve') };
      case 'CreatePoolEvent': {
        const pool = str(d, 'pool');
        const info = { baseMint: str(d, 'base_mint'), quoteMint: str(d, 'quote_mint') };
        this.pools.set(pool, info);
        return { kind: 'pool_created', ...base(ev, ctx), pool, mint: info.baseMint, quoteMint: info.quoteMint, creator: str(d, 'creator') };
      }
      default:
        return null;
    }
  }

  private async swapTrade(ev: ParsedProgramEvent, ctx: Ctx): Promise<{ event: PumpSwapTradeEvent; poolFailure?: string }> {
    const d = ev.data;
    const pool = str(d, 'pool');
    const { info, failure } = await this.lookupPool(pool, ctx.receivedAtMs);
    const isBuy = ev.name === 'BuyEvent';
    const event: PumpSwapTradeEvent = {
      kind: 'trade',
      venue: 'pumpswap',
      ...base(ev, ctx),
      pool,
      mint: info?.baseMint ?? '',
      quoteMint: info?.quoteMint ?? '',
      trader: str(d, 'user'),
      side: isBuy ? 'buy' : 'sell',
      tokenAmount: big(d, isBuy ? 'base_amount_out' : 'base_amount_in'),
      quoteAmount: big(d, isBuy ? 'quote_amount_in' : 'quote_amount_out'),
      userQuoteAmount: big(d, isBuy ? 'user_quote_amount_in' : 'user_quote_amount_out'),
      poolBaseReserves: big(d, 'pool_base_token_reserves'),
      poolQuoteReserves: big(d, 'pool_quote_token_reserves'),
      lpFee: big(d, 'lp_fee'),
      protocolFee: big(d, 'protocol_fee'),
      creatorFee: big(d, 'coin_creator_fee'),
      // só o BuyEvent traz ix_name (buy / buy_exact_quote_in); o SellEvent não tem esse campo no IDL
      ixName: isBuy ? str(d, 'ix_name') : null,
    };
    return failure ? { event, poolFailure: failure } : { event };
  }

  private async lookupPool(pool: string, nowMs: number): Promise<LookupOutcome> {
    const cached = this.pools.get(pool);
    if (cached) return { info: cached };
    if (this.notPools.has(pool)) return { info: null };
    const inFlight = this.pending.get(pool);
    if (inFlight) return { info: (await inFlight).info };
    const r = this.retry.get(pool);
    if (r && nowMs < r.atMs) return { info: null };

    const attempt = this.resolvePool(pool).then(
      (res): LookupOutcome => {
        this.retry.delete(pool);
        if (res === 'not_pool') {
          this.notPools.add(pool);
          return { info: null, failure: `pool=${pool}: conta não é uma Pool do PumpSwap` };
        }
        this.pools.set(pool, res);
        return { info: res };
      },
      (e: unknown): LookupOutcome => {
        const attempts = (r?.attempts ?? 0) + 1;
        const waitMs = poolRetryDelayMs(attempts);
        this.retry.set(pool, { atMs: nowMs + waitMs, attempts });
        return { info: null, failure: `pool=${pool}: tentativa ${String(attempts)} falhou (${e instanceof Error ? e.message : String(e)}); nova tentativa em ${String(waitMs)} ms` };
      },
    );
    this.pending.set(pool, attempt);
    try {
      return await attempt;
    } finally {
      this.pending.delete(pool);
    }
  }
}
