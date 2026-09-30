import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogsNotification } from '../src/log-parser.ts';

export interface Fixture {
  label: string;
  notification: { slot: number; signature: string; err: unknown; logs: string[] };
  tx: {
    slot: number;
    blockTime: number | null;
    signatures: string[];
    accountKeys: string[];
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    computeUnitsConsumed: number | null;
  };
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')) as Fixture;
}

export function notificationOf(fx: Fixture): LogsNotification {
  return { ...fx.notification, slot: BigInt(fx.notification.slot) };
}

/** Variação de lamports de uma conta na transação (fonte independente do log de eventos). */
export function lamportDelta(fx: Fixture, account: string): bigint {
  const i = fx.tx.accountKeys.indexOf(account);
  const pre = fx.tx.preBalances[i];
  const post = fx.tx.postBalances[i];
  if (i < 0 || pre === undefined || post === undefined) throw new Error(`conta ${account} não está na transação`);
  return BigInt(post) - BigInt(pre);
}
