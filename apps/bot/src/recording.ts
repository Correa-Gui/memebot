import { createHash } from 'node:crypto';
import { configSource, type AppConfig, type IngestGap, type Logger, type PumpEvent } from '@memebot/core';
import {
  IngestService,
  RateLimiter,
  RpcClient,
  TxCostSampler,
  createPoolResolver,
  fetchJitoTipAccounts,
  fetchTokenMetadata,
  readProtocolConfig,
  type PoolResolver,
  type ProtocolConfigSnapshot,
} from '@memebot/ingest';
import { Recorder } from '@memebot/recorder';
import { BoundedQueue } from './bounded-queue.ts';
import { configHash, endpointHost, gitCommit, idlHash, newRunId, STREAM_GAP_PROVISIONAL_RATIO } from './run-info.ts';

/**
 * Caminho comum de `record` e `paper` (extraído de `runRecord`): run em `runs`, gravação de todos os
 * eventos, `protocol_config` na partida e periódico, amostragem de `tx_costs`, metadados e log de
 * ingest por minuto. O paper só acrescenta o consumidor de eventos (`startIngest(onEvent)`).
 */

export function requireUrls(cfg: AppConfig): { rpcUrl: string; wsUrl: string } {
  if (!cfg.RPC_URL || !cfg.RPC_WS_URL) throw new Error('RPC_URL e RPC_WS_URL são obrigatórios (ver .env.example)');
  if (cfg.INGEST_SOURCE === 'grpc') throw new Error('INGEST_SOURCE=grpc ainda não implementado; use websocket (ARCHITECTURE §8)');
  return { rpcUrl: cfg.RPC_URL, wsUrl: cfg.RPC_WS_URL };
}

export interface RecordingOptions {
  mode: 'record' | 'paper';
  /** Hash extra combinado ao hash da config (ex.: o YAML da estratégia no paper). */
  extraConfigHash?: string;
  /** Roda depois de conectar no ClickHouse e ANTES de gravar a run (ex.: conferir migrações). */
  preflight?: (recorder: Recorder) => Promise<void>;
  /** Chamado a cada leitura bem-sucedida de protocol_config (partida e periódica). */
  onProtocolConfig?: (snapshots: ProtocolConfigSnapshot[]) => void;
  /** Recebe lacunas detectadas no WebSocket além de gravá-las no ClickHouse. */
  onGap?: (gap: IngestGap) => void;
}

export interface RecordingSession {
  runId: string;
  rpc: RpcClient;
  recorder: Recorder;
  /** Snapshots da primeira leitura de protocol_config (vazio se o RPC falhou). */
  initialProtocolConfig: ProtocolConfigSnapshot[];
  startIngest(onEvent?: (e: PumpEvent) => void): Promise<void>;
  /** Contadores cumulativos desde o início do ingest: tempo sem stream (inclui lacuna aberta) e 429 de todo HTTP. */
  healthCounters(): { streamGapMs: number; http429: number };
  close(): Promise<void>;
}

