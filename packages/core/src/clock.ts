import type { Clock } from './types.ts';

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  private currentSlot = 0n;

  slot(): bigint {
    return this.currentSlot;
  }

  setSlot(slot: bigint): void {
    this.currentSlot = slot;
  }
}

export class SimulatedClock implements Clock {
  private currentMs: number;
  private currentSlot: bigint;

  constructor(startMs: number, startSlot: bigint) {
    this.currentMs = startMs;
    this.currentSlot = startSlot;
  }

  nowMs(): number {
    return this.currentMs;
  }

  slot(): bigint {
    return this.currentSlot;
  }

  advanceTo(ms: number, slot: bigint): void {
    this.currentMs = ms;
    this.currentSlot = slot;
  }
}
