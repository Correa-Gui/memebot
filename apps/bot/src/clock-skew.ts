/**
 * Desvio entre o relógio local e o tempo dos eventos: `received_at − ts` de cada evento do stream.
 * O `ts` é o `timestamp` on-chain (segundos inteiros, truncado: +0 a +1 s) e a entrega pelo WebSocket
 * leva de centenas de ms a ~2 s, então numa máquina com relógio certo a mediana fica em ~+1 a +2 s.
 * Mediana acima de `CLOCK_SKEW_ALERT_MS` (em módulo) = relógio local errado OU stream atrasado — os
 * dois merecem alerta. A estratégia não usa este valor (o "agora" vem do ts, ver `paper/clock.ts`).
 */
export const CLOCK_SKEW_ALERT_MS = 5_000;
/** Teto de amostras por minuto (o ingest tem ~15–20 mil eventos/min; acima disso a mediana já é estável). */
const MAX_SAMPLES = 50_000;

export interface ClockSkewStats {
  samples: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export class ClockSkewTracker {
  private samples: number[] = [];

  observe(receivedAtMs: number, ts: number): void {
    if (this.samples.length < MAX_SAMPLES) this.samples.push(receivedAtMs - ts);
  }

  /** Estatísticas do período (e zera); `null` sem nenhuma amostra. */
  take(): ClockSkewStats | null {
    const s = this.samples.sort((a, b) => a - b);
    this.samples = [];
    const n = s.length;
    if (n === 0) return null;
    const mid = Math.floor(n / 2);
    const median = n % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
    return { samples: n, medianMs: Math.round(median), minMs: s[0] ?? 0, maxMs: s[n - 1] ?? 0 };
  }
}

export type SkewTransition = { kind: 'high'; medianMs: number } | { kind: 'normal'; medianMs: number } | null;

/** Alerta uma vez quando a mediana passa de `thresholdMs` (em módulo) e uma vez quando volta. */
export class SkewAlarm {
  private high = false;
  private readonly thresholdMs: number;

  constructor(thresholdMs = CLOCK_SKEW_ALERT_MS) {
    this.thresholdMs = thresholdMs;
  }

  check(stats: ClockSkewStats | null): SkewTransition {
    if (!stats) return null;
    const over = Math.abs(stats.medianMs) > this.thresholdMs;
    if (over === this.high) return null;
    this.high = over;
    return over ? { kind: 'high', medianMs: stats.medianMs } : { kind: 'normal', medianMs: stats.medianMs };
  }
}
