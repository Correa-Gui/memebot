import { describe, expect, it } from 'vitest';
import { buy, sell, saleFraction, FollowSimulation, clusterCI, checkpointName, type Market, type Signal } from './follow-mirror-engine.ts';

const market: Market = { venue: 'curve', pool: 'mint', quote: 30_000_000_000n, base: 1_000_000_000_000n,
  realQuote: 20_000_000_000n, realBase: 800_000_000_000n, fees: { protocolFeeBps: 95n, creatorFeeBps: 30n } };
const signal: Signal = { trader: 'leader', mint: 'mint', signalMs: 1000, type: 'human probable' };
function simulation(end = 10_000_000): FollowSimulation {
  const s = new FollowSimulation(signal, 0n, false, end, () => 37_275n);
  s.observeLeader({ trader: 'leader', side: 'buy', amount: 100n, ms: 1000, id: 'source-buy' });
  return s;
}
function mirror(s: FollowSimulation) { return s.results().find((r) => r.delay === 1 && r.policy === 'mirror'); }

describe('exploratory mirror follow', () => {
  it('preserves all base58 batches on case-insensitive Windows filesystems', () => {
    const names = Array.from('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz').map((c) => checkpointName(c).toLowerCase());
    expect(new Set(names).size).toBe(58);
    expect(checkpointName('A')).not.toBe(checkpointName('a'));
  });
  it('sizes within the total budget and includes exact DEX fees and price impact', () => {
    const r = buy(market, 50_000_000n);
    expect(r.cost).toBeLessThanOrEqual(50_000_000n);
    expect(r.cost).toBeGreaterThanOrEqual(49_999_999n);
    expect(r.fee).toBeGreaterThan(0n);
    expect(sell(r.after, r.tokens).quote).toBeLessThan(r.cost);
  });
  it('uses observed inventory for fractions and flags insufficient history', () => {
    expect(saleFraction(100n, 25n)).toEqual({ numerator: 25n, denominator: 100n, unknown: false });
    expect(saleFraction(10n, 25n).unknown).toBe(true);
  });
  it('waits on entry and sale latency, mirrors successive fractions, and charges every fill', () => {
    const s = simulation();
    s.quote(1999, 'early', market); expect(mirror(s)?.entryMs).toBeNull();
    s.quote(2000, 'entry', market);
    const tokens = mirror(s)?.remaining ?? 0n;
    s.observeLeader({ trader: 'leader', side: 'sell', amount: 25n, ms: 3000, id: 'sell1' });
    s.quote(3999, 'not-due', market); expect(mirror(s)?.remaining).toBe(tokens);
    s.quote(4000, 'partial', market); expect(mirror(s)?.remaining).toBe(tokens - tokens / 4n);
    s.observeLeader({ trader: 'leader', side: 'sell', amount: 75n, ms: 5000, id: 'sell2' });
    s.quote(6000, 'full', market);
    expect(mirror(s)?.status).toBe('closed'); expect(mirror(s)?.remaining).toBe(0n);
    expect(mirror(s)?.networkFees).toBe(3n * 37_275n);
    expect(mirror(s)?.fills.map((f) => f.ms)).toEqual([2000, 4000, 6000]);
  });
  it('does not fill timeout on a quote from before the deadline', () => {
    const s = simulation(); s.quote(2000, 'entry', market); s.quote(3_601_999, 'before-timeout', market);
    expect(mirror(s)?.status).toBe('unfilled');
    s.quote(3_603_000, 'after-timeout', market);
    expect(mirror(s)?.reason).toBe('timeout'); expect(mirror(s)?.exitMs).toBe(3_603_000);
  });
  it('retains unfilled positions with zero residual valuation instead of manufacturing a close', () => {
    const s = simulation(); s.quote(2000, 'entry', market);
    const r = mirror(s);
    expect(r?.status).toBe('unfilled'); expect(r?.pnl).toBeLessThanOrEqual(-50_037_274n);
    expect(r?.exitMs).toBeNull();
  });
  it('stops after a gap at the executable price, not at a guaranteed -50%', () => {
    const s = simulation(); s.quote(2000, 'entry', market);
    s.quote(3000, 'crash', { ...market, quote: 3_000_000_000n, realQuote: 3_000_000_000n });
    expect(mirror(s)?.reason).toBe('stop50'); expect(mirror(s)?.pnl).toBeLessThan(-40_000_000n);
  });
  it('excludes late entry equally for mirror and fixed without inspecting their future exits', () => {
    const s = simulation(3_601_000); s.quote(2000, 'entry', market);
    expect(s.results().filter((x) => x.delay === 1).map((x) => x.status)).toEqual(['censored', 'censored']);
  });
  it('does not sell more than the remaining position when the leader adds inventory', () => {
    const s = simulation(); s.quote(2000, 'entry', market);
    const tokens = mirror(s)?.remaining ?? 0n;
    s.observeLeader({ trader: 'leader', side: 'buy', amount: 100n, ms: 3000, id: 'add' });
    s.observeLeader({ trader: 'leader', side: 'sell', amount: 100n, ms: 4000, id: 'half' });
    s.quote(5000, 'half-quote', market);
    expect(mirror(s)?.remaining).toBe(tokens - tokens / 2n);
  });
  it('resamples whole mint clusters deterministically', () => {
    const rows = [{ mint: 'a', pnl: 1_000_000_000n }, { mint: 'a', pnl: -1_000_000_000n }];
    expect(clusterCI(rows)).toEqual({ pnlSol: 0, ci95Sol: [0, 0], mints: 1 });
    expect(clusterCI([]).ci95Sol).toBeNull();
  });
});
