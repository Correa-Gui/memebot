import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

type TablePlan = { table: string; timeColumn: string; ttlDays: number; exportBeforeDays: number; shardColumn: string | null };
type ManifestEntry = { table: string; date: string; shard: string; rows: number; bytes: number; sha256: string; parquetRows: number; through: string; verifiedAt: string; path: string };
const plans: TablePlan[] = [
  // Exportar o dia UTC anterior: a linha mais antiga terá < 2 dias, antes do TTL de 3.
  { table: 'events_trade', timeColumn: 'received_at', ttlDays: 3, exportBeforeDays: 1, shardColumn: 'mint' },
  { table: 'pumpswap_trade_extra', timeColumn: 'ts', ttlDays: 60, exportBeforeDays: 55, shardColumn: 'sig' },
  { table: 'ingest_gaps', timeColumn: 'detected_at', ttlDays: 60, exportBeforeDays: 55, shardColumn: null },
];
const { values } = parseArgs({ args: process.argv.slice(2), options: { snapshot: { type: 'boolean' }, through: { type: 'string' }, force: { type: 'boolean' } }, strict: true });
const throughMs = values.through ? Date.parse(values.through) : Date.now();
if (!Number.isFinite(throughMs)) throw new Error('--through precisa ser um timestamp ISO válido');
const throughIso = new Date(throughMs).toISOString();
const container = process.env['CLICKHOUSE_CONTAINER'] ?? 'memebot-clickhouse';
const root = resolve('data/cold');
const manifestPath = join(root, 'manifest.json');
const runId = throughIso.replace(/[-:.]/g, '').replace('T', '_').replace('Z', 'Z');
const settings = " SETTINGS output_format_parquet_compression_method='zstd', output_format_parquet_row_group_size=8192, output_format_parquet_row_group_size_bytes=16777216, output_format_parquet_parallel_encoding=0, max_threads=1, max_memory_usage=600000000, max_block_size=512";

function docker(args: string[]): string {
  return execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
}
function ch(sql: string): string {
  return docker(['clickhouse-client', '--query', sql]);
}
function utcDate(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function sourceWindow(plan: TablePlan): string {
  const cut = `fromUnixTimestamp64Milli(${throughMs})`;
  if (values.snapshot) return `${plan.timeColumn} <= ${cut}`;
  const date = utcDate(throughMs - plan.exportBeforeDays * 86_400_000);
  const start = Date.parse(`${date}T00:00:00.000Z`);
  const next = start + 86_400_000;
  return `${plan.timeColumn} >= fromUnixTimestamp64Milli(${start}) AND ${plan.timeColumn} < fromUnixTimestamp64Milli(${next}) AND ${plan.timeColumn} <= ${cut}`;
}
function rowsByDate(plan: TablePlan, where: string): { date: string; shard: string; rows: number }[] {
  const shardExpr = plan.shardColumn ? `substring(${plan.shardColumn},1,1)` : "'all'";
  const raw = ch(`SELECT toString(toDate(${plan.timeColumn})), ${shardExpr}, count() FROM memebot.${plan.table} WHERE ${where} GROUP BY toDate(${plan.timeColumn}), ${shardExpr} ORDER BY toDate(${plan.timeColumn}), ${shardExpr}${settings} FORMAT TSV`);
  if (!raw) return [];
  return raw.split(/\r?\n/).map((line) => {
    const [date, shard, rows] = line.split('\t');
    return { date: date ?? '', shard: shard ?? 'all', rows: Number(rows ?? 0) };
  });
}
function shardSuffix(shard: string): string { return shard === 'all' ? 'all' : shard === '' ? 'empty' : `k${shard.charCodeAt(0).toString().padStart(3, '0')}`; }
function shardFilter(plan: TablePlan, shard: string): string {
  if (!plan.shardColumn || shard === 'all') return '1';
  if (shard === '') return `${plan.shardColumn} = ''`;
  const next = String.fromCharCode(shard.charCodeAt(0) + 1);
  return `${plan.shardColumn} >= '${shard}' AND ${plan.shardColumn} < '${next}'`;
}
function sha256(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (data) => hash.update(data)).on('error', reject).on('end', () => resolveHash(hash.digest('hex')));
  });
}
async function hasParquetMagic(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    if (size < 8) return false;
    const header = Buffer.alloc(4); const footer = Buffer.alloc(4);
    await file.read(header, 0, 4, 0); await file.read(footer, 0, 4, size - 4);
    return header.toString('ascii') === 'PAR1' && footer.toString('ascii') === 'PAR1';
  } finally { await file.close(); }
}

