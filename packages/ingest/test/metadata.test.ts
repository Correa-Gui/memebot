import { describe, expect, it } from 'vitest';
import { fetchTokenMetadata, isBlockedAddress, resolveMetadataUrl } from '../src/metadata.ts';

const gw = 'https://ipfs.io/ipfs/';

describe('proteção contra SSRF nos metadados', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.0.10', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1'])(
    'bloqueia %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
    },
  );

  it.each(['1.1.1.1', '104.16.0.1', '2606:4700::1111'])('permite %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('só aceita https e converte ipfs:// para o gateway', () => {
    expect(resolveMetadataUrl('ipfs://QmHash', gw).href).toBe('https://ipfs.io/ipfs/QmHash');
    expect(resolveMetadataUrl('ipfs://ipfs/QmHash', gw).href).toBe('https://ipfs.io/ipfs/QmHash');
    expect(() => resolveMetadataUrl('http://example.com/a.json', gw)).toThrow(/protocolo/);
    expect(() => resolveMetadataUrl('file:///etc/passwd', gw)).toThrow(/protocolo/);
    expect(() => resolveMetadataUrl('https://user:pw@example.com/', gw)).toThrow(/credenciais/);
    expect(() => resolveMetadataUrl('https://127.0.0.1:8123/?query=DROP', gw)).toThrow(/bloqueado/);
    expect(() => resolveMetadataUrl('https://[::1]/', gw)).toThrow(/bloqueado/);
  });

  it('recusa hostname que resolve para loopback (checagem no lookup do socket)', async () => {
    await expect(fetchTokenMetadata('https://localhost:8123/', { ipfsGateway: gw, timeoutMs: 2_000 })).rejects.toThrow(/bloqueado/);
  });
});
