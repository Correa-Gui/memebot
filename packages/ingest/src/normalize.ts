import type { IngestGap, PumpEvent, PumpSwapSwapDetails, PumpSwapTradeEvent } from '@memebot/core';
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

/**
 * Campos extras de um `BuyEvent`/`SellEvent` do PumpSwap (IDL `pump_amm.json`) usados pela
 * matemática exata do swap. Lança `NormalizeError` se faltar campo (layout diferente do IDL).
 * Devolve `null` para um `ix_name` desconhecido num BuyEvent (instrução nova do programa): o trade
 * continua sendo gravado, só sem os detalhes — não arriscamos rotular a variante errada.
 */
export function pumpSwapSwapDetails(eventName: string, d: { [k: string]: Decoded }): PumpSwapSwapDetails | null {
  let instruction: PumpSwapSwapDetails['instruction'];
  if (eventName === 'SellEvent') instruction = 'sell';
  else if (eventName === 'BuyEvent') {
    const ix = str(d, 'ix_name');
    if (ix !== 'buy' && ix !== 'buy_exact_quote_in') return null;
    instruction = ix;
  } else throw new NormalizeError(`${eventName} não é evento de swap do PumpSwap`);
  return {
    instruction,
    virtualQuoteReserves: big(d, 'virtual_quote_reserves'),
    lpFeeBps: big(d, 'lp_fee_basis_points'),
    protocolFeeBps: big(d, 'protocol_fee_basis_points'),
    creatorFeeBps: big(d, 'coin_creator_fee_basis_points'),
    cashbackFeeBps: big(d, 'cashback_fee_basis_points'),
    cashbackFee: big(d, 'cashback'),
    buybackFeeBps: big(d, 'buyback_fee_basis_points'),
    buybackFee: big(d, 'buyback_fee'),
    holderRewardsBps: big(d, 'holder_rewards_bps'),
    holderRewards: big(d, 'holder_rewards'),
    baseSupply: big(d, 'base_supply'),
  };
}

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

export interface PoolCacheStats {
  /** Pools com base/quote conhecidos (nunca reconsultadas por RPC). */
  cacheSize: number;
  /** Pools na fila ou sendo resolvidas agora. */
  pending: number;
  /** Contas conferidas e confirmadas como não sendo uma Pool do PumpSwap. */
  notPool: number;
}

/**
 * Roda no máximo `concurrency` resoluções de pool ao mesmo tempo; o resto espera na fila.
 * Isso é o que evita a tempestade de requisições vista com o RPC público (ver ROADMAP Fase 1).
 */
class ConcurrencyQueue {
  private readonly limit: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  push(task: () => Promise<void>): void {
    const run = (): void => {
      this.running++;
      task()
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.waiting.shift()?.();
        });
    };
    if (this.running < this.limit) run();
    else this.waiting.push(run);
  }
}

/**
 * Converte eventos decodificados em `PumpEvent`. Mantém um cache pool → (base, quote) permanente
 * em memória (nunca reconsulta uma pool já resolvida) alimentado por CreatePoolEvent e, para pools
 * criadas antes da gravação, por um resolver on-chain enfileirado com limite de concorrência.
 *
 * A busca é **não bloqueante**: se a pool ainda não está em cache, o trade é retornado com
 * `mint`/`quoteMint` vazios e `poolUnresolved: true` na hora, e a resolução roda em segundo plano.
 * Trades futuros na mesma pool (e a view `v_trades` no ClickHouse) enxergam o resultado assim que
 * ele chega — nada é reprocessado.
 */
export class Normalizer {
  private readonly pools = new Map<string, PoolInfo>();
  private readonly notPools = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly resolvePool: PoolResolver;
  private readonly queue: ConcurrencyQueue;
  private readonly now: () => number;
  private onResolveFailure: ((pool: string, detail: string) => void) | null = null;

  constructor(resolvePool: PoolResolver, knownPools?: Iterable<[string, PoolInfo]>, opts?: { concurrency?: number; now?: () => number }) {
    this.resolvePool = resolvePool;
    this.queue = new ConcurrencyQueue(opts?.concurrency ?? 4);
    this.now = opts?.now ?? Date.now;
    for (const [pool, info] of knownPools ?? []) this.pools.set(pool, info);
  }

  /** Chamado pelo serviço para receber os `pool_resolve_failed` (falha real de RPC, não pendência normal). */
  setOnResolveFailure(cb: (pool: string, detail: string) => void): void {
    this.onResolveFailure = cb;
  }

  poolCacheStats(): PoolCacheStats {
    return { cacheSize: this.pools.size, pending: this.queued.size, notPool: this.notPools.size };
  }

