import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@memebot/core';

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Chaves que podem conter segredo (API key em URL inclusive): ficam fora do hash e de qualquer log. */
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|BEARER|KEYPAIR|URL|ENDPOINT|CONFIRM/i;

export function publicConfig(cfg: AppConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(cfg)
      .filter(([k]) => !SECRET_KEY.test(k))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function configHash(cfg: AppConfig): string {
  return sha256(JSON.stringify(publicConfig(cfg)));
}

export function idlHash(): string {
  const idlDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'ingest', 'src', 'idl');
  return sha256(['pump.json', 'pump_amm.json', 'pump_fees.json'].map((f) => sha256(readFileSync(path.join(idlDir, f)))).join(''));
}

export function gitCommit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

export function newRunId(mode: string, nowMs: number): string {
  return `${mode}-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${sha256(String(Math.random())).slice(0, 6)}`;
}

/** Endpoints públicos conhecidos por não terem SLA e limitarem forte (429 frequente). */
const KNOWN_PUBLIC_RPC = /api\.mainnet-beta\.solana\.com|api\.devnet\.solana\.com|api\.testnet\.solana\.com/;

/**
 * Classifica a qualidade de uma run pelo RPC usado. Heurística simples (nome do host), documentada
 * em ARCHITECTURE §6: qualquer coisa que não seja reconhecidamente pública é tratada como produção —
 * então um RPC pago mal configurado não é pego por isto; é o operador quem garante isso ao contratar.
 */
export function runQuality(rpcUrl: string): 'provisional' | 'production' {
  return KNOWN_PUBLIC_RPC.test(rpcUrl) ? 'provisional' : 'production';
}
