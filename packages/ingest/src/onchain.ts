import type { TxCostEvent } from '@memebot/core';
import type { RateLimiter } from './rate-limiter.ts';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { z } from 'zod';
import {
  PUMP_FEES_PROGRAM_ID,
  PUMP_FUN_GLOBAL_PDA,
  PUMP_FUN_PROGRAM_ID,
  PUMP_SWAP_GLOBAL_CONFIG_PDA,
  PUMP_SWAP_PROGRAM_ID,
} from '../../../config/protocol.ts';
import type { Decoded } from './borsh.ts';
import { PUMP_AMM_IDL, PUMP_FEES_IDL, PUMP_IDL, type ProgramIdl } from './idl.ts';
import type { PoolInfo, PoolResolver } from './normalize.ts';
import { AccountInfoResult, TransactionResult, type RpcClient } from './rpc.ts';

async function fetchAccount(rpc: RpcClient, addr: string): Promise<{ owner: string; bytes: Uint8Array } | null> {
  const res = await rpc.call('getAccountInfo', [addr, { encoding: 'base64', commitment: 'confirmed' }], AccountInfoResult);
  if (!res.value) return null;
  return { owner: res.value.owner, bytes: Buffer.from(res.value.data[0], 'base64') };
}

/**
 * Resolve base/quote de uma pool do PumpSwap lendo a conta Pool (confere o dono da conta).
 * Erro de RPC é propagado (transitório); conta inexistente/de outro programa → 'not_pool'.
 */
/**
 * `limiter` (opcional) espaça as consultas para caber no orçamento de RPC: há centenas de pools do
 * PumpSwap criadas antes da gravação, e sem limite o resolvedor gerava ~100 chamadas/min com 80% de
 * 429 no Helius free (medido em 2026-10-01). Quem chama deve usar um `RpcClient` sem retry imediato:
 * a falha cai no backoff exponencial por pool do `Normalizer`.
 */
export function createPoolResolver(rpc: RpcClient, limiter?: RateLimiter): PoolResolver {
  return async (pool: string): Promise<PoolInfo | 'not_pool'> => {
    await limiter?.acquire();
    const acc = await fetchAccount(rpc, pool);
    if (acc?.owner !== PUMP_SWAP_PROGRAM_ID) return 'not_pool';
    const d = PUMP_AMM_IDL.decodeAccount('Pool', acc.bytes);
    const baseMint = d['base_mint'];
    const quoteMint = d['quote_mint'];
    if (typeof baseMint !== 'string' || typeof quoteMint !== 'string') return 'not_pool';
    return { baseMint, quoteMint };
  };
}

export interface ProtocolConfigSnapshot {
  programId: string;
  account: string;
  accountType: string;
  /** JSON com bigint serializado como string. */
  configJson: string;
}

const toJson = (d: { [k: string]: Decoded }): string =>
  JSON.stringify(d, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

async function feeConfigPda(configProgram: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PUMP_FEES_PROGRAM_ID),
    seeds: [new TextEncoder().encode('fee_config'), getAddressEncoder().encode(address(configProgram))],
  });
  return pda;
}

/**
 * Lê as contas de configuração de taxas/curva (CLAUDE.md §7: nunca hardcodar taxas).
 * Pump Global, PumpSwap GlobalConfig e os FeeConfig (taxas por faixa) de cada programa.
 */
export async function readProtocolConfig(rpc: RpcClient): Promise<ProtocolConfigSnapshot[]> {
  const targets: { account: string; owner: string; idl: ProgramIdl; type: string; programId: string }[] = [
    { account: PUMP_FUN_GLOBAL_PDA, owner: PUMP_FUN_PROGRAM_ID, idl: PUMP_IDL, type: 'Global', programId: PUMP_FUN_PROGRAM_ID },
    { account: PUMP_SWAP_GLOBAL_CONFIG_PDA, owner: PUMP_SWAP_PROGRAM_ID, idl: PUMP_AMM_IDL, type: 'GlobalConfig', programId: PUMP_SWAP_PROGRAM_ID },
    { account: await feeConfigPda(PUMP_FUN_PROGRAM_ID), owner: PUMP_FEES_PROGRAM_ID, idl: PUMP_FEES_IDL, type: 'FeeConfig', programId: PUMP_FUN_PROGRAM_ID },
    { account: await feeConfigPda(PUMP_SWAP_PROGRAM_ID), owner: PUMP_FEES_PROGRAM_ID, idl: PUMP_FEES_IDL, type: 'FeeConfig', programId: PUMP_SWAP_PROGRAM_ID },
  ];
  const out: ProtocolConfigSnapshot[] = [];
  for (const t of targets) {
    const acc = await fetchAccount(rpc, t.account);
    if (!acc) throw new Error(`conta de configuração ${t.type} (${t.account}) não encontrada`);
    if (acc.owner !== t.owner) throw new Error(`conta ${t.account} tem dono inesperado ${acc.owner}`);
    out.push({ programId: t.programId, account: t.account, accountType: t.type, configJson: toJson(t.idl.decodeAccount(t.type, acc.bytes)) });
  }
  return out;
}