  /** Reconsidera pools pendentes cujo backoff já expirou (chamado periodicamente, não a cada trade). */
  retryPendingPools(): void {
    const nowMs = this.now();
    for (const [pool, at] of this.retryAt) {
      if (nowMs >= at && !this.queued.has(pool)) this.enqueue(pool);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async por design: nunca bloqueia em RPC (ver classe)
  async normalize(parsed: ParsedLogs, receivedAtMs: number, recvSeq: number): Promise<NormalizeResult> {
    const ctx: Ctx = { slot: parsed.slot, sig: parsed.signature, receivedAtMs, recvSeq };
    const out: NormalizeResult = { events: [], gaps: [] };
    const gap = (kind: IngestGap['kind'], program: string | null, detail: string): void => {
      out.gaps.push({ kind, detectedAtMs: receivedAtMs, fromSlot: parsed.slot, toSlot: parsed.slot, sig: parsed.signature, program, durationMs: null, detail });
    };

    if (parsed.truncated) gap('log_truncated', null, 'log da transação truncado; eventos posteriores perdidos');
    for (const p of parsed.problems) gap(p.kind, p.program, `${p.detail} raw=${p.rawB64.slice(0, 120)}`);

    // CreatePoolEvent primeiro: uma mesma transação pode criar a pool e negociar nela.
    const ordered = [...parsed.events].sort((a, b) => Number(b.name === 'CreatePoolEvent') - Number(a.name === 'CreatePoolEvent'));
    for (const ev of ordered) {
      if (ev.trailingBytes > 0) gap('trailing_bytes', ev.program, `${ev.name}: ${String(ev.trailingBytes)} bytes além do IDL`);
      try {
        const event = this.toEvent(ev, ctx);
        if (event) out.events.push(event);
      } catch (err) {
        if (!(err instanceof NormalizeError)) throw err;
        gap('parse_error', ev.program, `${ev.name}: ${err.message}`);
      }
    }
    out.events.sort((a, b) => ('eventIndex' in a && 'eventIndex' in b ? a.eventIndex - b.eventIndex : 0));
    return out;
  }

  private toEvent(ev: ParsedProgramEvent, ctx: Ctx): PumpEvent | null {
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
        this.notPools.delete(pool);
        return { kind: 'pool_created', ...base(ev, ctx), pool, mint: info.baseMint, quoteMint: info.quoteMint, creator: str(d, 'creator') };
      }
      case 'BuyEvent':
      case 'SellEvent':
        return this.swapTrade(ev, ctx);
      default:
        return null;
    }
  }

  private swapTrade(ev: ParsedProgramEvent, ctx: Ctx): PumpSwapTradeEvent {
    const d = ev.data;
    const pool = str(d, 'pool');
    const info = this.lookupPoolNonBlocking(pool);
    const isBuy = ev.name === 'BuyEvent';
    const details = pumpSwapSwapDetails(ev.name, d);
    return {
      kind: 'trade',
      venue: 'pumpswap',
      ...base(ev, ctx),
      pool,
      mint: info?.baseMint ?? '',
      quoteMint: info?.quoteMint ?? '',
      poolUnresolved: info === null,
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
      ...(details ? { swapDetails: details } : {}),
    };
  }

  /** Nunca espera rede: devolve o que já está em cache e dispara a resolução em segundo plano. */
  private lookupPoolNonBlocking(pool: string): PoolInfo | null {
    const cached = this.pools.get(pool);
    if (cached) return cached;
    if (this.notPools.has(pool)) return null;
    if (!this.queued.has(pool)) {
      const retryAt = this.retryAt.get(pool);
      if (retryAt === undefined || this.now() >= retryAt) this.enqueue(pool);
    }
    return null;
  }

  private enqueue(pool: string): void {
    this.queued.add(pool);
    this.queue.push(() => this.resolveOnce(pool));
  }

  private async resolveOnce(pool: string): Promise<void> {
    try {
      const res = await this.resolvePool(pool);
      this.retryAt.delete(pool);
      this.retryAttempts.delete(pool);
      if (res === 'not_pool') this.notPools.add(pool);
      else this.pools.set(pool, res);
    } catch (e) {
      const attempts = (this.retryAttempts.get(pool) ?? 0) + 1;
      this.retryAttempts.set(pool, attempts);
      const waitMs = poolRetryDelayMs(attempts);
      this.retryAt.set(pool, this.now() + waitMs);
      this.onResolveFailure?.(pool, `pool=${pool}: tentativa ${String(attempts)} falhou (${e instanceof Error ? e.message : String(e)}); próxima em ${String(waitMs)} ms`);
    } finally {
      this.queued.delete(pool);
    }
  }
}
