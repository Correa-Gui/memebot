import { bondingCurveBuy, bondingCurveSell, pumpSwapBuyExactQuoteIn, pumpSwapSell, type CurveFeeBps, type PumpSwapFeeBps } from '@memebot/curve-math';

export type WalletType = 'human probable' | 'bot probable' | 'sniper' | 'creator';
export type Market =
  | { venue: 'curve'; pool: string; quote: bigint; base: bigint; realQuote: bigint; realBase: bigint; fees: CurveFeeBps }
  | { venue: 'pumpswap'; pool: string; quote: bigint; base: bigint; virtualQuote: bigint; fees: PumpSwapFeeBps };
export interface Signal { trader: string; mint: string; signalMs: number; type: WalletType }
export function checkpointName(prefix: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]$/.test(prefix)) throw new Error('Invalid base58 prefix');
  return `outcomes-k${String(prefix.charCodeAt(0)).padStart(3, '0')}.json`;
}
export interface ObservedTrade { trader: string; side: 'buy' | 'sell'; amount: bigint; ms: number; id: string }
export interface Fill { ms: number; dueMs: number; side: 'buy' | 'sell'; reason: string; tokens: bigint; quote: bigint; dexFee: bigint; networkFee: bigint; venue: string; pool: string }
export interface Outcome extends Signal {
  delay: number; policy: 'mirror' | 'fixed'; status: 'closed' | 'no_entry' | 'censored' | 'unfilled';
  entryMs: number | null; exitMs: number | null; pnl: bigint; dexFees: bigint; networkFees: bigint;
  remaining: bigint; reason: string; unknownInventory: boolean; fills: Fill[];
}

export function buy(m: Market, budget: bigint): { tokens: bigint; cost: bigint; fee: bigint; after: Market } {
  if (m.venue === 'pumpswap') {
    const r = pumpSwapBuyExactQuoteIn({ base: m.base, quote: m.quote, virtualQuote: m.virtualQuote }, budget, m.fees);
    return { tokens: r.baseOut, cost: r.totalQuoteCost, fee: r.lpFee + r.protocolFee + r.creatorFee + r.cashbackFee, after: { ...m, ...r.reservesAfter } };
  }
  // Find the largest net input whose exact, rounded cost fits the common 0.05 SOL budget.
  let lo = 1n; let hi = budget; let net = 0n;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const r = bondingCurveBuy({ virtualQuote: m.quote, virtualToken: m.base }, mid, m.fees);
    if (r.totalQuoteCost <= budget) { net = mid; lo = mid + 1n; } else hi = mid - 1n;
  }
  if (net === 0n) throw new RangeError('budget_too_small');
  const r = bondingCurveBuy({ virtualQuote: m.quote, virtualToken: m.base }, net, m.fees);
  if (r.tokenOut <= 0n || r.tokenOut > m.realBase) throw new RangeError('curve_buy_liquidity');
  return { tokens: r.tokenOut, cost: r.totalQuoteCost, fee: r.protocolFee + r.creatorFee,
    after: { ...m, quote: r.reservesAfter.virtualQuote, base: r.reservesAfter.virtualToken, realQuote: m.realQuote + net, realBase: m.realBase - r.tokenOut } };
}

export function sell(m: Market, tokens: bigint): { quote: bigint; fee: bigint; after: Market } {
  if (m.venue === 'pumpswap') {
    const r = pumpSwapSell({ base: m.base, quote: m.quote, virtualQuote: m.virtualQuote }, tokens, m.fees);
    return { quote: r.netQuoteOut, fee: r.lpFee + r.protocolFee + r.creatorFee + r.cashbackFee, after: { ...m, ...r.reservesAfter } };
  }
  const r = bondingCurveSell({ virtualQuote: m.quote, virtualToken: m.base }, tokens, m.fees);
  if (r.quoteOutGross > m.realQuote || r.netQuoteOut < 0n) throw new RangeError('curve_sell_liquidity');
  return { quote: r.netQuoteOut, fee: r.protocolFee + r.creatorFee,
    after: { ...m, quote: r.reservesAfter.virtualQuote, base: r.reservesAfter.virtualToken, realQuote: m.realQuote - r.quoteOutGross, realBase: m.realBase + tokens } };
}

