import type { PumpEvent, PumpSwapTradeEvent, CurveTradeEvent } from '@memebot/core';

const WINDOW_MS = 24 * 60 * 60_000;
const BUY_WINDOW_MS = 60_000;
const MIN_CLOSED_POSITIONS = 5;
const MIN_WIN_RATE = 0.5;
const SOL = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';

type Trade = CurveTradeEvent | PumpSwapTradeEvent;
interface Position { tokens: bigint; cost: bigint; realized: bigint; }
interface Outcome { ts: number; pnl: bigint; prefixPnl: bigint; prefixWins: number; }
interface WalletState {
  positions: Map<string, Position>;
  outcomes: Outcome[];
  outcomeHead: number;
  basePnl: bigint;
  baseWins: number;
}
interface OutcomeRef { wallet: string; outcome: Outcome; }
interface BuyerSignal { mint: string; wallet: string; ts: number; score: number; trades: number; winRate: number; }

function positive(value: bigint): bigint { return value > 0n ? value : 0n; }
function cashFlow(e: Trade): bigint {
  if (e.venue === 'pumpswap') {
    const userQuote = e.userQuoteAmount;
    if (userQuote > 0n) return e.side === 'buy' ? -userQuote : userQuote;
    const fees = e.lpFee + e.protocolFee + e.creatorFee;
    const amount = e.side === 'buy' ? e.quoteAmount + fees : positive(e.quoteAmount - fees);
    return e.side === 'buy' ? -amount : amount;
  }
  const amount = e.side === 'buy'
    ? e.quoteAmount + e.protocolFee + e.creatorFee
    : positive(e.quoteAmount - e.protocolFee - e.creatorFee);
  return e.side === 'buy' ? -amount : amount;
}

/**
 * Causal rolling wallet history for ML features. A wallet is qualified only after five fully closed
 * token positions in the preceding 24 hours, with positive realized PnL and a win rate above 50%.
 * DEX fees are included in cash flows; network fees are intentionally not estimated here.
 */
/**
 * Causal rolling wallet history for ML features. Qualification requires five fully closed positions
 * in the preceding 24 hours, positive realized PnL, and a win rate above 50%. DEX fees are included;
 * network fees are omitted because the stored tx_costs samples are not linked to every market trade.
 */
export class SmartMoneyTracker {
  private readonly wallets = new Map<string, WalletState>();
  private readonly expiries: OutcomeRef[] = [];
  private outcomeHead = 0;
  private readonly buyersByMint = new Map<string, BuyerSignal[]>();
  private readonly buyerExpiries: BuyerSignal[] = [];
  private buyerHead = 0;

  seed(event: PumpEvent): void { this.update(event); }

  onEvent(event: PumpEvent): void { this.update(event); }

  private update(event: PumpEvent): void {
    if (event.kind !== 'trade' || event.trader === '' || event.mint === '' || (event.quoteMint !== SOL && event.quoteMint !== WSOL)) return;
    this.expire(event.ts);
    const wallet = this.wallets.get(event.trader);
    if (event.side === 'buy') {
      const prior = this.scoreAt(event.trader, event.ts);
      const signal: BuyerSignal = { mint: event.mint, wallet: event.trader, ts: event.ts, score: prior.score, trades: prior.trades, winRate: prior.winRate };
      const list = this.buyersByMint.get(event.mint) ?? [];
      list.push(signal);
      this.buyersByMint.set(event.mint, list);
      this.buyerExpiries.push(signal);
    }

    const quantity = event.tokenAmount;
    if (quantity <= 0n) return;
    if (event.side === 'buy') {
      const state = wallet ?? this.wallet(event.trader);
      const flow = cashFlow(event);
      const position = state.positions.get(event.mint) ?? { tokens: 0n, cost: 0n, realized: 0n };
      position.tokens += quantity;
      position.cost += -flow;
      state.positions.set(event.mint, position);
      return;
    }
    if (!wallet) return;
    const position = wallet.positions.get(event.mint);
    if (!position || position.tokens <= 0n) return;
    const sold = quantity < position.tokens ? quantity : position.tokens;
    const proceeds = (cashFlow(event) * sold) / quantity;
    const basis = (position.cost * sold) / position.tokens;
    position.tokens -= sold;
    position.cost -= basis;
    position.realized += proceeds - basis;
    if (position.tokens === 0n) {
      wallet.positions.delete(event.mint);
      this.addOutcome(event.trader, wallet, event.ts, position.realized);
    }
  }

  private wallet(address: string): WalletState {
    let value = this.wallets.get(address);
    if (!value) {
      value = { positions: new Map(), outcomes: [], outcomeHead: 0, basePnl: 0n, baseWins: 0 };
      this.wallets.set(address, value);
    }
    return value;
  }

