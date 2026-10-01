import { readFileSync } from 'node:fs';
import { formatStatus, summarizeIngestLog } from './status-summary.ts';

// pnpm status [--log=data/logs/memebot-record.out.log] [--minutes=30]
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k ?? '', v ?? ''];
  }),
);
const logPath = args.get('log') || 'data/logs/memebot-record.out.log';
const minutes = Number(args.get('minutes') || '30');
if (!Number.isInteger(minutes) || minutes <= 0) throw new Error('--minutes deve ser inteiro positivo');

const summary = summarizeIngestLog(readFileSync(logPath, 'utf8').split(/\r?\n/), minutes);
if (!summary) {
  console.log(`Nenhuma linha 'ingest' com métricas de WS/HTTP em ${logPath} (o bot roda há menos de 1 min, ou é uma versão antiga).`);
  process.exit(1);
}
console.log(formatStatus(summary));
