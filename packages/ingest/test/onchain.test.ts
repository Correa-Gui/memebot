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
    const s = new TxCostSampler(new RpcClient('http://x'), 2, () => t);
    expect([s.shouldSample(), s.shouldSample(), s.shouldSample()]).toEqual([true, true, false]);
    t = 1_000;
    expect(s.shouldSample()).toBe(true);
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
