/** Mensagens Telegram formatadas como HTML. Dados externos são sempre escapados. */

const FOUR_DECIMAL_LAMPORTS = 100_000n;

export interface TelegramMessage {
  text: string;
  reply_markup?: InlineKeyboardMarkup;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: { text: string; url: string }[][];
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Arredonda sem float para quatro casas decimais com vírgula. */
export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const magnitude = negative ? -lamports : lamports;
  const scaled = (magnitude + FOUR_DECIMAL_LAMPORTS / 2n) / FOUR_DECIMAL_LAMPORTS;
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${whole.toString()},${fraction} SOL`;
}

export function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return 'n/d';
  const pct = ratio * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1).replace('.', ',')}%`;
}

function formatUnsignedPct(ratio: number): string {
  return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1).replace('.', ',')}%` : 'n/d';
}

const SUBSCRIPT: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };

/** `priceLamportsPerUnit` é lamports por unidade mínima; tokens Pump.fun têm seis casas. */
export function formatTokenPrice(priceLamportsPerUnit: number): string {
  const solPerToken = priceLamportsPerUnit / 1_000;
  if (!(solPerToken > 0) || !Number.isFinite(solPerToken)) return 'n/d SOL/token';
  if (solPerToken >= 1) return `${solPerToken.toFixed(4).replace('.', ',')} SOL/token`;

  const [mantissa = '0', exponentText = '0'] = solPerToken.toExponential(2).split('e');
  const exponent = Number(exponentText);
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  if (exponent >= 0) {
    const decimals = Math.max(0, 2 - exponent);
    return `${solPerToken.toFixed(decimals).replace('.', ',')} SOL/token`;
  }
  const leadingZeros = -exponent - 1;
  if (leadingZeros === 0) return `0,${digits} SOL/token`;
  return `0,0${String(leadingZeros).replace(/\d/g, (digit) => SUBSCRIPT[digit] ?? digit)}${digits} SOL/token`;
}

function shortMint(mint: string): string {
  return mint.length <= 15 ? mint : `${mint.slice(0, 4)}…${mint.slice(-7)}`;
}

function tokenLabel(symbol: string | null): string {
  return symbol ? escapeHtml(symbol) : 'token';
}

function mintLine(mint: string): string {
  return `<b>Mint:</b> <code>${escapeHtml(shortMint(mint))}</code>`;
}

function nameLine(name: string | null): string[] {
  return name ? [`<b>Nome:</b> <code>${escapeHtml(name)}</code>`] : [];
}

function tokenButtons(mint: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: 'Pump.fun', url: `https://pump.fun/coin/${encodeURIComponent(mint)}` },
      { text: 'Solscan', url: `https://solscan.io/token/${encodeURIComponent(mint)}` },
    ]],
  };
}

function modeTag(mode: string): string {
  return `[${escapeHtml(mode)}]`;
}

export interface EntryAlert {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceLamportsPerUnit: number;
  sizeLamports: bigint;
  curveFeeLamports: bigint;
  priorityFeeLamports: bigint;
  jitoTipLamports: bigint;
  baseFeeLamports: bigint;
  rentLamports: bigint;
  tokenAgeMs: number | null;
  mode: string;
}