await mkdir(root, { recursive: true });
let manifest: { exports: ManifestEntry[] } = { exports: [] };
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { exports: ManifestEntry[] }; } catch { /* first export */ }
const verified: ManifestEntry[] = [];
for (const plan of plans) {
  const where = sourceWindow(plan);
  const expected = rowsByDate(plan, where);
  const tempPrefix = `memebot_cold_${plan.table}_${runId}`;
  const expectedByDate = new Map<string, number>();
  for (const part of expected) expectedByDate.set(part.date, (expectedByDate.get(part.date) ?? 0) + part.rows);
  const verifiedByDate = new Map<string, number>();
  for (const part of expected) {
    const dayStart = Date.parse(`${part.date}T00:00:00.000Z`);
    const dayEnd = dayStart + 86_400_000;
    const partWhere = `${where} AND ${shardFilter(plan, part.shard)}`;
    const completePartWhere = `${partWhere} AND ${plan.timeColumn} >= fromUnixTimestamp64Milli(${dayStart}) AND ${plan.timeColumn} < fromUnixTimestamp64Milli(${dayEnd})`;
    const hostDir = join(root, plan.table, `dt=${part.date}`);
    await mkdir(hostDir, { recursive: true });
    const suffix = shardSuffix(part.shard);
    const hostPath = join(hostDir, values.snapshot ? `snapshot-${runId}-${suffix}.parquet` : `part-${suffix}.parquet`);
    const filename = `${tempPrefix}_${part.date}_${suffix}.parquet`;
    const sourcePath = `/var/lib/clickhouse/user_files/${filename}`;
    const already = manifest.exports.find((x) => x.table === plan.table && x.date === part.date && x.shard === part.shard && x.through === throughIso && x.rows === part.rows && x.path === hostPath);
    if (already && !values.force) {
      const onDisk = await stat(hostPath).catch(() => null);
      if (onDisk?.size === already.bytes && await sha256(hostPath) === already.sha256) { verified.push(already); verifiedByDate.set(part.date, (verifiedByDate.get(part.date) ?? 0) + part.rows); continue; }
    }
    ch(`INSERT INTO FUNCTION file('${filename}', 'Parquet') SELECT * FROM memebot.${plan.table} WHERE ${completePartWhere}${settings}`);
    const parquetRows = Number(ch(`SELECT count() FROM file('${filename}', 'Parquet')${settings}`));
    if (parquetRows !== part.rows) throw new Error(`${plan.table}/${part.date}: origem=${part.rows}, Parquet=${parquetRows}`);
    const remoteHash = docker(['sha256sum', sourcePath]).split(/\s+/)[0];
    execFileSync('docker', ['cp', `${container}:${sourcePath}`, hostPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const bytes = (await stat(hostPath)).size;
    const localHash = await sha256(hostPath);
    if (localHash !== remoteHash || !(await hasParquetMagic(hostPath))) throw new Error(`${plan.table}/${part.date}: cópia/hash/assinatura Parquet inválida`);
    const entry: ManifestEntry = { table: plan.table, date: part.date, shard: part.shard, rows: part.rows, parquetRows, bytes, sha256: localHash, through: throughIso, verifiedAt: new Date().toISOString(), path: hostPath };
    verified.push(entry);
    manifest.exports = [...manifest.exports.filter((x) => !(x.table === entry.table && x.date === entry.date && x.shard === entry.shard && x.through === entry.through && x.path === entry.path)), entry];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    docker(['rm', '-f', sourcePath]);
    verifiedByDate.set(part.date, (verifiedByDate.get(part.date) ?? 0) + part.rows);
    console.log(`${plan.table} ${part.date}: ${part.rows} linhas conferidas, ${bytes} bytes, sha256 ${localHash}`);
  }
  for (const [date, rows] of expectedByDate) if (verifiedByDate.get(date) !== rows) throw new Error(`${plan.table}/${date}: exportadas=${verifiedByDate.get(date) ?? 0}, origem=${rows}`);
  console.log(`${plan.table}: ${[...expectedByDate.values()].reduce((n, x) => n + x, 0)} linhas conferidas em ${expectedByDate.size} partições de data`);
}
console.log(JSON.stringify({ through: throughIso, snapshot: values.snapshot ?? false, verifiedPartitions: verified.length, manifest: manifestPath }, null, 2));