export function saleFraction(balance: bigint, amount: bigint): { numerator: bigint; denominator: bigint; unknown: boolean } {
  if (balance <= 0n || amount > balance) return { numerator: 1n, denominator: 1n, unknown: true };
  return { numerator: amount, denominator: balance, unknown: false };
}

interface Pending { due: number; numerator: bigint; denominator: bigint }
interface Position { out: Outcome; tokens: bigint; cost: bigint; cash: bigint; pending: Pending[]; enteredAtEvent: string | null; forceReason: string | null }
export class FollowSimulation {
  readonly positions: Position[];
  private balance: bigint;
  private started = false;
  private uncertain: boolean;
  private readonly signal: Signal;
  private readonly end: number;
  private readonly network: (ms: number) => bigint;
  constructor(signal: Signal, balance: bigint, uncertain: boolean, end: number, network: (ms: number) => bigint) {
    this.signal = signal; this.balance = balance; this.uncertain = uncertain; this.end = end; this.network = network;
    this.positions = [1, 5, 30].flatMap((delay) => (['mirror', 'fixed'] as const).map((policy) => ({
      out: { ...signal, delay, policy, status: 'no_entry', entryMs: null, exitMs: null, pnl: 0n, dexFees: 0n, networkFees: 0n,
        remaining: 0n, reason: 'no_executable_quote', unknownInventory: uncertain, fills: [] },
      tokens: 0n, cost: 0n, cash: 0n, pending: [], enteredAtEvent: null, forceReason: null,
    })));
  }

  observeLeader(t: ObservedTrade): void {
    if (t.trader !== this.signal.trader) return;
    if (t.side === 'buy') {
      this.balance += t.amount;
      if (!this.started && t.ms === this.signal.signalMs) this.started = true;
      return;
    }
    const f = saleFraction(this.balance, t.amount);
    this.uncertain ||= f.unknown;
    this.balance = this.balance > t.amount ? this.balance - t.amount : 0n;
    if (!this.started) return;
    for (const p of this.positions) {
      p.out.unknownInventory ||= this.uncertain;
      if (p.out.policy === 'mirror' && p.out.status !== 'closed') p.pending.push({ due: t.ms + p.out.delay * 1000, ...f });
    }
  }

  needsQuote(ms: number): boolean {
    return this.started && this.positions.some((p) => p.out.status !== 'closed' && p.out.status !== 'censored' && ms >= this.signal.signalMs + p.out.delay * 1000);
  }

  quote(ms: number, id: string, market: Market | null): void {
    if (!this.started || ms >= this.end || !market) return;
    for (const p of this.positions) {
      if (p.out.status === 'closed' || p.out.status === 'censored') continue;
      if (p.out.entryMs === null) {
        const due = this.signal.signalMs + p.out.delay * 1000;
        if (ms < due) continue;
        // A common 60-minute horizon for BOTH policies prevents a favorable short-exit cohort.
        if (ms + 3_600_000 >= this.end) { p.out.status = 'censored'; p.out.reason = 'entry_horizon_crosses_B'; continue; }
        try {
          const r = buy(market, 50_000_000n);
          p.tokens = r.tokens; p.cost = r.cost; p.out.entryMs = ms; p.out.status = 'unfilled'; p.enteredAtEvent = id;
          this.fill(p, { ms, dueMs: due, side: 'buy', reason: 'entry', tokens: r.tokens, quote: r.cost, dexFee: r.fee, networkFee: this.network(ms), venue: market.venue, pool: market.pool });
          // Queue sales that happened while entry waited; process against our own post-buy state.
          this.exits(p, ms, r.after, true);
        } catch (e) { if (!(e instanceof RangeError)) throw e; }
        continue;
      }
      if (p.enteredAtEvent !== id) this.exits(p, ms, market, false);
    }
  }

