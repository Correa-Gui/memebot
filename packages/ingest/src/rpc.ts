import { z } from 'zod';

export class RpcError extends Error {
  override name = 'RpcError';
  readonly code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

export interface RpcClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const Envelope = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

/** Cliente JSON-RPC HTTP mínimo: timeout, retry com backoff limitado e validação zod da resposta. */
export class RpcClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(url: string, opts: RpcClientOptions = {}) {
    this.url = url;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 250;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call<T>(method: string, params: unknown[], schema: z.ZodType<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.baseBackoffMs * 2 ** (attempt - 1));
      try {
        const res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new RpcError(`${method}: HTTP ${String(res.status)}`, res.status);
          continue;
        }
        if (!res.ok) throw new RpcError(`${method}: HTTP ${String(res.status)}`, res.status);
        const env = Envelope.parse(await res.json());
        if (env.error) throw new RpcError(`${method}: ${env.error.message}`, env.error.code);
        const parsed = schema.safeParse(env.result);
        if (!parsed.success) throw new RpcError(`${method}: resposta inesperada: ${parsed.error.message}`, null);
        return parsed.data;
      } catch (e) {
        // erros JSON-RPC e de formato não se resolvem repetindo; rede/timeout sim
        if (e instanceof RpcError) throw e;
        lastError = e;
      }
    }
    throw new RpcError(`${method}: falhou após ${String(this.maxRetries + 1)} tentativas: ${String(lastError)}`, null);
  }
}

const SafeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const AccountInfoResult = z.object({
  value: z
    .object({
      owner: z.string(),
      data: z.tuple([z.string(), z.literal('base64')]),
    })
    .nullable(),
});

export const TransactionResult = z
  .object({
    slot: SafeInt,
    transaction: z.object({
      signatures: z.array(z.string()),
      message: z.object({ accountKeys: z.array(z.string()) }),
    }),
    meta: z.object({
      err: z.unknown(),
      fee: SafeInt,
      preBalances: z.array(SafeInt),
      postBalances: z.array(SafeInt),
      computeUnitsConsumed: SafeInt.optional(),
      loadedAddresses: z.object({ writable: z.array(z.string()), readonly: z.array(z.string()) }).optional(),
    }),
  })
  .nullable();

export type TransactionResult = z.infer<typeof TransactionResult>;