export function formatEntryAlert(a: EntryAlert): TelegramMessage {
  const transactionCosts = a.curveFeeLamports + a.priorityFeeLamports + a.jitoTipLamports + a.baseFeeLamports;
  const costRatio = a.sizeLamports > 0n ? Number(transactionCosts) / Number(a.sizeLamports) : Number.NaN;
  const lines = [
    `<b>🟢 COMPRA · ${tokenLabel(a.symbol)} ${modeTag(a.mode)}</b>`,
    mintLine(a.mint),
    ...nameLine(a.name),
    '',
    '<b>ENTRADA</b>',
    `• <b>Tamanho:</b> ${formatSol(a.sizeLamports)}`,
    `• <b>Preço:</b> ${formatTokenPrice(a.priceLamportsPerUnit)}`,
    `• <b>Idade do token:</b> ${a.tokenAgeMs === null ? 'n/d' : formatDuration(a.tokenAgeMs)}`,
    '',
    '<b>CUSTOS</b>',
    `• <b>Compra:</b> ${formatSol(transactionCosts)} (${formatUnsignedPct(costRatio)} do tamanho)`,
    `  Curva: ${formatSol(a.curveFeeLamports)}`,
    `  Priority: ${formatSol(a.priorityFeeLamports)}`,
    `  Tip: ${formatSol(a.jitoTipLamports)}`,
    `  Base: ${formatSol(a.baseFeeLamports)}`,
    `• <b>Rent:</b> ${formatSol(a.rentLamports)} (volta ao fechar)`,
  ];
  return { text: lines.join('\n'), reply_markup: tokenButtons(a.mint) };
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(remainder)}s` : `${String(remainder)}s`;
}

function portugueseReason(reason: string): string {
  const fixed: Record<string, string> = {
    stop_loss: 'stop loss',
    trailing_stop: 'trailing stop',
    time_stop: 'tempo esgotado',
    emergency_creator_sell: 'criador vendeu',
    emergency_large_sell: 'venda grande',
    graduated: 'token graduou',
  };
  if (fixed[reason]) return fixed[reason] ?? reason;
  const target = /^take_profit_(\d+)$/.exec(reason);
  if (target?.[1] === '1') return 'alvo 1';
  if (target?.[1] === '2') return 'alvo 2';
  return escapeHtml(reason);
}

export interface ExitAlert {
  mint: string;
  symbol: string | null;
  name: string | null;
  reason: string;
  fraction: number;
  remainingFraction: number;
  priceLamportsPerUnit: number;
  pnlLamports: bigint;
  pnlRatio: number;
  closed: boolean;
  operationPnlLamports: bigint | null;
  operationPnlRatio: number | null;
  heldMs: number;
  stopLossPct: number;
  mode: string;
}

export function formatExitAlert(a: ExitAlert): TelegramMessage {
  const resultLamports = a.closed ? (a.operationPnlLamports ?? a.pnlLamports) : a.pnlLamports;
  const resultRatio = a.closed ? (a.operationPnlRatio ?? a.pnlRatio) : a.pnlRatio;
  const partial = !a.closed;
  const kind = partial ? '🟡 VENDA PARCIAL' : resultLamports < 0n ? '🔴 VENDA (prejuízo)' : '🟢 VENDA (lucro)';
  const lines = [
    `<b>${kind} · ${tokenLabel(a.symbol)} ${modeTag(a.mode)}</b>`,
    mintLine(a.mint),
    ...nameLine(a.name),
    '',
    '<b>SAÍDA</b>',
    `• <b>Motivo:</b> ${portugueseReason(a.reason)}`,
    `• <b>Preço:</b> ${formatTokenPrice(a.priceLamportsPerUnit)}`,
    `• <b>PnL desta venda:</b> ${formatSol(a.pnlLamports)} (${formatPct(a.pnlRatio)})`,
    '',
    '<b>POSIÇÃO</b>',
    `• <b>Vendida agora:</b> ${formatUnsignedPct(a.fraction)} da posição atual`,
    `• <b>Restante:</b> ${formatUnsignedPct(a.remainingFraction)} da posição inicial`,
    `• <b>Tempo:</b> ${formatDuration(a.heldMs)}`,
  ];
  if (a.closed && a.operationPnlLamports !== null) {
    lines.push('', '<b>RESULTADO TOTAL DA OPERAÇÃO</b>', `• <b>PnL:</b> ${formatSol(a.operationPnlLamports)} (${formatPct(a.operationPnlRatio ?? Number.NaN)})`);
  }
  if (resultRatio < -(a.stopLossPct * 1.5)) {
    lines.push('', `⚠️ <b>Perda acima de 1,5× o stop:</b> configurado ${formatUnsignedPct(a.stopLossPct)}; resultado ${formatPct(resultRatio)}.`);
  }
  return { text: lines.join('\n'), reply_markup: tokenButtons(a.mint) };
}

export function formatAlertMessage(title: string, body: readonly string[], mode = 'paper'): TelegramMessage {
  const details = body.map((line) => {
    const separator = line.indexOf(':');
    if (separator <= 0) return `• ${escapeHtml(line)}`;
    return `• <b>${escapeHtml(line.slice(0, separator))}:</b> ${escapeHtml(line.slice(separator + 1).trim())}`;
  });
  return {
    text: [`<b>⚠️ ALERTA · ${escapeHtml(title)} ${modeTag(mode)}</b>`, ...(details.length > 0 ? ['', '<b>DETALHES</b>', ...details] : [])].join('\n'),
  };
}

export interface HourlyOperation {
  symbol: string | null;
  /** PnL líquido da operação / custo de entrada. */
  pnlRatio: number;
}

/** Resumo da última hora (enviado na virada de hora em BRT). Valores monetários em lamports. */
export interface HourlySummary {
  mode: string;
  runId: string;
  fromMs: number;
  toMs: number;
  openedOperations: number;
  closedOperations: number;
  winningOperations: number;
  netPnlLamports: bigint;
  runNetPnlLamports: bigint;
  /** Capital alocado (maxOpenPositions × tamanho) — base do PnL em %. */
  capitalLamports: bigint;
  best: HourlyOperation | null;
  worst: HourlyOperation | null;
  openPositions: number;
  /** Fills de venda da hora por motivo de saída. */
  exitsByReason: ReadonlyMap<string, number>;
  evaluatedTokens: number;
  rejectionsByReason: ReadonlyMap<string, number>;
  health: {
    streamGapMs: number;
    http429PerMin: number;
    priorityFeeLamports: bigint;
    jitoTipLamports: bigint;
    costSource: string;
  };
}

export interface ClosedTradePnl {
  symbol: string | null;
  pnlLamports: bigint;
}

export interface TradeBatchSummary {
  mode: string;
  firstOperation: number;
  lastOperation: number;
  trades: readonly ClosedTradePnl[];
}

/** Resumo visual de cada lote de dez operações encerradas. */
export function formatTradeBatchSummary(s: TradeBatchSummary): TelegramMessage {
  const winners = s.trades.filter((trade) => trade.pnlLamports > 0n);
  const losers = s.trades.filter((trade) => trade.pnlLamports < 0n);
  const breakEven = s.trades.length - winners.length - losers.length;
  const profit = winners.reduce((sum, trade) => sum + trade.pnlLamports, 0n);
  const loss = losers.reduce((sum, trade) => sum + trade.pnlLamports, 0n);
  const net = s.trades.reduce((sum, trade) => sum + trade.pnlLamports, 0n);
  const maxMagnitude = s.trades.reduce((max, trade) => {
    const magnitude = trade.pnlLamports < 0n ? -trade.pnlLamports : trade.pnlLamports;
    return magnitude > max ? magnitude : max;
  }, 0n);
  const signedSol = (lamports: bigint): string => `${lamports > 0n ? '+' : ''}${formatSol(lamports)}`;
  const rows = s.trades.map((trade, index) => {
    const magnitude = trade.pnlLamports < 0n ? -trade.pnlLamports : trade.pnlLamports;
    const cells = maxMagnitude > 0n ? Math.max(1, Number((magnitude * 10n) / maxMagnitude)) : 1;
    const bar = trade.pnlLamports > 0n ? '🟩'.repeat(cells)
      : trade.pnlLamports < 0n ? '🟥'.repeat(cells)
        : '🟨';
    const label = trade.symbol ? ` · ${escapeHtml(Array.from(trade.symbol).slice(0, 16).join(''))}` : '';
    return `${String(index + 1).padStart(2, '0')} ${bar} ${signedSol(trade.pnlLamports)}${label}`;
  });
  const operationRange = `${String(s.firstOperation)}–${String(s.lastOperation)}`;
  return {
    text: [
      `<b>📊 PnL · OPERAÇÕES ${operationRange} ${modeTag(s.mode)}</b>`,
      '',
      '<b>RESULTADO DO LOTE</b>',
      `• <b>Lucros:</b> ${String(winners.length)} operações · ${signedSol(profit)}`,
      `• <b>Prejuízos:</b> ${String(losers.length)} operações · ${formatSol(loss)}`,
      ...(breakEven > 0 ? [`• <b>Empates:</b> ${String(breakEven)}`] : []),
      `• <b>Saldo líquido:</b> ${signedSol(net)}`,
      '',
      '<b>PnL POR OPERAÇÃO</b>',
      ...rows,
    ].join('\n'),
  };
}

const EXIT_LABELS: Record<string, string> = {
  stop_loss: 'stop',
  take_profit_1: 'alvo 1',
  take_profit_2: 'alvo 2',
  trailing_stop: 'trailing',
  time_stop: 'tempo',
  emergency_large_sell: 'emergência',
  emergency_creator_sell: 'emergência',
  graduated: 'graduou',
};

/** HH:MM em Brasília (UTC−3 fixo; o Brasil não tem horário de verão desde 2019). */
export function formatBrtHourMinute(ms: number): string {
  const d = new Date(ms - 3 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function pctOf(lamports: bigint, base: bigint): string {
  return base > 0n ? formatPct(Number(lamports) / Number(base)) : 'n/d';
}

function opLabel(op: HourlyOperation | null): string {
  if (!op) return '—';
  const sym = op.symbol ? escapeHtml(Array.from(op.symbol).slice(0, 12).join('')) : 'token';
  return `${sym} ${formatPct(op.pnlRatio)}`;
}

/** Curto (cabe numa tela de celular). Só dados públicos; símbolos/motivos escapados. */
export function formatHourlySummary(s: HourlySummary): TelegramMessage {
  const losses = s.closedOperations - s.winningOperations;
  const exits = new Map<string, number>();
  for (const [reason, n] of s.exitsByReason) {
    const label = EXIT_LABELS[reason] ?? reason;
    exits.set(label, (exits.get(label) ?? 0) + n);
  }
  const exitText = exits.size > 0 ? [...exits].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${escapeHtml(k)} ${String(n)}`).join(' · ') : '—';
  const top = [...s.rejectionsByReason].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
  const topText = top ? `${escapeHtml(top[0])} (${String(top[1])})` : '—';
  const gapS = Math.round(s.health.streamGapMs / 1_000);
  return {
    text: [
      `<b>📊 RESUMO ${formatBrtHourMinute(s.fromMs)}–${formatBrtHourMinute(s.toMs)} BRT ${modeTag(s.mode)}</b>`,
      `• <b>Operações:</b> ${String(s.openedOperations)} abertas · ${String(s.closedOperations)} fechadas (${String(s.winningOperations)}✅ ${String(losses)}❌)`,
      `• <b>PnL hora:</b> ${formatSol(s.netPnlLamports)} (${pctOf(s.netPnlLamports, s.capitalLamports)})`,
      `• <b>PnL run:</b> ${formatSol(s.runNetPnlLamports)} (${pctOf(s.runNetPnlLamports, s.capitalLamports)})`,
      `• <b>Melhor/pior:</b> ${opLabel(s.best)} / ${opLabel(s.worst)}`,
      `• <b>Saídas:</b> ${exitText}`,
      `• <b>Abertas agora:</b> ${String(s.openPositions)}`,
      `• <b>Avaliados:</b> ${String(s.evaluatedTokens)} · <b>mais rejeitou:</b> ${topText}`,
      `• <b>Saúde:</b> sem stream ${String(gapS)}s · 429 ${s.health.http429PerMin.toFixed(1).replace('.', ',')}/min · custo ${formatSol(s.health.priorityFeeLamports + s.health.jitoTipLamports)}/tx (${escapeHtml(s.health.costSource)})`,
    ].join('\n'),
  };
}
