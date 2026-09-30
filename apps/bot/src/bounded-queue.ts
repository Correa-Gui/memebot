/**
 * Fila com limite de concorrência e de tamanho. Tarefas acima do limite de tamanho são recusadas
 * (o chamador registra), para um pico de criações de token não acumular memória sem limite.
 */
export class BoundedQueue {
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private running = 0;
  private readonly queue: (() => Promise<void>)[] = [];
  private idleWaiters: (() => void)[] = [];

  constructor(concurrency: number, maxQueued: number) {
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
  }

  /** false se a fila estava cheia e a tarefa foi recusada. */
  push(task: () => Promise<void>): boolean {
    if (this.queue.length >= this.maxQueued) return false;
    this.queue.push(task);
    this.pump();
    return true;
  }

  get size(): number {
    return this.queue.length + this.running;
  }

  onIdle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const task = this.queue.shift();
      if (!task) break;
      this.running++;
      void task()
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.pump();
          if (this.size === 0) {
            this.idleWaiters.forEach((r) => {
              r();
            });
            this.idleWaiters = [];
          }
        });
    }
  }
}
