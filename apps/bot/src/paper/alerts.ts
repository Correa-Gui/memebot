/**
 * Peças puras dos alertas do paper (testáveis sem relógio real nem Telegram).
 *
 * Virada de hora em BRT: Brasília é UTC−3 fixo (sem horário de verão desde 2019) — deslocamento de
 * horas inteiras, então as viradas de hora BRT (01:00, 02:00…) coincidem com as viradas de hora UTC.
 */

const HOUR_MS = 3_600_000;

/** Próxima virada de hora (BRT = UTC, ver acima) estritamente depois de `nowMs`. */
export function nextHourBoundaryMs(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
}

/** Dispara uma vez por virada de hora; se o processo "dormir" várias horas, dispara uma vez e realinha. */
export class HourlyScheduler {
  private next: number;

  constructor(startMs: number) {
    this.next = nextHourBoundaryMs(startMs);
  }

  get nextMs(): number {
    return this.next;
  }

  /** `true` quando `nowMs` passou da virada agendada (e agenda a próxima a partir de `nowMs`). */
  due(nowMs: number): boolean {
    if (nowMs < this.next) return false;
    this.next = nextHourBoundaryMs(nowMs);
    return true;
  }
}

export type StreamTransition = { kind: 'down'; silentMs: number } | { kind: 'up'; silentMs: number } | null;

/**
 * Stream sem eventos por mais de `thresholdMs` → `down` (uma vez); quando volta a chegar evento →
 * `up` com o tempo total sem eventos. Antes do primeiro evento não alerta (ainda conectando).
 */
export class StreamWatch {
  private downSince: number | null = null;
  private readonly thresholdMs: number;

  constructor(thresholdMs = 60_000) {
    this.thresholdMs = thresholdMs;
  }

  check(nowMs: number, lastEventMs: number | null): StreamTransition {
    if (lastEventMs === null) return null;
    if (this.downSince === null) {
      if (nowMs - lastEventMs > this.thresholdMs) {
        this.downSince = lastEventMs;
        return { kind: 'down', silentMs: nowMs - lastEventMs };
      }
      return null;
    }
    if (lastEventMs > this.downSince) {
      const silentMs = lastEventMs - this.downSince;
      this.downSince = null;
      return { kind: 'up', silentMs };
    }
    return null;
  }
}

/** Marcador local do último run de paper (`data/paper-run.json`), para detectar queda/reinício. */
export interface RunMarker {
  runId: string;
  startedAtMs: number;
  cleanExit: boolean;
}

/** Linhas do alerta "bot caiu/reiniciou" se o run anterior não terminou com parada limpa. */
export function restartAlertLines(previous: RunMarker | null, nowMs: number): string[] | null {
  if (!previous || previous.cleanExit) return null;
  const minutes = Math.round((nowMs - previous.startedAtMs) / 60_000);
  return [
    `run anterior: ${previous.runId}`,
    `situação: terminou sem parada limpa (queda/kill) — iniciado há ${String(minutes)} min`,
    'ação: um NOVO run foi iniciado; o anterior fica incompleto',
  ];
}

export function parseRunMarker(text: string): RunMarker | null {
  try {
    const v = JSON.parse(text) as Partial<RunMarker>;
    if (typeof v.runId !== 'string' || typeof v.startedAtMs !== 'number' || typeof v.cleanExit !== 'boolean') return null;
    return { runId: v.runId, startedAtMs: v.startedAtMs, cleanExit: v.cleanExit };
  } catch {
    return null;
  }
}
