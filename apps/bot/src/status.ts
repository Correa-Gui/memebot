import { existsSync, readFileSync, statSync } from 'node:fs';
import { formatConfigSources, formatStatus, lastConfigSources, summarizeIngestLog } from './status-summary.ts';

// pnpm status [--log=<arquivo>] [--minutes=30]   (padrão: o log de record/paper modificado por último)
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k ?? '', v ?? ''];
  }),
);
const candidates = ['data/logs/memebot-record.out.log', 'data/logs/memebot-paper.out.log'].filter((f) => existsSync(f));
const newest = candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const logPath = args.get('log') || newest || 'data/logs/memebot-record.out.log';
const minutes = Number(args.get('minutes') || '30');
if (!Number.isInteger(minutes) || minutes <= 0) throw new Error('--minutes deve ser inteiro positivo');

const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
console.log(`Log: ${logPath}`);
console.log(formatConfigSources(lastConfigSources(lines)));
console.log('');
const summary = summarizeIngestLog(lines, minutes);
if (!summary) {
  console.log(`Nenhuma linha 'ingest' com métricas de WS/HTTP em ${logPath} (o bot roda há menos de 1 min, ou é uma versão antiga).`);
  process.exit(1);
}
console.log(formatStatus(summary));
