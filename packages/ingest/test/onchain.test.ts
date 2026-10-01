import { describe, expect, it, vi } from 'vitest';
import {
  LAMPORTS_PER_SIGNATURE,
  OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS,
  PUMP_TOKEN_ACCOUNT_SIZE,
  TxCostSampler,
  fetchTokenAccountRent,
  txCostFrom,
} from '../src/onchain.ts';
import { RpcClient, RpcError, type TransactionResult } from '../src/rpc.ts';
import { loadFixture } from './fixtures.ts';

function txOf(name: string): NonNullable<TransactionResult> {
  const fx = loadFixture(name);
  return {
    slot: fx.tx.slot,
    transaction: { signatures: fx.tx.signatures, message: { accountKeys: fx.tx.accountKeys } },
    meta: { err: fx.tx.err, fee: fx.tx.fee, preBalances: fx.tx.preBalances, postBalances: fx.tx.postBalances },
  };
}

describe('txCostFrom', () => {
  it('priority fee = fee total − 5000 × assinaturas', () => {
    const tx = txOf('curve-trade');
    const cost = txCostFrom(tx, new Set());
    expect(cost.priorityFee).toBe(BigInt(tx.meta.fee) - LAMPORTS_PER_SIGNATURE * BigInt(tx.transaction.signatures.length));
    expect(cost.jitoTip).toBeNull();
  });

  it('tip = soma das entradas de lamports nas contas de tip', () => {
    const tx = txOf('curve-trade');
    const i = tx.meta.postBalances.findIndex((post, k) => post > (tx.meta.preBalances[k] ?? 0));
    const account = tx.transaction.message.accountKeys[i] ?? '';
    const expected = BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0);
    expect(txCostFrom(tx, new Set([account])).jitoTip).toBe(expected);
    expect(txCostFrom(tx, new Set(['NaoEstaNaTx'])).jitoTip).toBe(0n);
  });
});

describe('TxCostSampler', () => {
  it('respeita o limite por segundo', () => {
    let t = 0;
    const s = new TxCostSampler(new RpcClient('http://x'), 2, { now: () => t });
    expect([s.shouldSample(), s.shouldSample(), s.shouldSample()]).toEqual([true, true, false]);
    t = 1_000;
    expect(s.shouldSample()).toBe(true);
  });

  it('aceita taxa fracionária: 0,2/s = uma amostra a cada 5 s, sem rajada depois de ócio', () => {
    let t = 0;
    const s = new TxCostSampler(new RpcClient('http://x'), 0.2, { now: () => t });
    expect(s.shouldSample()).toBe(true);
    expect(s.shouldSample()).toBe(false);
    t = 4_999;
    expect(s.shouldSample()).toBe(false);
    t = 5_000;
    expect(s.shouldSample()).toBe(true);
    t = 600_000; // 10 min ocioso: no máximo 1 ficha acumulada
    expect([s.shouldSample(), s.shouldSample()]).toEqual([true, false]);
  });

  const rpcReturning = (...results: unknown[]): RpcClient => {
    const fetchFn = vi.fn();
    for (const r of results) {
      fetchFn.mockResolvedValueOnce(
        r === 429 ? new Response('', { status: 429 }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: r }), { status: 200 }),
      );
    }
    return new RpcClient('http://x', { fetchFn, maxRetries: 0, sleep: () => Promise.resolve() });
  };
  const noSleep = { sleep: () => Promise.resolve(), initialDelayMs: 0, notFoundRetryDelaysMs: [10, 20] };

  it('tx ainda não indexada (null) é tentada de novo e, se aparecer, vira amostra', async () => {
    const s = new TxCostSampler(rpcReturning(null, null, txOf('curve-trade')), 2, noSleep);
    const cost = await s.sample('sig');
    expect(cost?.kind).toBe('tx_cost');
    expect(s.stats).toMatchObject({ attempted: 1, sampled: 1, notFound: 0, failed: 0 });
  });

  it('null em todas as tentativas é contado como notFound (nunca descartado em silêncio)', async () => {
    const s = new TxCostSampler(rpcReturning(null, null, null), 2, noSleep);
    expect(await s.sample('sig')).toBeNull();
    expect(s.stats).toMatchObject({ attempted: 1, sampled: 0, notFound: 1, failed: 0 });
  });

  it('429 é contado como falha, guarda o erro e não lança', async () => {
    const s = new TxCostSampler(rpcReturning(429), 2, noSleep);
    expect(await s.sample('sig')).toBeNull();
    expect(s.stats.failed).toBe(1);
    expect(s.stats.lastError).toMatch(/429/);
    expect(s.rateLimited).toBe(1);
  });
});

describe('RpcClient', () => {
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });

  it('repete em 429 com backoff e depois sucede', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(ok(42));
    const sleep = vi.fn(() => Promise.resolve());
    const rpc = new RpcClient('http://x', { fetchFn, sleep });
    const { z } = await import('zod');
    await expect(rpc.call('getSlot', [], z.number())).resolves.toBe(42);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('não repete erro JSON-RPC e desiste após o limite de tentativas', async () => {
    const { z } = await import('zod');
    const rpcErr = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } })));
    await expect(new RpcClient('http://x', { fetchFn: rpcErr, sleep: () => Promise.resolve() }).call('m', [], z.number())).rejects.toBeInstanceOf(RpcError);
    expect(rpcErr).toHaveBeenCalledTimes(1);

    const down = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(new RpcClient('http://x', { fetchFn: down, maxRetries: 2, sleep: () => Promise.resolve() }).call('m', [], z.number())).rejects.toThrow(/3 tentativas/);
    expect(down).toHaveBeenCalledTimes(3);
  });
});

describe('rent da conta de token (Token-2022, 170 bytes)', () => {
  it('o tamanho vem do GetAccountDataSize gravado e o rent observado bate com o saldo das ATAs criadas', () => {
    const fx = loadFixture('curve-create');
    const ret = fx.notification.logs.find((l) => l.startsWith('Program return: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
    const b64 = ret?.split(' ').pop() ?? '';
    expect(Buffer.from(b64, 'base64').readBigUInt64LE(0)).toBe(BigInt(PUMP_TOKEN_ACCOUNT_SIZE));
    const created = fx.tx.postBalances.filter((post, i) => (fx.tx.preBalances[i] ?? -1) === 0 && post > 0);
    expect(created.filter((b) => BigInt(b) === OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS)).toHaveLength(2);
  });

  it('lê getMinimumBalanceForRentExemption(170) do RPC; falha → valor observado com a origem marcada', async () => {
    const bodies: string[] = [];
    const ok = new RpcClient('http://rpc', {
      fetchFn: (_url, init) => {
        bodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1_513_840 })));
      },
    });
    expect(await fetchTokenAccountRent(ok)).toEqual({ lamports: 1_513_840n, source: 'rpc', error: null });
    expect(JSON.parse(bodies[0] ?? '{}')).toMatchObject({ method: 'getMinimumBalanceForRentExemption', params: [170] });

    const down = new RpcClient('http://rpc', { maxRetries: 0, fetchFn: () => Promise.reject(new Error('offline')) });
    const r = await fetchTokenAccountRent(down);
    expect(r.source).toBe('observed_fixture');
    expect(r.lamports).toBe(OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS);
    expect(r.error).toMatch(/offline/);
  });
});
