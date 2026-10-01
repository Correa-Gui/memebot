import { describe, expect, it, vi } from 'vitest';
import { LAMPORTS_PER_SIGNATURE, TxCostSampler, txCostFrom } from '../src/onchain.ts';
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