  private addOutcome(address: string, wallet: WalletState, ts: number, pnl: bigint): void {
    const last = wallet.outcomes.at(-1);
    const outcome: Outcome = {
      ts, pnl,
      prefixPnl: (last?.prefixPnl ?? wallet.basePnl) + pnl,
      prefixWins: (last?.prefixWins ?? wallet.baseWins) + (pnl > 0n ? 1 : 0),
    };
    wallet.outcomes.push(outcome);
    this.expiries.push({ wallet: address, outcome });
    if (wallet.outcomeHead > 256 && wallet.outcomeHead * 2 > wallet.outcomes.length) {
      wallet.basePnl = wallet.outcomes[wallet.outcomeHead - 1]?.prefixPnl ?? wallet.basePnl;
      wallet.baseWins = wallet.outcomes[wallet.outcomeHead - 1]?.prefixWins ?? wallet.baseWins;
      wallet.outcomes = wallet.outcomes.slice(wallet.outcomeHead);
      wallet.outcomeHead = 0;
    }
  }

  private expire(now: number): void {
    const cutoff = now - WINDOW_MS - 120_000;
    while (this.outcomeHead < this.expiries.length) {
      const ref = this.expiries[this.outcomeHead];
      if (!ref || ref.outcome.ts >= cutoff) break;
      const w = this.wallets.get(ref.wallet);
      if (w?.outcomes[w.outcomeHead] === ref.outcome) w.outcomeHead += 1;
      if (w && w.positions.size === 0 && w.outcomeHead >= w.outcomes.length) this.wallets.delete(ref.wallet);
      this.outcomeHead += 1;
    }
    while (this.buyerHead < this.buyerExpiries.length) {
      const signal = this.buyerExpiries[this.buyerHead];
      if (!signal || signal.ts >= now - BUY_WINDOW_MS - 120_000) break;
      const list = this.buyersByMint.get(signal.mint);
      if (list?.[0] === signal) {
        list.shift();
        if (list.length === 0) this.buyersByMint.delete(signal.mint);
      }
      this.buyerHead += 1;
    }
    if (this.outcomeHead > 20_000 && this.outcomeHead * 2 > this.expiries.length) {
      this.expiries.splice(0, this.outcomeHead);
      this.outcomeHead = 0;
    }
    if (this.buyerHead > 100_000 && this.buyerHead * 2 > this.buyerExpiries.length) {
      this.buyerExpiries.splice(0, this.buyerHead);
      this.buyerHead = 0;
    }
  }

  private scoreAt(address: string, t: number): { score: number; trades: number; winRate: number } {
    const wallet = this.wallets.get(address);
    if (!wallet) return { score: 0, trades: 0, winRate: 0 };
    const rows = wallet.outcomes;
    let end = rows.length;
    while (end > wallet.outcomeHead && (rows[end - 1]?.ts ?? t) >= t) end -= 1;
    let start = wallet.outcomeHead;
    const cutoff = t - WINDOW_MS;
    let lo = start;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((rows[mid]?.ts ?? Number.POSITIVE_INFINITY) < cutoff) lo = mid + 1;
      else hi = mid;
    }
    start = lo;
    const n = end - start;
    if (n <= 0) return { score: 0, trades: 0, winRate: 0 };
    const last = rows[end - 1];
    const before = start > 0 ? rows[start - 1] : undefined;
    const pnl = (last?.prefixPnl ?? wallet.basePnl) - (before?.prefixPnl ?? wallet.basePnl);
    const wins = (last?.prefixWins ?? wallet.baseWins) - (before?.prefixWins ?? wallet.baseWins);
    const winRate = wins / n;
    const pnlSol = Number(pnl) / 1_000_000_000;
    const score = n >= MIN_CLOSED_POSITIONS && pnl > 0n && winRate > MIN_WIN_RATE
      ? Math.min(10, Math.log1p(Math.max(0, pnlSol)) * winRate)
      : 0;
    return { score, trades: n, winRate };
  }

  features(mint: string, t: number): Record<string, number> {
    const current = this.buyersByMint.get(mint) ?? [];
    const recent = new Map<string, BuyerSignal>();
    for (const s of current) {
      if (s.ts < t - BUY_WINDOW_MS || s.ts >= t) continue;
      const old = recent.get(s.wallet);
      if (!old || old.ts <= s.ts) recent.set(s.wallet, s);
    }
    const rows = [...recent.values()];
    const qualified = rows.filter((s) => s.score > 0);
    const score = qualified.reduce((sum, s) => sum + s.score, 0);
    const meanWinRate = qualified.length ? qualified.reduce((sum, s) => sum + s.winRate, 0) / qualified.length : Number.NaN;
    return {
      smartMoneyBuyerCount60s: qualified.length,
      smartMoneyBuyerShare60s: rows.length ? qualified.length / rows.length : Number.NaN,
      smartMoneyScore60s: score,
      smartMoneyMaxScore60s: qualified.length ? Math.max(...qualified.map((s) => s.score)) : 0,
      smartMoneyMeanWinRate24h60s: meanWinRate,
      smartMoneyPriorClosedPositions24h60s: qualified.reduce((sum, s) => sum + s.trades, 0),
    };
  }
}
