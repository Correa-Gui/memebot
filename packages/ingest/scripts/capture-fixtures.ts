/**
 * Grava transações reais da mainnet como fixtures de teste (test/fixtures/*.json).
 * Uso: node --experimental-strip-types packages/ingest/scripts/capture-fixtures.ts [RPC_URL]
 * Só dados públicos. Rode de novo quando o IDL mudar e revise o diff das fixtures.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUMP_FUN_GLOBAL_PDA, PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID } from '../../../config/protocol.ts';
import { PUMP_AMM_IDL, PUMP_IDL } from '../src/idl.ts';

const RPC = process.argv[2] ?? 'https://api.mainnet-beta.solana.com';
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    await sleep(300);
    return body.result;
  }
  throw new Error(`${method}: rate limit`);
}

interface RawTx {
  slot: number;
  blockTime: number | null;
  version: unknown;
  transaction: { signatures: string[]; message: { accountKeys: string[] } };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    logMessages: string[] | null;
    computeUnitsConsumed?: number;
    loadedAddresses?: { writable: string[]; readonly: string[] };
  };
}

const getTx = async (sig: string) =>
  (await rpc('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])) as RawTx | null;

const getSigs = async (addr: string, limit: number) =>
  (await rpc('getSignaturesForAddress', [addr, { limit }])) as { signature: string; err: unknown }[];

function eventsIn(tx: RawTx): string[] {
  const out: string[] = [];
  for (const l of tx.meta.logMessages ?? []) {
    if (!l.startsWith('Program data: ')) continue;
    const bytes = Buffer.from(l.slice('Program data: '.length), 'base64');
    const name = PUMP_IDL.eventName(bytes) ?? PUMP_AMM_IDL.eventName(bytes);
    if (name) out.push(name);
  }
  return out;
}

/** Formato igual ao da notificação do logsSubscribe + campos de custo do getTransaction. */
function toFixture(label: string, tx: RawTx) {
  return {
    label,
    capturedAt: new Date().toISOString(),
    notification: {
      slot: tx.slot,
      signature: tx.transaction.signatures[0],
      err: tx.meta.err,
      logs: tx.meta.logMessages ?? [],
    },
    tx: {
      slot: tx.slot,
      blockTime: tx.blockTime,
      version: tx.version,
      signatures: tx.transaction.signatures,
      accountKeys: [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ],
      err: tx.meta.err,
      fee: tx.meta.fee,
      preBalances: tx.meta.preBalances,
      postBalances: tx.meta.postBalances,
      computeUnitsConsumed: tx.meta.computeUnitsConsumed ?? null,
    },
  };
}

const found = new Map<string, ReturnType<typeof toFixture>>();

async function scan(addr: string, limit: number, wanted: string[], includeFailed = false): Promise<void> {
  for (const s of await getSigs(addr, limit)) {
    if (wanted.every((w) => found.has(w))) return;
    const isFailed = s.err !== null;
    if (isFailed && !(includeFailed && !found.has('failed_tx'))) continue;
    const tx = await getTx(s.signature);
    if (!tx) continue;
    const evs = eventsIn(tx);
    if (isFailed) {
      if (tx.meta.logMessages?.some((l) => l.startsWith('Program data: '))) found.set('failed_tx', toFixture('failed_tx', tx));
      continue;
    }
    for (const w of wanted) if (!found.has(w) && evs.includes(w)) found.set(w, toFixture(w, tx));
  }
}

// 1. migração: withdraw_authority vem da conta Global
const acc = (await rpc('getAccountInfo', [PUMP_FUN_GLOBAL_PDA, { encoding: 'base64' }])) as { value: { data: [string, string] } };
const global = PUMP_IDL.decodeAccount('Global', Buffer.from(acc.value.data[0], 'base64'));
const withdrawAuthority = global['withdraw_authority'];
if (typeof withdrawAuthority !== 'string') throw new Error('withdraw_authority ausente');
console.log('withdraw_authority', withdrawAuthority);
await scan(withdrawAuthority, 15, ['CompletePumpAmmMigrationEvent', 'CreatePoolEvent']);

// 2. CompleteEvent: última compra na curva do mint migrado
const mig = found.get('CompletePumpAmmMigrationEvent');
if (mig) {
  for (const l of mig.notification.logs) {
    if (!l.startsWith('Program data: ')) continue;
    const ev = PUMP_IDL.decodeEvent(Buffer.from(l.slice(14), 'base64'));
    if (ev?.name === 'CompletePumpAmmMigrationEvent' && typeof ev.data['bonding_curve'] === 'string') {
      await scan(ev.data['bonding_curve'], 40, ['CompleteEvent']);
    }
  }
}

// 3. criação, trades na curva e no PumpSwap, tx com erro
await scan(PUMP_FUN_PROGRAM_ID, 200, ['CreateEvent', 'TradeEvent'], true);
await scan(PUMP_SWAP_PROGRAM_ID, 60, ['BuyEvent', 'SellEvent']);

for (const [label, fx] of found) {
  await writeFile(path.join(outDir, `${label}.json`), JSON.stringify(fx, null, 2) + '\n');
  console.log('gravado', label, fx.notification.signature);
}
console.log('faltando:', ['CompletePumpAmmMigrationEvent', 'CreatePoolEvent', 'CompleteEvent', 'CreateEvent', 'TradeEvent', 'BuyEvent', 'SellEvent', 'failed_tx'].filter((w) => !found.has(w)));
