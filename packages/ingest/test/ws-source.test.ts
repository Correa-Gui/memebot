import type { IngestGap } from '@memebot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogsNotification } from '../src/log-parser.ts';
import { WsLogsSource, type SocketLike } from '../src/ws-source.ts';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  notify(slot: number, signature: string): void {
    this.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: { subscription: 1, result: { context: { slot }, value: { signature, err: null, logs: ['x'] } } },
      }),
    });
  }
}

describe('WsLogsSource', () => {
  let sockets: FakeSocket[];
  let notes: LogsNotification[];
  let gaps: IngestGap[];
  let source: WsLogsSource;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    notes = [];
    gaps = [];
    source = new WsLogsSource({
      wsUrl: 'wss://example.invalid',
      programs: ['ProgA', 'ProgB'],
      onNotification: (n) => notes.push(n),
      onGap: (g) => gaps.push(g),
      heartbeatTimeoutMs: 1_000,
      initialBackoffMs: 100,
      maxBackoffMs: 400,
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    source.start();
    sockets[0]?.onopen?.();
  });

  afterEach(() => {
    source.stop();
    vi.useRealTimers();
  });

  it('assina os dois programas com commitment confirmed', () => {
    const subs = (sockets[0]?.sent ?? []).map((s) => JSON.parse(s) as { method: string; params: unknown[] });
    expect(subs.map((s) => s.method)).toEqual(['logsSubscribe', 'logsSubscribe']);
    expect(subs[0]?.params).toEqual([{ mentions: ['ProgA'] }, { commitment: 'confirmed' }]);
  });

  it('deduplica transação que chega pelas duas assinaturas', () => {
    sockets[0]?.notify(10, 'sigA');
    sockets[0]?.notify(10, 'sigA');
    sockets[0]?.notify(11, 'sigB');
    expect(notes.map((n) => n.signature)).toEqual(['sigA', 'sigB']);
    expect(notes[0]?.slot).toBe(10n);
  });

  it('heartbeat derruba conexão silenciosa, reconecta e registra o gap de slots', () => {
    sockets[0]?.notify(100, 's1');
    vi.advanceTimersByTime(1_000);
    expect(sockets[0]?.closed).toBe(true);
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    sockets[1]?.onopen?.();
    sockets[1]?.notify(250, 's2');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: 'reconnect', fromSlot: 100n, toSlot: 250n });
    expect(notes.map((n) => n.signature)).toEqual(['s1', 's2']);
  });

  it('conexão que nunca abre é derrubada pelo heartbeat e reconectada', () => {
    sockets[0]?.onclose?.();
    vi.advanceTimersByTime(100); // socket[1] criado, nunca chama onopen
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1_000); // heartbeat
    expect(sockets[1]?.closed).toBe(true);
    vi.advanceTimersByTime(200); // backoff dobrado
    expect(sockets).toHaveLength(3);
  });

  it('backoff cresce até o máximo enquanto a reconexão falha', () => {
    sockets[0]?.onclose?.();
    vi.advanceTimersByTime(100);
    sockets[1]?.onclose?.();
    vi.advanceTimersByTime(199);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });
});
