import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';

function captureLines(): { destination: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { destination, lines: () => chunks };
}

describe('logger redaction', () => {
  it('mascara campos sensíveis e preserva os demais', () => {
    const { destination, lines } = captureLines();
    const logger = createLogger({ destination });

    logger.info({
      secret: 'super-secreto',
      key: 'chave-privada',
      token: 'abc123',
      keypair: [1, 2, 3],
      authorization: 'Bearer xyz',
      mint: 'So11111111111111111111111111111111111111112',
    });

    const [line] = lines();
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;

    expect(parsed['secret']).toBe('[REDACTED]');
    expect(parsed['key']).toBe('[REDACTED]');
    expect(parsed['token']).toBe('[REDACTED]');
    expect(parsed['keypair']).toBe('[REDACTED]');
    expect(parsed['authorization']).toBe('[REDACTED]');
    expect(parsed['mint']).toBe('So11111111111111111111111111111111111111112');

    for (const raw of ['super-secreto', 'chave-privada', 'abc123', 'Bearer xyz']) {
      expect(line).not.toContain(raw);
    }
  });

  it('mascara campos aninhados', () => {
    const { destination, lines } = captureLines();
    const logger = createLogger({ destination });

    logger.info({ wallet: { keypair: 'raw-bytes', label: 'hot' } });

    const [line] = lines();
    const parsed = JSON.parse(line ?? '{}') as { wallet: Record<string, unknown> };
    expect(parsed.wallet['keypair']).toBe('[REDACTED]');
    expect(parsed.wallet['label']).toBe('hot');
  });
});
