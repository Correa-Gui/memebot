import type { EventSource, IngestGap, Logger, PumpEvent, SocialEvent } from '@memebot/core';
import { PROTOCOL_PROGRAM_IDS } from '../../../config/protocol.ts';
import { parseLogs, type LogsNotification } from './log-parser.ts';
import { Normalizer, type PoolCacheStats, type PoolInfo, type PoolResolver } from './normalize.ts';
import type { TxCostSampler } from './onchain.ts';
import { WsLogsSource, type WsLogsSourceOptions } from './ws-source.ts';

export interface IngestServiceOptions {
  wsUrl: string;
  resolvePool: PoolResolver;
  knownPools?: Iterable<[string, PoolInfo]>;
  /** Resoluções de pool simultâneas (RPC) permitidas; o resto espera na fila. Padrão: 4. */
  poolResolveConcurrency?: number;
  sampler?: TxCostSampler;
  onGap: (g: IngestGap) => void;
  logger: Logger;
  now?: () => number;
  createSocket?: WsLogsSourceOptions['createSocket'];
}

export interface IngestStats {
  notifications: number;
  failedTxSkipped: number;
  events: number;
  gaps: number;
  /** Trades gravados com pool ainda não resolvida (normal sob carga; não é um IngestGap). */
  unresolvedPools: number;
  costSamples: number;
}

/** EventSource ao vivo via WebSocket: logsSubscribe → parseLogs → Normalizer (+ amostragem de custos). */
export class IngestService implements EventSource {
  readonly stats: IngestStats = { notifications: 0, failedTxSkipped: 0, events: 0, gaps: 0, unresolvedPools: 0, costSamples: 0 };
  private readonly o: IngestServiceOptions;
  private readonly normalizer: Normalizer;
  private readonly now: () => number;
  private source: WsLogsSource | null = null;
  private recvSeq = 0;
  private inFlight = new Set<Promise<void>>();

  constructor(opts: IngestServiceOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
    this.normalizer = new Normalizer(opts.resolvePool, opts.knownPools, {
      ...(opts.poolResolveConcurrency !== undefined ? { concurrency: opts.poolResolveConcurrency } : {}),
      now: this.now,
    });
    this.normalizer.setOnResolveFailure((_pool, detail) => {
      this.stats.gaps++;
      this.o.onGap({ kind: 'pool_resolve_failed', detectedAtMs: this.now(), fromSlot: null, toSlot: null, sig: null, program: null, detail });
    });
  }

  /** Reconsidera pools pendentes cujo backoff expirou. Chamar periodicamente (ex.: junto do log por minuto). */
  retryPendingPools(): void {
    this.normalizer.retryPendingPools();
  }

  poolCacheStats(): PoolCacheStats {
    return this.normalizer.poolCacheStats();
  }

  start(onEvent: (e: PumpEvent | SocialEvent) => void): Promise<void> {
    const gap = (g: IngestGap): void => {
      this.stats.gaps++;
      this.o.onGap(g);
    };
    this.source = new WsLogsSource({
      wsUrl: this.o.wsUrl,
      programs: PROTOCOL_PROGRAM_IDS,
      onGap: gap,
      onStatus: (status, detail) => {
        this.o.logger[status === 'connected' ? 'info' : 'warn']({ status, detail }, 'websocket');
      },
      onNotification: (n, receivedAtMs) => {
        this.track(this.handle(n, receivedAtMs, onEvent, gap));
      },
      now: this.now,
      ...(this.o.createSocket ? { createSocket: this.o.createSocket } : {}),
    });
    this.source.start();
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.source?.stop();
    this.source = null;
    await Promise.allSettled([...this.inFlight]);
  }

  private track(p: Promise<void>): void {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  private async handle(
    n: LogsNotification,
    receivedAtMs: number,
    onEvent: (e: PumpEvent) => void,
    gap: (g: IngestGap) => void,
  ): Promise<void> {
    this.stats.notifications++;
    const recvSeq = this.recvSeq++;
    const parsed = parseLogs(n);
    if (parsed.failed) {
      this.stats.failedTxSkipped++;
      return;
    }
    const { events, gaps } = await this.normalizer.normalize(parsed, receivedAtMs, recvSeq);
    gaps.forEach(gap);
    for (const e of events) {
      this.stats.events++;
      if (e.kind === 'trade' && e.venue === 'pumpswap' && e.poolUnresolved) this.stats.unresolvedPools++;
      onEvent(e);
    }
    const sampler = this.o.sampler;
    if (events.length === 0 || !sampler?.shouldSample()) return;
    // `sample` nunca lança: sucesso/não encontrada/falha ficam em `sampler.stats` (log por minuto).
    const cost = await sampler.sample(n.signature);
    if (cost) {
      this.stats.costSamples++;
      onEvent(cost);
    }
  }
}
