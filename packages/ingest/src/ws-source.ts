import type { IngestGap } from '@memebot/core';
import { z } from 'zod';
import type { LogsNotification } from './log-parser.ts';

/** Subconjunto da API WebSocket (WHATWG) usado aqui; permite injetar um fake nos testes. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WsLogsSourceOptions {
  wsUrl: string;
  programs: readonly string[];
  onNotification: (n: LogsNotification, receivedAtMs: number) => void;
  onGap: (g: IngestGap) => void;
  onStatus?: (status: 'connected' | 'disconnected', detail: string) => void;
  heartbeatTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Quantas assinaturas recentes lembrar para deduplicar (tx que menciona os dois programas chega duas vezes). */
  dedupWindow?: number;
  now?: () => number;
  createSocket?: (url: string) => SocketLike;
}

const SubscribeAck = z.object({ id: z.number(), result: z.number() });
const SubscribeError = z.object({ id: z.number(), error: z.object({ message: z.string() }) });
const Notification = z.object({
  method: z.literal('logsNotification'),
  params: z.object({
    subscription: z.number(),
    result: z.object({
      context: z.object({ slot: z.number().int().nonnegative() }),
      value: z.object({ signature: z.string(), err: z.unknown(), logs: z.array(z.string()).nullable() }),
    }),
  }),
});

/**
 * `logsSubscribe` (mentions) em cada programa, commitment `confirmed`, numa única conexão.
 * Reconecta com backoff exponencial; heartbeat por inatividade (o Pump.fun tem tráfego contínuo,
 * então silêncio prolongado = conexão morta). Cada reconexão registra o intervalo de slots perdido.
 */
export class WsLogsSource {
  private readonly o: Required<Omit<WsLogsSourceOptions, 'onStatus'>> & Pick<WsLogsSourceOptions, 'onStatus'>;
  private socket: SocketLike | null = null;
  private stopped = true;
  private backoffMs: number;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSlot: bigint | null = null;
  private disconnectedAt: number | null = null;
  private awaitingFirstSlotAfterReconnect = false;
  private readonly seen = new Set<string>();

  constructor(opts: WsLogsSourceOptions) {
    this.o = {
      heartbeatTimeoutMs: 30_000,
      initialBackoffMs: 500,
      maxBackoffMs: 30_000,
      dedupWindow: 50_000,
      now: Date.now,
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      ...opts,
    };
    this.backoffMs = this.o.initialBackoffMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    const socket = this.o.createSocket(this.o.wsUrl);
    this.socket = socket;
    // conexão que nunca abre também conta como silêncio: sem isso o processo esperaria para sempre
    this.armHeartbeat();
    socket.onopen = () => {
      this.o.programs.forEach((program, i) => {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [program] }, { commitment: 'confirmed' }] }));
      });
      // só o host: provedores põem a API key na query (Helius) ou no path (QuickNode)
      this.o.onStatus?.('connected', new URL(this.o.wsUrl).host);
      this.armHeartbeat();
    };
    socket.onmessage = (ev) => {
      this.armHeartbeat();
      if (typeof ev.data === 'string') this.handleMessage(ev.data);
    };
    socket.onerror = () => {
      // o onclose vem em seguida e cuida da reconexão
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.handleDisconnect('conexão fechada');
    };
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const n = Notification.safeParse(msg);
    if (n.success) {
      const { context, value } = n.data.params.result;
      const slot = BigInt(context.slot);
      if (this.awaitingFirstSlotAfterReconnect) {
        this.awaitingFirstSlotAfterReconnect = false;
        this.backoffMs = this.o.initialBackoffMs;
        this.o.onGap({
          kind: 'reconnect',
          detectedAtMs: this.o.now(),
          fromSlot: this.lastSlot,
          toSlot: slot,
          sig: null,
          program: null,
          detail: `desconectado por ${String(this.o.now() - (this.disconnectedAt ?? this.o.now()))} ms`,
        });
      }
      if (this.lastSlot === null || slot > this.lastSlot) this.lastSlot = slot;
      if (this.isDuplicate(value.signature)) return;
      this.o.onNotification({ slot, signature: value.signature, err: value.err, logs: value.logs ?? [] }, this.o.now());
      return;
    }
    const failed = SubscribeError.safeParse(msg);
    if (failed.success) {
      this.handleDisconnect(`logsSubscribe recusado: ${failed.data.error.message}`);
      return;
    }
    SubscribeAck.safeParse(msg);
  }

  private isDuplicate(sig: string): boolean {
    if (this.seen.has(sig)) return true;
    this.seen.add(sig);
    if (this.seen.size > this.o.dedupWindow) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  private handleDisconnect(reason: string): void {
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    s?.close();
    if (this.stopped) return;
    if (this.disconnectedAt === null || !this.awaitingFirstSlotAfterReconnect) this.disconnectedAt = this.o.now();
    this.awaitingFirstSlotAfterReconnect = true;
    this.o.onStatus?.('disconnected', `${reason}; reconectando em ${String(this.backoffMs)} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.o.maxBackoffMs);
  }

  private armHeartbeat(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => {
      this.handleDisconnect(`nenhuma mensagem em ${String(this.o.heartbeatTimeoutMs)} ms`);
    }, this.o.heartbeatTimeoutMs);
  }

  private clearTimers(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
  }
}
