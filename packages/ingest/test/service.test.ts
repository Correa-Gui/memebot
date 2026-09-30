import { createLogger, type IngestGap, type PumpEvent, type SocialEvent } from '@memebot/core';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { IngestService } from '../src/service.ts';
import type { SocketLike } from '../src/ws-source.ts';
import { loadFixture } from './fixtures.ts';

const silent = createLogger({
  destination: new Writable({
    write: (_c, _e, cb) => {
      cb();
    },
  }),
});

function socketFactory(): { sockets: SocketLike[]; create: (url: string) => SocketLike } {
  const sockets: SocketLike[] = [];
  return {
    sockets,
    create: () => {
      const s: SocketLike = { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };
      sockets.push(s);
      return s;
    },
  };
}

function deliver(s: SocketLike | undefined, fixture: string): void {
  const fx = loadFixture(fixture);
  s?.onmessage?.({
    data: JSON.stringify({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: {
        subscription: 1,
        result: { context: { slot: fx.notification.slot }, value: { signature: fx.notification.signature, err: null, logs: fx.notification.logs } },
      },
    }),
  });
}

describe('IngestService (ponta a ponta com socket falso e fixtures reais)', () => {
  it('criação, trade duplicado e migração viram os eventos certos, sem chamar o resolver', async () => {
    const f = socketFactory();
    const events: (PumpEvent | SocialEvent)[] = [];
    const gaps: IngestGap[] = [];
    let resolverCalls = 0;
    const svc = new IngestService({
      wsUrl: 'wss://example.invalid',
      resolvePool: () => {
        resolverCalls++;
        return Promise.resolve('not_pool' as const);
      },
      onGap: (g) => gaps.push(g),
      logger: silent,
      now: () => 5_000,
      createSocket: f.create,
    });
    await svc.start((e) => events.push(e));
    f.sockets[0]?.onopen?.();

    deliver(f.sockets[0], 'curve-create');
    deliver(f.sockets[0], 'curve-trade');
    deliver(f.sockets[0], 'curve-trade'); // duplicada (chega pelas duas assinaturas)
    deliver(f.sockets[0], 'migration');
    await svc.stop();

    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'token_created')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'pool_created')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'trade')).toHaveLength(2); // compra do criador + curve-trade (sem duplicar)
    expect(resolverCalls).toBe(0);
    expect(gaps).toEqual([]);
    expect(svc.stats).toMatchObject({ notifications: 3, failedTxSkipped: 0 });
  });
});
