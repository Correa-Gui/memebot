import type { Logger } from '@memebot/core';
import type { Row, TableName } from './rows.ts';

export type InsertFn = (table: TableName, rows: Row[]) => Promise<void>;

export interface BatchWriterOptions {
  insert: InsertFn;
  logger: Logger;
  flushIntervalMs?: number;
  maxBatchRows?: number;
  /** Teto de memória: acima disso as linhas mais antigas são descartadas (e contadas) se o banco estiver fora. */
  maxBufferedRows?: number;
}

export interface WriterStats {
  written: number;
  failedFlushes: number;
  dropped: number;
  buffered: number;
}

/**
 * Buffer por tabela com flush a cada `flushIntervalMs` ou quando acumula `maxBatchRows`.
 * Se o insert falhar, as linhas ficam no buffer e entram no próximo flush (nada é perdido
 * enquanto couber em `maxBufferedRows`). Um flush por vez.
 */
export class BatchWriter {
  readonly stats: WriterStats = { written: 0, failedFlushes: 0, dropped: 0, buffered: 0 };
  private readonly o: Required<BatchWriterOptions>;
  private readonly buffers = new Map<TableName, Row[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(opts: BatchWriterOptions) {
    this.o = { flushIntervalMs: 1_000, maxBatchRows: 1_000, maxBufferedRows: 200_000, ...opts };
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.o.flushIntervalMs);
  }

  add(table: TableName, row: Row): void {
    let buf = this.buffers.get(table);
    if (!buf) {
      buf = [];
      this.buffers.set(table, buf);
    }
    buf.push(row);
    this.stats.buffered++;
    if (this.stats.buffered > this.o.maxBufferedRows) this.dropOldest();
    if (this.stats.buffered >= this.o.maxBatchRows) void this.flush();
  }

  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    if (this.stats.buffered > 0) await this.flush();
  }

  private async doFlush(): Promise<void> {
    for (const [table, rows] of this.buffers) {
      if (rows.length === 0) continue;
      const batch = rows.splice(0, rows.length);
      try {
        await this.o.insert(table, batch);
        this.stats.written += batch.length;
        this.stats.buffered -= batch.length;
      } catch (e) {
        rows.unshift(...batch);
        this.stats.failedFlushes++;
        this.o.logger.error({ table, rows: batch.length, err: e instanceof Error ? e.message : String(e) }, 'insert no ClickHouse falhou; mantendo no buffer');
        return;
      }
    }
  }

  private dropOldest(): void {
    const largest = [...this.buffers.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (!largest) return;
    const n = Math.max(1, Math.floor(largest[1].length / 10));
    largest[1].splice(0, n);
    this.stats.buffered -= n;
    this.stats.dropped += n;
    this.o.logger.error({ table: largest[0], dropped: n, totalDropped: this.stats.dropped }, 'buffer cheio (banco indisponível?): linhas descartadas');
  }
}
