import type { Clock } from '@memebot/core';

/**
 * Relógio do paper ao vivo. O `ts` dos eventos é o timestamp on-chain (resolução de 1 s, chega
 * algumas centenas de ms depois); o executor e as janelas de features usam esse relógio de eventos.
 * Para os ticks (saídas por tempo, preenchimentos) não dependerem de chegar evento, o relógio avança
 * também pelo relógio de parede, com um atraso de `graceMs`:
 *
 *   nowMs = max(maior ts de evento visto, parede − graceMs, último nowMs devolvido)
 *
 * Com o stream normal, o ts dos eventos domina (parede − 2 s fica atrás dele); se o stream parar, o
 * tempo continua andando e o kill switch `stream_stale` dispara (30 s sem evento). Monotônico. O
 * replay (Fase 4) usará `SimulatedClock`, sem parede.
 */
export class PaperClock implements Clock {
  private lastEventTs = Number.NEGATIVE_INFINITY;
  private last = Number.NEGATIVE_INFINITY;
  private readonly wallNow: () => number;
  private readonly graceMs: number;

  constructor(wallNow: () => number = Date.now, graceMs = 2_000) {
    this.wallNow = wallNow;
    this.graceMs = graceMs;
  }

  observeEvent(ts: number): void {
    if (ts > this.lastEventTs) this.lastEventTs = ts;
  }

  nowMs(): number {
    this.last = Math.max(this.lastEventTs, this.wallNow() - this.graceMs, this.last);
    return this.last;
  }

  slot(): bigint {
    return 0n;
  }
}
