import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const ConfigSchema = z.object({
  MODE: z.enum(['record', 'paper', 'live']).default('record'),
  LIVE_CONFIRM: z.string().default(''),

  INGEST_SOURCE: z.enum(['websocket', 'grpc']).default('websocket'),
  RPC_URL: z.string().optional(),
  RPC_WS_URL: z.string().optional(),
  GRPC_ENDPOINT: z.string().optional(),
  GRPC_TOKEN: z.string().optional(),
  JITO_BLOCK_ENGINE_URL: z.string().default('https://ny.mainnet.block-engine.jito.wtf'),
  KEYPAIR_PATH: z.string().default('./secrets/hot.keypair.json'),
  /** getTransaction por segundo para amostrar priority fee / tip (0 desliga). Ver ARCHITECTURE §8. */
  INGEST_COST_SAMPLES_PER_SEC: z.coerce.number().nonnegative().max(50).default(0.2),
  PROTOCOL_CONFIG_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  IPFS_GATEWAY: z.string().url().startsWith('https://').default('https://ipfs.io/ipfs/'),
  METADATA_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  METADATA_CONCURRENCY: z.coerce.number().int().positive().default(8),
  /** Resoluções de pool PumpSwap (RPC) simultâneas; o resto espera na fila. Ver ROADMAP Fase 1 item 2. */
  POOL_RESOLVE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Consultas de pool PumpSwap por segundo (aceita fração). Ver .env.example: orçamento de créditos do RPC. */
  POOL_RESOLVE_PER_SEC: z.coerce.number().positive().max(50).default(0.1),

  CLICKHOUSE_URL: z.string().default('http://127.0.0.1:8123'),
  CLICKHOUSE_USER: z.string().default('memebot'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  CLICKHOUSE_DB: z.string().default('memebot'),

  TYPESAFE_API_KEY: z.string().default(''),
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(600),
  X_API_BEARER: z.string().default(''),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  /** hourly = só resumo na virada de hora (BRT) + alertas imediatos; all = também cada entrada/saída. */
  TELEGRAM_MODE: z.enum(['hourly', 'all']).default('hourly'),

  PAPER_LATENCY_MS: z.coerce.number().int().nonnegative().default(800),
  PAPER_FAIL_RATE: z.coerce.number().min(0).max(1).default(0.1),
  /**
   * Custos do paper executor (ARCHITECTURE §5): priority fee / tip = mediana de `tx_costs` × 1,5, mas
   * só com pelo menos este nº de amostras; abaixo disso usa os fallbacks abaixo (marcados no fill
   * como `cost_estimate_source = 'fallback'`). Fallbacks propositalmente conservadores (~2× a mediana
   * × 1,5 das poucas amostras de 2026-10-01 para a priority fee; tip sem amostras com Jito) e
   * sempre limitados pelos hard limits (`packages/risk/src/hard-limits.ts`).
   */
  PAPER_COST_MIN_SAMPLES: z.coerce.number().int().positive().default(30),
  PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS: z.coerce.bigint().nonnegative().default(500_000n),
  PAPER_FALLBACK_JITO_TIP_LAMPORTS: z.coerce.bigint().nonnegative().default(500_000n),
  /** Janela de `tx_costs` (horas) usada na estimativa de custos do paper, e o intervalo de recarga. */
  PAPER_COST_LOOKBACK_HOURS: z.coerce.number().int().positive().max(24 * 30).default(24),
  PAPER_COST_RELOAD_MS: z.coerce.number().int().positive().default(600_000),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Carrega e valida a config a partir de um objeto de variáveis de ambiente
 * (normalmente `process.env`). Nunca loga o valor recebido: pode conter segredos.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Config inválida: ${result.error.message}`);
  }

  if (result.data.MODE === 'live' && result.data.LIVE_CONFIRM !== 'I_UNDERSTAND_REAL_MONEY') {
    throw new Error(
      'MODE=live exige LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY. Ver docs/RISK_AND_SECURITY.md.',
    );
  }

  return result.data;
}

export type ConfigSource = 'env do processo' | '.env' | 'padrão';

let lastSources: Partial<Record<keyof AppConfig, ConfigSource>> = {};

/**
 * De onde veio cada chave na última chamada de `loadConfigFromEnvFile`: o ambiente do processo vence o
 * `.env` (é o que `process.loadEnvFile` faz). Só a origem — nunca o valor (pode ser segredo).
 * Motivo: em 2026-10-01 o daemon do pm2 tinha herdado INGEST_COST_SAMPLES_PER_SEC=0 no ambiente e
 * isso anulava o `.env`/padrão sem nenhum sinal no log.
 */
export function configSource(key: keyof AppConfig): ConfigSource | undefined {
  return lastSources[key];
}

/** Lê o arquivo `.env` (se existir) para `process.env` e valida. Variáveis já definidas no ambiente têm precedência. */
export function loadConfigFromEnvFile(envPath = '.env'): AppConfig {
  const keys = Object.keys(ConfigSchema.shape) as (keyof AppConfig)[];
  const fromProcess = new Set(keys.filter((k) => process.env[k] !== undefined));
  const inFile = existsSync(envPath) ? new Set(Object.keys(parseEnv(readFileSync(envPath, 'utf8')))) : new Set<string>();
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
  lastSources = Object.fromEntries(
    keys.map((k): [keyof AppConfig, ConfigSource] => [k, fromProcess.has(k) ? 'env do processo' : inFile.has(k) ? '.env' : 'padrão']),
  );
  return loadConfig(process.env);
}
