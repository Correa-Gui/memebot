import pino from 'pino';

/**
 * Nomes de campo redigidos em qualquer profundidade do objeto de log.
 * Cobre segredos: chaves, tokens, senhas, keypairs, cabeçalhos de autorização.
 */
const REDACTED_FIELD_NAMES = ['key', 'secret', 'token', 'keypair', 'authorization'];

const REDACT_PATHS = REDACTED_FIELD_NAMES.flatMap((name) => [
  `*.${name}`,
  `*.*.${name}`,
  `*.*.*.${name}`,
  name,
]);

export function createLogger(options?: {
  name?: string;
  level?: string;
  destination?: NodeJS.WritableStream;
}): pino.Logger {
  const opts: pino.LoggerOptions = {
    name: options?.name ?? 'memebot',
    level: options?.level ?? 'info',
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };
  return options?.destination ? pino(opts, options.destination) : pino(opts);
}

export type Logger = pino.Logger;

export const logger = createLogger();
