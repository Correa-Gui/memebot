import { createLogger, loadConfigFromEnvFile, type AppConfig, type Logger } from '@memebot/core';
import { IngestService, RpcClient, createPoolResolver } from '@memebot/ingest';
import { parseBotArgs } from './args.ts';
import { describeEvent } from './format.ts';
import { runPaper } from './paper/run-paper.ts';
import { openRecordingSession, requireUrls, waitForShutdown } from './recording.ts';

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
  const session = await openRecordingSession(cfg, log, { mode: 'record' });
  try {
    await session.startIngest();
    await waitForShutdown(log);
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const args = parseBotArgs(process.argv.slice(2));
  process.env['MODE'] = args.mode;
  const cfg = loadConfigFromEnvFile();
  const log = createLogger({ name: `bot-${args.mode}` });

  if (args.mode === 'live') {
    throw new Error('modo live ainda não existe (Fase 6). Ver docs/ROADMAP.md.');
  }
  if (args.debugEvents !== null) {
    await runDebug(cfg, args.debugEvents, log);
    return;
  }
  if (args.mode === 'paper') {
    await runPaper(cfg, log);
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
