import type { TxCostEvent } from '@memebot/core';
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
export function createPoolResolver(rpc: RpcClient): PoolResolver {
  return async (pool: string): Promise<PoolInfo | 'not_pool'> => {
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
export class TxCostSampler {
  private readonly rpc: RpcClient;
  private readonly perSecond: number;
  private readonly now: () => number;
  private windowStart = 0;
  private usedInWindow = 0;
  private tipAccounts: ReadonlySet<string> = new Set();

  constructor(rpc: RpcClient, perSecond: number, now: () => number = Date.now) {
    this.rpc = rpc;
    this.perSecond = perSecond;
    this.now = now;
  }

  setTipAccounts(accounts: Iterable<string>): void {
    this.tipAccounts = new Set(accounts);
  }

  /** true se a assinatura foi aceita para amostragem nesta janela de 1 s. */
  shouldSample(): boolean {
    if (this.perSecond <= 0) return false;
    const t = this.now();
    if (t - this.windowStart >= 1_000) {
      this.windowStart = t;
      this.usedInWindow = 0;
    }
    if (this.usedInWindow >= this.perSecond) return false;
    this.usedInWindow++;
    return true;
  }

  async sample(sig: string): Promise<TxCostEvent | null> {
    const tx = await this.rpc.call(
      'getTransaction',
      [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }],
      TransactionResult,
    );
    return tx ? txCostFrom(tx, this.tipAccounts) : null;
  }
}
