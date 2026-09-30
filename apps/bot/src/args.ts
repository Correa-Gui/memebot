import { parseArgs } from 'node:util';

export interface BotArgs {
  mode: 'record' | 'paper' | 'live';
  /** Se definido: imprime os N primeiros eventos parseados (com link do Solscan) e sai, sem gravar. */
  debugEvents: number | null;
}

export function parseBotArgs(argv: string[]): BotArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      'debug-events': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const mode = values.mode ?? 'record';
  if (mode !== 'record' && mode !== 'paper' && mode !== 'live') {
    throw new Error(`--mode inválido: ${mode} (use record | paper | live)`);
  }
  let debugEvents: number | null = null;
  if (values['debug-events'] !== undefined) {
    // o valor é obrigatório (--debug-events=20); parseArgs recusa a flag sem valor
    const raw = values['debug-events'];
    debugEvents = Number(raw);
    if (!Number.isInteger(debugEvents) || debugEvents <= 0 || debugEvents > 1_000) {
      throw new Error(`--debug-events deve ser um inteiro entre 1 e 1000 (recebido: ${raw})`);
    }
  }
  return { mode, debugEvents };
}
