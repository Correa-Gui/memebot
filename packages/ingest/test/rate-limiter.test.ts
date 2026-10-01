import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limiter.ts';

describe('RateLimiter', () => {
  it('espaça as chamadas em 1000/perSecond ms (aceita fração)', async () => {
    let t = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(0.1, {
      now: () => t,
      sleep: (ms) => {
        waits.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([10_000, 10_000]);
    expect(t).toBe(20_000);
  });

  it('não acumula crédito depois de ócio (sem rajada)', async () => {
    let t = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(1, { now: () => t, sleep: (ms) => (waits.push(ms), Promise.resolve()) });
    await limiter.acquire();
    t = 60_000;
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([1_000]);
  });

  it('recusa taxa não positiva', () => {
    expect(() => new RateLimiter(0)).toThrow(RangeError);
  });
});