  private exits(p: Position, ms: number, market: Market, justEntered: boolean): void {
    if (p.out.entryMs === null || p.tokens === 0n) return;
    let m = market;
    const deadline = p.out.entryMs + (p.out.policy === 'mirror' ? 3_600_000 : 600_000);
    if (ms >= deadline) p.forceReason ??= 'timeout';
    if (!justEntered && p.forceReason === null) {
      try {
        const liquidation = sell(m, p.tokens).quote;
        const wealth = p.cash + liquidation - p.out.networkFees - this.network(ms);
        if (p.out.policy === 'mirror' && wealth * 100n <= p.cost * 50n) p.forceReason = 'stop50';
        if (p.out.policy === 'fixed' && wealth * 100n <= p.cost * 80n) p.forceReason = 'stop20';
        if (p.out.policy === 'fixed' && wealth * 100n >= p.cost * 140n) p.forceReason = 'take40';
      } catch (e) { if (!(e instanceof RangeError)) throw e; }
    }
    if (p.forceReason !== null) {
      this.exit(p, ms, p.forceReason === 'timeout' ? deadline : ms, m, p.tokens, p.forceReason);
      return;
    }
    while (p.out.policy === 'mirror' && p.pending[0] && p.pending[0].due <= ms && p.tokens > 0n) {
      const action = p.pending[0];
      const amount = action.numerator >= action.denominator ? p.tokens : p.tokens * action.numerator / action.denominator;
      if (amount === 0n) { p.pending.shift(); continue; }
      const next = this.exit(p, ms, action.due, m, amount, 'leader_sale');
      if (!next) break;
      m = next; p.pending.shift();
    }
  }

  private exit(p: Position, ms: number, due: number, m: Market, tokens: bigint, reason: string): Market | null {
    try {
      const r = sell(m, tokens);
      p.cash += r.quote; p.tokens -= tokens;
      this.fill(p, { ms, dueMs: due, side: 'sell', reason, tokens, quote: r.quote, dexFee: r.fee, networkFee: this.network(ms), venue: m.venue, pool: m.pool });
      if (p.tokens === 0n) { p.out.status = 'closed'; p.out.exitMs = ms; p.out.reason = reason; }
      return r.after;
    } catch (e) { if (!(e instanceof RangeError)) throw e; return null; }
  }
  private fill(p: Position, f: Fill): void { p.out.fills.push(f); p.out.dexFees += f.dexFee; p.out.networkFees += f.networkFee; }
  results(): Outcome[] {
    return this.positions.map((p) => ({ ...p.out, remaining: p.tokens, pnl: p.cash - p.cost - p.out.networkFees,
      reason: p.out.status === 'unfilled' ? 'no_executable_exit_before_B_end' : p.out.reason }));
  }
}

export function clusterCI(rows: readonly { mint: string; pnl: bigint }[], seed = 51934): { pnlSol: number; ci95Sol: [number, number] | null; mints: number } {
  const totals = new Map<string, bigint>();
  for (const r of rows) totals.set(r.mint, (totals.get(r.mint) ?? 0n) + r.pnl);
  const values = [...totals.values()].map((v) => Number(v) / 1e9);
  const boot: number[] = [];
  for (let b = 0; b < 2000 && values.length; b++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; sum += values[Math.floor(seed / 4294967296 * values.length)] ?? 0; }
    boot.push(sum);
  }
  boot.sort((a, b) => a - b);
  return { pnlSol: values.reduce((a, b) => a + b, 0), ci95Sol: boot.length ? [boot[49] ?? 0, boot[1949] ?? 0] : null, mints: values.length };
}
