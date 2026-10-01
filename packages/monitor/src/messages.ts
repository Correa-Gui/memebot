/**
 * Textos dos alertas (puros, texto simples — sem parse_mode, nada para escapar). Só dados públicos:
 * mint, símbolo, preços, tamanho/custo/PnL simulados do run (CLAUDE.md §3).
 */

/** Lamports → "0.012345 SOL" (6 casas, sem passar por float; arredonda para baixo em módulo). */
export function formatSol(lamports: bigint): string {
  const neg = lamports < 0n;
  const a = neg ? -lamports : lamports;
  const micro = a / 1_000n; // 1 SOL = 1e6 micro-SOL
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${frac} SOL`;
}

export function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return 'n/d';
  const pct = ratio * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function tokenLabel(mint: string, symbol: string | null): string {
  return symbol ? `${symbol} (${mint})` : mint;
}

function links(mint: string): string {
  return `https://pump.fun/coin/${mint}\nhttps://solscan.io/token/${mint}`;
}

export interface EntryAlert {
  mint: string;
  symbol: string | null;
  /** Lamports por unidade mínima do token (`realizedPriceLamportsPerUnit` do fill). */
  priceLamportsPerUnit: number;
  /** SOL pago à curva com as taxas da curva (`solIn`). */
  sizeLamports: bigint;
  /** Priority + tip + taxa base + rent (+ taxas da curva) desta entrada. */
  costLamports: bigint;
  costSource: string;
  mode: string;
}

export function formatEntryAlert(a: EntryAlert): string {
  return [
    `[${a.mode}] ENTRADA ${tokenLabel(a.mint, a.symbol)}`,
    `preço: ${a.priceLamportsPerUnit.toPrecision(6)} lamports/unidade`,
    `tamanho: ${formatSol(a.sizeLamports)}`,
    `custo estimado (taxas da curva + priority + tip + base + rent): ${formatSol(a.costLamports)} (origem: ${a.costSource})`,
    links(a.mint),
  ].join('\n');
}

export interface ExitAlert {
  mint: string;
  symbol: string | null;
  reason: string;
  /** Fração da posição vendida neste fill (da quantidade em carteira antes da venda). */
  fraction: number;
  priceLamportsPerUnit: number;
  /** PnL líquido realizado desta venda (alocação proporcional do custo de entrada). */
  pnlLamports: bigint;
  /** PnL líquido / custo alocado. */
  pnlRatio: number;
  closed: boolean;
  /** Só quando `closed`: PnL líquido da operação inteira. */
  operationPnlLamports: bigint | null;
  operationPnlRatio: number | null;
  mode: string;
}

export function formatExitAlert(a: ExitAlert): string {
  const lines = [
    `[${a.mode}] SAÍDA ${tokenLabel(a.mint, a.symbol)} — ${a.reason}`,
    `vendido: ${(a.fraction * 100).toFixed(0)}% da posição${a.closed ? ' (posição fechada)' : ''}`,
    `preço: ${a.priceLamportsPerUnit.toPrecision(6)} lamports/unidade`,
    `PnL líquido desta venda: ${formatSol(a.pnlLamports)} (${formatPct(a.pnlRatio)})`,
  ];
  if (a.closed && a.operationPnlLamports !== null) {
    lines.push(`PnL líquido da operação: ${formatSol(a.operationPnlLamports)} (${formatPct(a.operationPnlRatio ?? Number.NaN)})`);
  }
  lines.push(links(a.mint));
  return lines.join('\n');
}

export interface HourlySummary {
  mode: string;
  runId: string;
  fromMs: number;
  toMs: number;
  entries: number;
  closedOperations: number;
  winningOperations: number;
  netPnlLamports: bigint;
  runNetPnlLamports: bigint;
  openPositions: number;
  /** Tokens (mints distintos) rejeitados por motivo no período. */
  rejectionsByReason: ReadonlyMap<string, number>;
}

export function formatHourlySummary(s: HourlySummary): string {
  const hitRate = s.closedOperations > 0 ? `${((s.winningOperations / s.closedOperations) * 100).toFixed(0)}%` : 'n/d';
  const rejects = [...s.rejectionsByReason.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [
    `[${s.mode}] resumo ${new Date(s.fromMs).toISOString().slice(11, 16)}–${new Date(s.toMs).toISOString().slice(11, 16)} UTC (run ${s.runId})`,
    `entradas: ${String(s.entries)} | operações fechadas: ${String(s.closedOperations)} | acerto: ${hitRate}`,
    `PnL líquido na hora: ${formatSol(s.netPnlLamports)} | no run: ${formatSol(s.runNetPnlLamports)}`,
    `posições abertas: ${String(s.openPositions)}`,
    rejects.length > 0 ? 'tokens rejeitados por motivo:' : 'tokens rejeitados: 0',
    ...rejects.slice(0, 12).map(([reason, n]) => `  ${reason}: ${String(n)}`),
  ];
  return lines.join('\n');
}
