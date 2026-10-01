import { describe, expect, it } from 'vitest';
import { AccountInfoResult, RpcClient } from '../src/rpc.ts';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe('RpcClient.stats', () => {
  it('conta chamadas lógicas, cada requisição HTTP (tentativas) e cada resposta 429', async () => {
    let n = 0;
    const fetchFn = (() => {
      n++;
      return Promise.resolve(new Response(JSON.stringify({ status: 429 }), { status: 429 }));
    }) as typeof fetch;
    const rpc = new RpcClient('http://x', { fetchFn, maxRetries: 2, baseBackoffMs: 0 });
    await expect(rpc.call('getAccountInfo', [], AccountInfoResult)).rejects.toThrow();
    expect(n).toBe(3); // 1 tentativa inicial + 2 retries, todas 429
    expect(rpc.stats).toEqual({ calls: 1, requests: 3, rateLimited: 3 });
  });

  it('sucesso não conta como rateLimited; duas chamadas somam em calls', async () => {
    const rpc = new RpcClient('http://x', { fetchFn: fakeFetch(200, { result: { value: null } }) });
    await rpc.call('getAccountInfo', [], AccountInfoResult);
    await rpc.call('getAccountInfo', [], AccountInfoResult);
    expect(rpc.stats).toEqual({ calls: 2, requests: 2, rateLimited: 0 });
  });
});
