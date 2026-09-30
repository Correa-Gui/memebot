import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(dir, 'migrations');

if (existsSync('.env')) process.loadEnvFile('.env');
const url = process.env['CLICKHOUSE_URL'] ?? 'http://127.0.0.1:8123';
const database = process.env['CLICKHOUSE_DB'] ?? 'memebot';
const user = process.env['CLICKHOUSE_USER'] ?? 'memebot';
const password = process.env['CLICKHOUSE_PASSWORD'] ?? '';

if (!/^\w+$/.test(database)) throw new Error('CLICKHOUSE_DB inválido');

async function query(sql: string, db: string | null = database): Promise<string> {
  const qs = db ? `?database=${encodeURIComponent(db)}` : '';
  const res = await fetch(`${url}/${qs}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
    },
    body: sql,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Falha na migração ClickHouse: ${String(res.status)} ${body}`);
  return body;
}

async function main(): Promise<void> {
  await query(`CREATE DATABASE IF NOT EXISTS ${database}`, null);
  await query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name String, checksum String, applied_at DateTime64(3, \'UTC\')) ENGINE = MergeTree ORDER BY name',
  );
  const applied = new Map(
    (await query('SELECT name, checksum FROM schema_migrations FORMAT TSV'))
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.split('\t') as [string, string]),
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);
    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(`${file} mudou depois de aplicada. Crie uma nova migração em vez de editar a antiga.`);
      }
      continue;
    }
    const statements = sql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) await query(statement);
    await query(
      `INSERT INTO schema_migrations (name, checksum, applied_at) VALUES ('${file.replace(/'/g, '')}', '${checksum}', now64(3))`,
    );
    console.log(`aplicado: ${file}`);
  }
}

await main();
