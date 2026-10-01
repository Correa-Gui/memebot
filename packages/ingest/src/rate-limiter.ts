/**
 * Limitador assíncrono por taxa média: cada `acquire()` espera a sua vez, espaçando as chamadas em
 * `1000 / perSecond` ms (aceita fração: 0,1/s = uma a cada 10 s). Usado para caber num orçamento de
 * créditos de RPC (ex.: Helius free = 1M requisições/mês ≈ 0,38/s no total).
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAt = 0;

  constructor(perSecond: number, opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    if (!(perSecond > 0)) throw new RangeError('RateLimiter: perSecond deve ser > 0');
    this.intervalMs = 1_000 / perSecond;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async acquire(): Promise<void> {
    const t = this.now();
    const at = Math.max(t, this.nextAt);
    this.nextAt = at + this.intervalMs;
    if (at > t) await this.sleep(at - t);
  }
}