export async function openRecordingSession(cfg: AppConfig, log: Logger, opts: RecordingOptions): Promise<RecordingSession> {
  const { rpcUrl, wsUrl } = requireUrls(cfg);
  const runId = newRunId(opts.mode, Date.now());
  const rpc = new RpcClient(rpcUrl);
  const recorder = new Recorder({
    url: cfg.CLICKHOUSE_URL,
    username: cfg.CLICKHOUSE_USER,
    password: cfg.CLICKHOUSE_PASSWORD,
    database: cfg.CLICKHOUSE_DB,
    runId,
    logger: log,
  });
  await recorder.start();
  if (opts.preflight) {
    try {
      await opts.preflight(recorder);
    } catch (e) {
      await recorder.stop();
      throw e;
    }
  }
  // Qualidade MEDIDA: começa provisional e é decidida por `v_run_quality` (run_health, gravado a cada
  // minuto): provisional se o tempo sem stream passar de 1% do run. Hosts só informativos.
  const quality = 'provisional' as const;
  const endpoints = { rpcHost: endpointHost(rpcUrl), wsHost: endpointHost(wsUrl) };
  const runStartedMs = Date.now();
  const baseHash = configHash(cfg);
  const hash = opts.extraConfigHash ? createHash('sha256').update(`${baseHash}:${opts.extraConfigHash}`).digest('hex') : baseHash;
  const run = { mode: opts.mode, configHash: hash, gitCommit: gitCommit(), idlHash: idlHash(), quality };
  await recorder.recordRun(run);
  log.info({ runId, ...run, endpoints }, 'run iniciado (qualidade medida a cada minuto: provisional se sem stream > 1% do tempo)');
  // Origem (sem valor/chave) das configurações que mais já enganaram: lida pelo `pnpm status`.
  log.info(
    {
      configSources: {
        RPC_URL: { source: configSource('RPC_URL'), host: endpoints.rpcHost },
        RPC_WS_URL: { source: configSource('RPC_WS_URL'), host: endpoints.wsHost },
        INGEST_COST_SAMPLES_PER_SEC: { source: configSource('INGEST_COST_SAMPLES_PER_SEC'), value: cfg.INGEST_COST_SAMPLES_PER_SEC },
      },
    },
    'config sources',
  );

  // configuração de taxas/curva on-chain: na partida e periodicamente (CLAUDE.md §7)
  const snapshotProtocol = async (): Promise<ProtocolConfigSnapshot[]> => {
    try {
      const snaps = await readProtocolConfig(rpc);
      for (const s of snaps) {
        const h = createHash('sha256').update(s.configJson).digest('hex');
        recorder.recordProtocolConfig({ ...s, configHash: h });
        log.info({ account: s.account, type: s.accountType, configHash: h.slice(0, 16) }, 'protocol_config lido');
      }
      opts.onProtocolConfig?.(snaps);
      return snaps;
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'falha ao ler protocol_config');
      return [];
    }
  };
  const initialProtocolConfig = await snapshotProtocol();
  const timers: ReturnType<typeof setInterval>[] = [setInterval(() => void snapshotProtocol(), cfg.PROTOCOL_CONFIG_INTERVAL_MS)];

  let ingest: IngestService | null = null;
  let healthCounters = (): { streamGapMs: number; http429: number } => ({ streamGapMs: 0, http429: 0 });
  const metadataQueue = new BoundedQueue(cfg.METADATA_CONCURRENCY, 5_000);

  const startIngest = async (consumer?: (e: PumpEvent) => void): Promise<void> => {
    // amostra é descartável: sem retry, para não gastar a cota do RPC que o resolver de pools precisa
    const samplerRpc = new RpcClient(rpcUrl, { maxRetries: 0 });
    const sampler = new TxCostSampler(samplerRpc, cfg.INGEST_COST_SAMPLES_PER_SEC);
    const refreshTips = async (): Promise<void> => {
      try {
        sampler.setTipAccounts(await fetchJitoTipAccounts(cfg.JITO_BLOCK_ENGINE_URL));
      } catch (e) {
        log.warn({ err: e instanceof Error ? e.message : String(e) }, 'contas de tip do Jito indisponíveis; jito_tip ficará nulo');
      }
    };
    await refreshTips();
    timers.push(setInterval(() => void refreshTips(), 3_600_000));

    // cliente próprio sem retry imediato (429 → backoff por pool do Normalizer) e taxa limitada
    const poolRpc = new RpcClient(rpcUrl, { maxRetries: 0 });
    const baseResolver = createPoolResolver(poolRpc, new RateLimiter(cfg.POOL_RESOLVE_PER_SEC));
    const resolvePool: PoolResolver = async (pool) => {
      const info = await baseResolver(pool);
      if (info !== 'not_pool') recorder.recordResolvedPool({ pool, ...info });
      return info;
    };
    const knownPools = (await recorder.loadPools()).map((p) => [p.pool, { baseMint: p.baseMint, quoteMint: p.quoteMint }] as [string, { baseMint: string; quoteMint: string }]);
    log.info({ pools: knownPools.length }, 'pools pré-carregadas (nenhuma será reconsultada por RPC)');

    const onEvent = (e: PumpEvent): void => {
      recorder.recordEvent(e);
      if (consumer) {
        try {
          consumer(e);
        } catch (err) {
          // Erro do consumidor (paper) não pode parar a gravação: registrado com o evento que o causou.
          log.error({ err: err instanceof Error ? `${err.name}: ${err.message}` : String(err), kind: e.kind, sig: e.sig }, 'erro ao processar evento no consumidor');
        }
      }
      if (e.kind !== 'token_created') return;
      const accepted = metadataQueue.push(async () => {
        try {
          const m = await fetchTokenMetadata(e.uri, { ipfsGateway: cfg.IPFS_GATEWAY, timeoutMs: cfg.METADATA_TIMEOUT_MS });
          recorder.recordMetadata(e.mint, { ok: true, ...m });
        } catch (err) {
          recorder.recordMetadata(e.mint, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
      if (!accepted) recorder.recordMetadata(e.mint, { ok: false, error: 'fila de metadados cheia' });
    };

    const service = new IngestService({
      wsUrl,
      resolvePool,
      knownPools,
      poolResolveConcurrency: cfg.POOL_RESOLVE_CONCURRENCY,
      sampler,
      onGap: (g) => {
        recorder.recordGap(g);
        opts.onGap?.(g);
      },
      logger: log,
    });
    ingest = service;
    healthCounters = () => {
      const w = service.wsStats();
      return {
        streamGapMs: w.closedGapMs + (w.openGapSince === null ? 0 : Date.now() - w.openGapSince),
        http429: rpc.stats.rateLimited + samplerRpc.stats.rateLimited + poolRpc.stats.rateLimited,
      };
    };
    await service.start((e) => {
      if (e.kind !== 'social_post') onEvent(e);
    });

    log.info({ costSamplesPerSec: cfg.INGEST_COST_SAMPLES_PER_SEC }, 'amostragem de custos (tx_costs)');
    let last = { ...service.stats };
    let lastRpc = { ...rpc.stats };
    let lastSamplerRpc = { ...samplerRpc.stats };
    let lastPoolRpc = { ...poolRpc.stats };
    let lastWs = service.wsStats();
    let lastCost = { ...sampler.stats, rateLimited: sampler.rateLimited };
    timers.push(
      setInterval(() => {
        const s = service.stats;
        const ws = service.wsStats();
        const nowMs = Date.now();
        const uptimeMs = nowMs - runStartedMs;
        const streamGapMs = ws.closedGapMs + (ws.openGapSince === null ? 0 : nowMs - ws.openGapSince);
        recorder.recordRunHealth({ uptimeMs, streamGapMs, ...endpoints });
        const mem = process.memoryUsage();
        // Todas as requisições HTTP ao RPC_URL (cada tentativa = 1 crédito no Helius): protocol_config e
        // rent (cliente `rpc`) + resolvedor de pools e amostrador de custos (clientes próprios, sem retry).
        const httpRequestsPerMin =
          rpc.stats.requests - lastRpc.requests +
          (samplerRpc.stats.requests - lastSamplerRpc.requests) +
          (poolRpc.stats.requests - lastPoolRpc.requests);
        const http429PerMin =
          rpc.stats.rateLimited - lastRpc.rateLimited +
          (samplerRpc.stats.rateLimited - lastSamplerRpc.rateLimited) +
          (poolRpc.stats.rateLimited - lastPoolRpc.rateLimited);
        log.info(
          {
            eventsPerMin: s.events - last.events,
            notificationsPerMin: s.notifications - last.notifications,
            gapsPerMin: s.gaps - last.gaps,
            unresolvedPoolsPerMin: s.unresolvedPools - last.unresolvedPools,
            rpcCallsPerMin: rpc.stats.calls - lastRpc.calls,
            rpc429PerMin: rpc.stats.rateLimited - lastRpc.rateLimited,
            http: { requestsPerMin: httpRequestsPerMin, rateLimitedPerMin: http429PerMin },
            quality: {
              streamGapMs,
              streamGapPct: Math.round((streamGapMs / Math.max(1, uptimeMs)) * 10_000) / 100,
              measured: streamGapMs / Math.max(1, uptimeMs) > STREAM_GAP_PROVISIONAL_RATIO ? 'provisional' : 'production',
            },
            ws: {
              mbPerMin: Math.round(((ws.payloadBytes - lastWs.payloadBytes) / 1_048_576) * 100) / 100,
              messagesPerMin: ws.messages - lastWs.messages,
              reconnectsPerMin: ws.reconnects - lastWs.reconnects,
            },
            poolCache: service.poolCacheStats(),
            writer: recorder.stats,
            metadataQueue: metadataQueue.size,
            heapMb: Math.round(mem.heapUsed / 1_048_576),
            costSamples: {
              attemptedPerMin: sampler.stats.attempted - lastCost.attempted,
              recordedPerMin: sampler.stats.sampled - lastCost.sampled,
              notFoundPerMin: sampler.stats.notFound - lastCost.notFound,
              failedPerMin: sampler.stats.failed - lastCost.failed,
              rpc429PerMin: sampler.rateLimited - lastCost.rateLimited,
              lastError: sampler.stats.lastError,
            },
          },
          'ingest',
        );
        last = { ...s };
        lastRpc = { ...rpc.stats };
        lastSamplerRpc = { ...samplerRpc.stats };
        lastPoolRpc = { ...poolRpc.stats };
        lastWs = ws;
        lastCost = { ...sampler.stats, rateLimited: sampler.rateLimited };
        service.retryPendingPools();
      }, 60_000),
    );
  };

  const close = async (): Promise<void> => {
    for (const t of timers) clearInterval(t);
    if (ingest) await ingest.stop();
    await metadataQueue.onIdle();
    await recorder.stop();
    log.info({ stats: ingest?.stats ?? null, writer: recorder.stats }, 'encerrado');
  };

  return { runId, rpc, recorder, initialProtocolConfig, startIngest, healthCounters: () => healthCounters(), close };
}

/** Espera SIGINT/SIGTERM ou a mensagem 'shutdown' do pm2 por IPC (Windows não tem sinais). */
export function waitForShutdown(log: Logger): Promise<string> {
  return new Promise<string>((resolve) => {
    const shutdown = (signal: string): void => {
      log.info({ signal }, 'encerrando');
      resolve(signal);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    // pm2 no Windows não tem sinais: com `shutdown_with_message` ele envia 'shutdown' por IPC
    process.on('message', (msg) => {
      if (msg === 'shutdown') shutdown('pm2:shutdown');
    });
  });
}
