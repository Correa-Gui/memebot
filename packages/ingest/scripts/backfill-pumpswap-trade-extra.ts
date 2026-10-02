/**
 * Backfill de `pumpswap_trade_extra` (migração 011) a partir de `events_trade.raw_b64`.
 *
 * URGENTE: `raw_b64` tem TTL de 30 dias contado de `received_at` (migração 008); depois disso o
 * trade não pode mais ser re-decodificado. Rode logo depois de aplicar a 011.
 *
 * Uso (na raiz do repo, com o container `memebot-clickhouse` rodando e a 011 aplicada):
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     packages/ingest/scripts/backfill-pumpswap-trade-extra.ts [--dry-run] [--from-chunk=N] [--batch=20000]
 *
 * - Credenciais nunca passam por este processo: as queries rodam via `docker exec` com as env vars
 *   já definidas DENTRO do container (mesmo padrão de packages/curve-math/scripts).
 * - Memória: leitura em streaming (sem ORDER BY, sem JOIN) e inserção em lotes de `--batch` linhas;
 *   o ClickHouse nunca monta nada grande em memória (limite ~1,8 GiB).
 * - Fatias por faixa de `mint` (chave de ordenação de events_trade), em ordem; o log mostra o
 *   índice de cada fatia — se cair no meio, recomece com `--from-chunk=<índice>`.
 * - Idempotente: a tabela é ReplacingMergeTree por (sig, event_index); repetir só regrava.
 * - Linhas sem raw (TTL expirado), eventos que não são Buy/SellEvent, `ix_name` desconhecido e
 *   erros de decodificação são contados por motivo e NÃO inseridos (resumo no final).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BackfillStats, backfillRow, mintChunks, type RawTradeRow } from './pumpswap-extra-backfill-core.ts';
import type { Row } from '../../recorder/src/rows.ts';

const CONTAINER = 'memebot-clickhouse';
const CH = 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database memebot';

function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pfx))?.slice(pfx.length);
}

const dryRun = process.argv.includes('--dry-run');
const fromChunk = Number(arg('from-chunk') ?? '0');
const batchSize = Number(arg('batch') ?? '20000');
if (!Number.isInteger(fromChunk) || fromChunk < 0) throw new Error('--from-chunk inválido');
if (!Number.isInteger(batchSize) || batchSize < 100 || batchSize > 200_000) throw new Error('--batch fora de [100, 200000]');

function querySync(sql: string): string {
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', CH], { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ClickHouse falhou: ${r.stderr}`);
  return r.stdout;
}

function insertBatch(rows: Row[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const r = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'sh', '-c', `${CH} --query "INSERT INTO pumpswap_trade_extra FORMAT JSONEachRow"`],
    { input: body, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`INSERT falhou: ${r.stderr}`);
}

async function processChunk(where: string, stats: BackfillStats): Promise<void> {
  const sql =
    'SELECT sig, event_index, toString(slot) AS slot, toUnixTimestamp64Milli(ts) AS ts_ms, pool, raw_b64 ' +
    `FROM events_trade WHERE venue = 'pumpswap' AND ${where} FORMAT JSONEachRow`;
  const child = spawn('docker', ['exec', '-i', CONTAINER, 'sh', '-c', CH], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    stderr += c.toString();
  });
  const exited = new Promise<number>((resolve) => child.on('close', (code) => {
    resolve(code ?? -1);
  }));
  child.stdin.end(sql);

  let batch: Row[] = [];
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    const raw = JSON.parse(line) as RawTradeRow;
    const out = backfillRow(raw, Date.now());
    stats.add(out, raw.sig);
    if (!out.ok) continue;
    batch.push(out.row);
    if (batch.length >= batchSize) {
      if (!dryRun) insertBatch(batch); // síncrono: segura a leitura (backpressure no pipe)
      stats.written += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    if (!dryRun) insertBatch(batch);
    stats.written += batch.length;
  }
  const code = await exited;
  if (code !== 0) throw new Error(`leitura da fatia falhou (código ${String(code)}): ${stderr}`);
}

async function main(): Promise<void> {
  if (!dryRun && querySync('EXISTS TABLE pumpswap_trade_extra').trim() !== '1') {
    throw new Error('pumpswap_trade_extra não existe: aplique a migração 011 (pnpm migrate) antes do backfill');
  }
  const total = new BackfillStats();
  for (const chunk of mintChunks()) {
    if (chunk.index < fromChunk) continue;
    const stats = new BackfillStats();
    const t0 = Date.now();
    await processChunk(chunk.where, stats);
    total.read += stats.read;
    total.written += stats.written;
    for (const [k, v] of stats.skipped) total.skipped.set(k, (total.skipped.get(k) ?? 0) + v);
    for (const [k, v] of stats.samples) if (!total.samples.has(k)) total.samples.set(k, v);
    console.log(`fatia ${String(chunk.index)} (${chunk.label}): ${stats.summary()} em ${String(Math.round((Date.now() - t0) / 1000))} s`);
  }
  console.log(`${dryRun ? '[dry-run, nada gravado] ' : ''}TOTAL: ${total.summary()}`);
  for (const [k, v] of total.samples) console.log(`  exemplos ${k}: ${v.join(' | ')}`);
}

await main();
