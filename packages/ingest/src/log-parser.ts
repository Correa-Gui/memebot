import { PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID } from '../../../config/protocol.ts';
import { BorshDecodeError } from './borsh.ts';
import { PUMP_AMM_IDL, PUMP_IDL, type DecodedEvent, type ProgramIdl } from './idl.ts';

/** Formato da notificação do `logsSubscribe` (campo `value`) mais o slot do `context`. */
export interface LogsNotification {
  slot: bigint;
  signature: string;
  err: unknown;
  logs: string[];
}

export interface ParsedProgramEvent extends DecodedEvent {
  program: string;
  /** Posição entre os eventos Pump/PumpSwap desta transação. */
  eventIndex: number;
  rawB64: string;
}

export interface ParseProblem {
  kind: 'parse_error' | 'unknown_event';
  program: string;
  detail: string;
  rawB64: string;
}

export interface ParsedLogs {
  signature: string;
  slot: bigint;
  failed: boolean;
  truncated: boolean;
  events: ParsedProgramEvent[];
  problems: ParseProblem[];
}

const IDL_BY_PROGRAM: ReadonlyMap<string, ProgramIdl> = new Map([
  [PUMP_FUN_PROGRAM_ID, PUMP_IDL],
  [PUMP_SWAP_PROGRAM_ID, PUMP_AMM_IDL],
]);

const INVOKE_RE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT_RE = /^Program (\w+) (?:success|failed)/;
const DATA_PREFIX = 'Program data: ';
// Mensagem do validador quando o log da transação passa do limite (10 KB por padrão).
const TRUNCATED = 'Log truncated';

/**
 * Extrai eventos Anchor das linhas `Program data:` de uma transação.
 * Cada linha é atribuída ao programa no topo da pilha de invocação: linhas emitidas por outros
 * programas são ignoradas, mesmo que o conteúdo imite um evento do Pump (evita eventos forjados).
 * Transações com erro são descartadas por inteiro (o estado foi revertido).
 */
export function parseLogs(n: LogsNotification): ParsedLogs {
  const out: ParsedLogs = {
    signature: n.signature,
    slot: n.slot,
    failed: n.err !== null && n.err !== undefined,
    truncated: false,
    events: [],
    problems: [],
  };
  if (out.failed) return out;

  const stack: string[] = [];
  for (const line of n.logs) {
    if (line === TRUNCATED) {
      out.truncated = true;
      break;
    }
    const invoke = INVOKE_RE.exec(line);
    if (invoke?.[1]) {
      stack.push(invoke[1]);
      continue;
    }
    const exit = EXIT_RE.exec(line);
    if (exit?.[1]) {
      if (stack[stack.length - 1] === exit[1]) stack.pop();
      continue;
    }
    if (!line.startsWith(DATA_PREFIX)) continue;

    const program = stack[stack.length - 1];
    const idl = program ? IDL_BY_PROGRAM.get(program) : undefined;
    if (!program || !idl) continue;

    const rawB64 = line.slice(DATA_PREFIX.length);
    const bytes = Buffer.from(rawB64, 'base64');
    try {
      const ev = idl.decodeEvent(bytes);
      if (!ev) {
        out.problems.push({ kind: 'unknown_event', program, rawB64, detail: 'discriminador fora do IDL' });
        continue;
      }
      out.events.push({ ...ev, program, eventIndex: out.events.length, rawB64 });
    } catch (e) {
      if (!(e instanceof BorshDecodeError)) throw e;
      out.problems.push({ kind: 'parse_error', program, rawB64, detail: e.message });
    }
  }
  return out;
}