const TipAccounts = z.object({ result: z.array(z.string()).min(1) });

/** Contas de tip do Jito, lidas do block engine (não hardcodadas). */
export async function fetchJitoTipAccounts(blockEngineUrl: string, timeoutMs = 5_000): Promise<string[]> {
  const res = await fetch(`${blockEngineUrl.replace(/\/$/, '')}/api/v1/bundles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`getTipAccounts: HTTP ${String(res.status)}`);
  return TipAccounts.parse(await res.json()).result;
}

/**
 * Taxa base por assinatura em lamports. Constante do runtime da Solana (não do Pump.fun):
 * fee = 5000 × nº de assinaturas + priority fee (compute unit price × limite de CU).
 * Fonte: https://solana.com/docs/core/fees (conferido em 2026-09-29).
 */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * Tamanho em bytes da conta de token (ATA) que a compra cria para a carteira. O mint do Pump.fun é
 * do programa Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` nos logs de
 * `test/fixtures/curve-trade.json`) e a ATA leva a extensão ImmutableOwner: no `CreateIdempotent` da tx
 * real `test/fixtures/curve-create.json` (sig 4yS9qwbw…), `GetAccountDataSize` devolve
 * `qgAAAAAAAAA=` = 170 (u64 LE). Conferido em 2026-10-01.
 */
export const PUMP_TOKEN_ACCOUNT_SIZE = 170;

/**
 * Rent-exempt dessa conta observado on-chain: as duas ATAs Token-2022 criadas na tx real
 * `test/fixtures/curve-create.json` ficaram com exatamente 1 513 840 lamports (pré 0), igual a
 * `getMinimumBalanceForRentExemption(170)` na mainnet em 2026-10-01. Só é usado como FALLBACK
 * quando a leitura por RPC falha (ver `fetchTokenAccountRent`); o caminho normal lê do RPC.
 */
export const OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS = 1_513_840n;

const RentResult = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Rent-exempt atual da conta de token (`getMinimumBalanceForRentExemption(PUMP_TOKEN_ACCOUNT_SIZE)`),
 * lido do RPC (timeout/retry do `RpcClient`). Fallback (nunca trava a partida): o valor observado na
 * transação real gravada, marcado como `source: 'observed_fixture'` para o log.
 */
export async function fetchTokenAccountRent(
  rpc: RpcClient,
): Promise<{ lamports: bigint; source: 'rpc' | 'observed_fixture'; error: string | null }> {
  try {
    const value = await rpc.call('getMinimumBalanceForRentExemption', [PUMP_TOKEN_ACCOUNT_SIZE], RentResult);
    return { lamports: BigInt(value), source: 'rpc', error: null };
  } catch (e) {
    return { lamports: OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS, source: 'observed_fixture', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Extrai custos de uma transação. `tipAccounts` vazio → jitoTip null (desconhecido). */
export function txCostFrom(tx: NonNullable<TransactionResult>, tipAccounts: ReadonlySet<string>): TxCostEvent {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  let jitoTip: bigint | null = tipAccounts.size > 0 ? 0n : null;
  if (jitoTip !== null) {
    keys.forEach((k, i) => {
      if (!tipAccounts.has(k)) return;
      const delta = BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0);
      if (delta > 0n && jitoTip !== null) jitoTip += delta;
    });
  }
  const fee = BigInt(tx.meta.fee);
  const numSignatures = tx.transaction.signatures.length;
  const baseFee = LAMPORTS_PER_SIGNATURE * BigInt(numSignatures);
  return {
    kind: 'tx_cost',
    slot: BigInt(tx.slot),
    sig: tx.transaction.signatures[0] ?? '',
    feeLamports: fee,
    priorityFee: fee > baseFee ? fee - baseFee : 0n,
    jitoTip,
    computeUnits: tx.meta.computeUnitsConsumed ?? null,
    numSignatures,
  };
}

/**
 * Amostra custos de transação com limite de taxa (token bucket por segundo).
 * Amostragem em vez de toda transação: buscar cada uma custaria ~400 GB/dia de RPC (ver ARCHITECTURE §8).
 */
export interface TxCostSamplerStats {
  /** Assinaturas aceitas para amostragem (passaram pelo limite por segundo). */
  attempted: number;
  /** Amostras extraídas com sucesso (viram evento `tx_cost`). */
  sampled: number;
  /** `getTransaction` devolveu `null` em todas as tentativas (tx ainda não indexada no RPC). */
  notFound: number;
  /** Erro de RPC/rede (inclui 429 — ver `rpc.stats.rateLimited`). */
  failed: number;
  /** Última mensagem de erro vista (diagnóstico no log por minuto). */
  lastError: string | null;
}

export interface TxCostSamplerOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Esperas antes de cada nova tentativa quando `getTransaction` devolve `null`. Medido em
   * 2026-10-01: logo após a notificação `confirmed` do logsSubscribe a tx quase sempre ainda não está
   * disponível para `getTransaction` (o resultado era `null` e era descartado em silêncio — causa de
   * `tx_costs` ter ficado com 3 linhas em ~77 min de gravação).
   */
  notFoundRetryDelaysMs?: readonly number[];
  /** Espera antes da primeira tentativa (dá tempo de a tx ser indexada). */
  initialDelayMs?: number;
}

export class TxCostSampler {
  private readonly rpc: RpcClient;
  private readonly perSecond: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelays: readonly number[];
  private readonly initialDelayMs: number;
  private tokens: number | null = null;
  private lastRefill = 0;
  private tipAccounts: ReadonlySet<string> = new Set();
  readonly stats: TxCostSamplerStats = { attempted: 0, sampled: 0, notFound: 0, failed: 0, lastError: null };

  constructor(rpc: RpcClient, perSecond: number, opts: TxCostSamplerOptions = {}) {
    this.rpc = rpc;
    this.perSecond = perSecond;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retryDelays = opts.notFoundRetryDelaysMs ?? [2_000, 4_000];
    this.initialDelayMs = opts.initialDelayMs ?? 1_500;
  }

  get rateLimited(): number {
    return this.rpc.stats.rateLimited;
  }

  setTipAccounts(accounts: Iterable<string>): void {
    this.tipAccounts = new Set(accounts);
  }

  /** true se a assinatura foi aceita para amostragem nesta janela de 1 s. */
  /**
   * Token bucket: acumula `perSecond` fichas por segundo (aceita fração — 0,2 = uma amostra a cada
   * 5 s), com teto de `max(1, perSecond)` para não disparar rajadas depois de um período ocioso.
   */
  shouldSample(): boolean {
    if (this.perSecond <= 0) return false;
    const t = this.now();
    const capacity = Math.max(1, this.perSecond);
    if (this.tokens === null) {
      this.tokens = capacity;
    } else {
      this.tokens = Math.min(capacity, this.tokens + ((t - this.lastRefill) / 1_000) * this.perSecond);
    }
    this.lastRefill = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /**
   * Busca a tx e extrai os custos. Nunca descarta em silêncio: todo desfecho cai em `stats`
   * (`sampled` / `notFound` / `failed`). Erros não são relançados — a amostra é opcional e quem
   * chama não deve travar por ela; o diagnóstico vai para o log por minuto.
   */
  async sample(sig: string): Promise<TxCostEvent | null> {
    this.stats.attempted++;
    try {
      if (this.initialDelayMs > 0) await this.sleep(this.initialDelayMs);
      for (let attempt = 0; ; attempt++) {
        const tx = await this.rpc.call(
          'getTransaction',
          [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }],
          TransactionResult,
        );
        if (tx) {
          this.stats.sampled++;
          return txCostFrom(tx, this.tipAccounts);
        }
        const delay = this.retryDelays[attempt];
        if (delay === undefined) {
          this.stats.notFound++;
          return null;
        }
        await this.sleep(delay);
      }
    } catch (e) {
      this.stats.failed++;
      this.stats.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }
}
