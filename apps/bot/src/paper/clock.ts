import { performance } from 'node:perf_hooks';
import type { Clock } from '@memebot/core';

/**
 * Relógio do paper ao vivo: o "agora" da estratégia (janelas de 60/120 s, idade do token, time stop)
 * vem do TEMPO DOS EVENTOS (`ts` on-chain), a mesma referência do replay — o relógio de parede da
 * máquina não entra (com o Windows 23 s adiantado, o relógio antigo `max(ts, parede − 2 s)` inflava a
 * idade dos tokens e encurtava as janelas).
 *
 * Para os ticks (saídas por tempo, preenchimentos) não pararem quando o stream fica em silêncio, o
 * tempo avança pelo relógio MONOTÔNICO local desde a chegada do último evento, com atraso `graceMs`:
 *
 *   nowMs = max(maior ts de evento visto, maior ts + (mono − mono da última chegada) − graceMs, último nowMs)
 *
 * Com o stream normal (vários eventos por segundo) o termo monotônico fica atrás do ts e o relógio é
 * exatamente o do replay (`event`); num silêncio > `graceMs` ele continua andando no ritmo real. O
 * relógio monotônico mede só intervalos — ajustes do relógio do sistema não afetam nada.
 *
 * `silenceMs()` (monotônico, tempo desde a última mensagem recebida) alimenta a detecção de stream
 * parado e o kill switch `stream_stale`, sem comparar com o ts dos eventos.
 */
export class PaperClock implements Clock {
  private lastEventTs: number | null = null;
  private lastReceiptMono: number | null = null;
  private last = Number.NEGATIVE_INFINITY;
  private readonly monoNow: () => number;
  private readonly graceMs: number;

  constructor(monoNow: () => number = () => performance.now(), graceMs = 2_000) {
    this.monoNow = monoNow;
    this.graceMs = graceMs;
  }

  /** Chegada de um evento do stream (qualquer ts; o relógio usa o maior). */
  observeEvent(ts: number): void {
    if (this.lastEventTs === null || ts > this.lastEventTs) this.lastEventTs = ts;
    this.lastReceiptMono = this.monoNow();
  }

  /** `false` até o primeiro evento: sem tempo de evento ainda (o adaptador não emite ticks). */
  get ready(): boolean {
    return this.lastEventTs !== null;
  }

  nowMs(): number {
    if (this.lastEventTs === null || this.lastReceiptMono === null) throw new Error('PaperClock sem nenhum evento observado');
    const idle = this.lastEventTs + (this.monoNow() - this.lastReceiptMono) - this.graceMs;
    this.last = Math.max(this.lastEventTs, idle, this.last);
    return this.last;
  }

  /** Tempo (monotônico) desde a chegada da última mensagem do stream; `null` antes da primeira. */
  silenceMs(): number | null {
    return this.lastReceiptMono === null ? null : this.monoNow() - this.lastReceiptMono;
  }

  slot(): bigint {
    return 0n;
  }
}
