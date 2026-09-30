import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

/**
 * Busca do JSON de metadados do token (campo `uri` do CreateEvent).
 * A URI é escolhida por quem cria o token, então é entrada hostil: protegemos contra SSRF
 * (ex.: uri apontando para o ClickHouse em 127.0.0.1). Regras: só https (ipfs:// via gateway),
 * cada IP resolvido é checado contra faixas privadas DENTRO do lookup do socket (evita DNS rebinding),
 * sem seguir redirects, limite de tamanho e timeout.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) return blocked.check(ip, 'ipv6');
  return true;
}

export class MetadataFetchError extends Error {
  override name = 'MetadataFetchError';
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad || addresses.length === 0) {
      callback(new MetadataFetchError(`host ${hostname} resolve para endereço bloqueado (${bad?.address ?? 'nenhum'})`), '', 0);
      return;
    }
    if (options.all) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      return;
    }
    const first = addresses[0];
    callback(null, first?.address ?? '', first?.family ?? 4);
  });
};

export function resolveMetadataUrl(uri: string, ipfsGateway: string): URL {
  const trimmed = uri.trim();
  const url = trimmed.startsWith('ipfs://')
    ? new URL(trimmed.slice('ipfs://'.length).replace(/^ipfs\//, ''), ipfsGateway.endsWith('/') ? ipfsGateway : `${ipfsGateway}/`)
    : new URL(trimmed);
  if (url.protocol !== 'https:') throw new MetadataFetchError(`protocolo não permitido: ${url.protocol}`);
  if (url.username || url.password) throw new MetadataFetchError('credenciais na URL não são permitidas');
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new MetadataFetchError(`IP bloqueado: ${url.hostname}`);
  }
  return url;
}

const MetadataJson = z
  .object({
    name: z.string().optional(),
    symbol: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    twitter: z.string().optional(),
    telegram: z.string().optional(),
    website: z.string().optional(),
  })
  .passthrough();

export interface TokenMetadata {
  description: string | null;
  image: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  rawJson: string;
}

export interface FetchMetadataOptions {
  ipfsGateway: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export function fetchTokenMetadata(uri: string, opts: FetchMetadataOptions): Promise<TokenMetadata> {
  const url = resolveMetadataUrl(uri, opts.ipfsGateway);
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;

  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', lookup: safeLookup, timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new MetadataFetchError(`HTTP ${String(res.statusCode)}${res.headers.location ? ' (redirect não seguido)' : ''}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new MetadataFetchError(`resposta maior que ${String(maxBytes)} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const j = MetadataJson.parse(JSON.parse(raw));
          resolve({
            description: j.description ?? null,
            image: j.image ?? null,
            twitter: j.twitter ?? null,
            telegram: j.telegram ?? null,
            website: j.website ?? null,
            rawJson: raw,
          });
        } catch (e) {
          reject(new MetadataFetchError(`JSON de metadados inválido: ${String(e)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new MetadataFetchError(`timeout de ${String(timeoutMs)} ms`)));
    req.on('error', reject);
    req.end();
  });
}
