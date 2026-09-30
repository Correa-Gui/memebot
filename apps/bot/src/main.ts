import { createHash } from 'node:crypto';
import { createLogger, loadConfigFromEnvFile, type AppConfig, type Logger, type PumpEvent } from '@memebot/core';
import {
  IngestService,
  RpcClient,
  TxCostSampler,
  createPoolResolver,
  fetchJitoTipAccounts,
  fetchTokenMetadata,
  readProtocolConfig,
  type PoolResolver,
} from '@memebot/ingest';
import { Recorder } from '@memebot/recorder';
import { parseBotArgs } from './args.ts';
import { BoundedQueue } from './bounded-queue.ts';
import { describeEvent } from './format.ts';
import { configHash, gitCommit, idlHash, newRunId } from './run-info.ts';

function requireUrls(cfg: AppConfig): { rpcUrl: string; wsUrl: string } {
  if (!cfg.RPC_URL || !cfg.RPC_WS_URL) throw new Error('RPC_URL e RPC_WS_URL são obrigatórios (ver .env.example)');
  if (cfg.INGEST_SOURCE === 'grpc') throw new Error('INGEST_SOURCE=grpc ainda não implementado; use websocket (ARCHITECTURE §8)');
  return { rpcUrl: cfg.RPC_URL, wsUrl: cfg.RPC_WS_URL };
}

/** Imprime os N primeiros eventos (com link do Solscan) e sai. Não grava nada. */
async function runDebug(cfg: AppConfig, n: number, log: Logger): Promise<void> {
  const { rpcUrl, wsUrl } = requireUrls(cfg);
  const rpc = new RpcClient(rpcUrl);
  let printed = 0;
  let done: () => void = () => undefined;
  const finished = new Promise<void>((r) => (done = r));
  const ingest = new IngestService({
    wsUrl,
    resolvePool: createPoolResolver(rpc),
    onGap: (g) => {
      console.log(`   [gap] ${g.kind}: ${g.detail}${g.sig ? ` https://solscan.io/tx/${g.sig}` : ''}`);
    },
    logger: log,
  });
  console.log(`Aguardando ${String(n)} eventos... (confira cada link no Solscan)\n`);
  await ingest.start((e) => {
    if (e.kind === 'social_post' || printed >= n) return;
    console.log(describeEvent(e, ++printed));
    if (printed >= n) done();
  });
  await finished;
  await ingest.stop();
  console.log(`\nestatísticas: ${JSON.stringify(ingest.stats)}`);
}

async function runRecord(cfg: AppConfig, log: Logger): Promise<void> {
  const { rpcUrl, wsUrl } = requireUrls(cfg);
  const runId = newRunId('record', Date.now());
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
  const run = { mode: 'record' as const, configHash: configHash(cfg), gitCommit: gitCommit(), idlHash: idlHash() };
  await recorder.recordRun(run);
  log.info({ runId, ...run }, 'run iniciado');

  // configuração de taxas/curva on-chain: na partida e periodicamente (CLAUDE.md §7)
  const snapshotProtocol = async (): Promise<void> => {
    try {
      for (const s of await readProtocolConfig(rpc)) {
        const hash = createHash('sha256').update(s.configJson).digest('hex');
        recorder.recordProtocolConfig({ ...s, configHash: hash });
        log.info({ account: s.account, type: s.accountType, configHash: hash.slice(0, 16) }, 'protocol_config lido');
      }
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'falha ao ler protocol_config');
    }
  };
  await snapshotProtocol();
  const protocolTimer = setInterval(() => void snapshotProtocol(), cfg.PROTOCOL_CONFIG_INTERVAL_MS);

  // amostra é descartável: sem retry, para não gastar a cota do RPC que o resolver de pools precisa
  const sampler = new TxCostSampler(new RpcClient(rpcUrl, { maxRetries: 0 }), cfg.INGEST_COST_SAMPLES_PER_SEC);
  const refreshTips = async (): Promise<void> => {
    try {
      sampler.setTipAccounts(await fetchJitoTipAccounts(cfg.JITO_BLOCK_ENGINE_URL));
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'contas de tip do Jito indisponíveis; jito_tip ficará nulo');
    }
  };
  await refreshTips();
  const tipsTimer = setInterval(() => void refreshTips(), 3_600_000);

  const baseResolver = createPoolResolver(rpc);
  const resolvePool: PoolResolver = async (pool) => {
    const info = await baseResolver(pool);
    if (info !== 'not_pool') recorder.recordResolvedPool({ pool, ...info });
    return info;
  };
  const knownPools = (await recorder.loadPools()).map((p) => [p.pool, { baseMint: p.baseMint, quoteMint: p.quoteMint }] as [string, { baseMint: string; quoteMint: string }]);
  log.info({ pools: knownPools.length }, 'pools pré-carregadas');

  const metadataQueue = new BoundedQueue(cfg.METADATA_CONCURRENCY, 5_000);
  const onEvent = (e: PumpEvent): void => {
    recorder.recordEvent(e);
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

  const ingest = new IngestService({
    wsUrl,
    resolvePool,
    knownPools,
    sampler,
    onGap: (g) => {
      recorder.recordGap(g);
    },
    logger: log,
  });
  await ingest.start((e) => {
    if (e.kind !== 'social_post') onEvent(e);
  });

  let last = { ...ingest.stats };
  const statsTimer = setInterval(() => {
    const s = ingest.stats;
    log.info(
      { eventsPerMin: s.events - last.events, notificationsPerMin: s.notifications - last.notifications, gapsPerMin: s.gaps - last.gaps, writer: recorder.stats, metadataQueue: metadataQueue.size },
      'ingest',
    );
    last = { ...s };
  }, 60_000);

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      log.info({ signal }, 'encerrando');
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    // pm2 no Windows não tem sinais: com `shutdown_with_message` ele envia 'shutdown' por IPC
    process.on('message', (msg) => {
      if (msg === 'shutdown') shutdown('pm2:shutdown');
    });
  });

  clearInterval(protocolTimer);
  clearInterval(tipsTimer);
  clearInterval(statsTimer);
  await ingest.stop();
  await metadataQueue.onIdle();
  await recorder.stop();
  log.info({ stats: ingest.stats, writer: recorder.stats }, 'encerrado');
}

async function main(): Promise<void> {
  const args = parseBotArgs(process.argv.slice(2));
  process.env['MODE'] = args.mode;
  const cfg = loadConfigFromEnvFile();
  const log = createLogger({ name: `bot-${args.mode}` });

  if (args.mode !== 'record') {
    throw new Error(`modo ${args.mode} ainda não existe (paper: Fase 3; live: Fase 6). Ver docs/ROADMAP.md.`);
  }
  if (args.debugEvents !== null) {
    await runDebug(cfg, args.debugEvents, log);
    return;
  }
  await runRecord(cfg, log);
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
