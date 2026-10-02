import type { TxCostEstimate } from '@memebot/execution';
import { formatAlertMessage, formatSol } from '@memebot/monitor';
import type { TelegramMessage } from '@memebot/monitor';

/** Horário de Brasília: UTC−3 fixo (o Brasil não tem horário de verão desde 2019). */
const BRASILIA_OFFSET_MS = -3 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** "01/10/2026 19:56:25 (Brasília, UTC−3) (22:56:25 UTC)". */
export function formatBrasiliaTime(ms: number): string {
  const b = new Date(ms + BRASILIA_OFFSET_MS);
  const u = new Date(ms);
  const date = `${pad(b.getUTCDate())}/${pad(b.getUTCMonth() + 1)}/${String(b.getUTCFullYear())}`;
  const time = `${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}:${pad(b.getUTCSeconds())}`;
  const utc = `${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}:${pad(u.getUTCSeconds())}`;
  return `${date} ${time} (Brasília, UTC−3) (${utc} UTC)`;
}

export interface PaperStartInfo {
  runId: string;
  startedAtMs: number;
  configVersion: string;
  /** sha256 do YAML da estratégia (os primeiros 12 hex bastam para identificar). */
  configHash: string;
  sizeLamports: bigint;
  maxOpenPositions: number;
  costs: TxCostEstimate;
  latencyMs: number;
  failRate: number;
}

/** Texto do aviso "paper iniciado" (só dados públicos/do run). */
export function formatPaperStarted(i: PaperStartInfo): TelegramMessage {
  const c = i.costs;
  return formatAlertMessage('paper iniciado', [
    // rótulo explícito: formatAlertMessage negrita até o 1º ':' (sem ele, cortaria o horário)
    `hora: ${formatBrasiliaTime(i.startedAtMs)}`,
    `run: ${i.runId}`,
    `config: ${i.configVersion} (sha256 ${i.configHash.slice(0, 12)})`,
    `posição: ${formatSol(i.sizeLamports)} × até ${String(i.maxOpenPositions)} abertas`,
    `custos: priority ${formatSol(c.priorityFeeLamports)} (${c.priorityFeeSource}, ${String(c.prioritySampleCount)} amostras), ` +
      `tip ${formatSol(c.jitoTipLamports)} (${c.jitoTipSource}, ${String(c.tipSampleCount)} amostras)`,
    `latência simulada ${String(i.latencyMs)} ms, falha ${(i.failRate * 100).toFixed(0)}%`,
  ], 'paper');
}
