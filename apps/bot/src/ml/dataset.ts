import type { Lamports, PumpEvent } from '@memebot/core';
import { bondingCurveBuy, bondingCurveSell, marginalPrice } from '@memebot/curve-math';
import type { CurveFeeBps, CurveInitialParams } from '@memebot/curve-math';
import {
  buySellVolumeRatio60s,
  creatorHoldingPct,
  creatorInitialBuyPct,
  curveProgress,
  largestSingleSellPctSupply60s,
  priceAboveMean120s,
  sameSlotBuyPct,
  top10HolderPct,
  uniqueBuyers60s,
  uniqueHolderCount,
  volume60sSol,
} from '@memebot/features';
import { quoteInForBudget } from '@memebot/risk';
import { MarketStore, computeWindowStats } from '@memebot/state';
import type { TokenSkeleton, TokenState } from '@memebot/state';
import { SmartMoneyTracker } from './smart-money.ts';

/**
 * Dataset de ML (Fase 5, itens 1–2) gerado a partir dos eventos gravados, com o MESMO estado, as MESMAS
 * features e a MESMA matemática da curva do bot (nada reimplementado em Python). Puro: recebe eventos em
 * ordem (`compareReplayEvents`) e devolve linhas por callback; o I/O fica em `apps/bot/src/ml-dataset.ts`.
 *
 * Amostragem: para cada token da curva cuja criação é vista no período (e elegível — sem lacuna de gravação
 * na vida + horizonte), um ponto a cada `sampleEveryMs` (15 s) entre `minAgeMs` (30 s) e `maxAgeMs` (15 min)
 * de idade, só se houve trade do token no intervalo (t − 15 s, t] e a curva não completou.
 *
 * Features no instante t: só eventos com ts ≤ t (a amostra é resolvida ANTES de aplicar o primeiro evento
 * com ts > t). As 13 da v0 + agregados em janelas de 15/30/60/120/300 s + hora do dia (BRT).
 *
 * Rótulo (simulado, como o paper executor sem falhas sorteadas): compra de `sizeLamports` em t + latência
 * (estado com todos os eventos ≤ t + latência; `quoteInForBudget` + `bondingCurveBuy`), custos = MEDIANA
 * real de `tx_costs` (priority e tip) + taxa base + rent. A partir daí, a cada trade do token, PnL líquido
 * se vendesse tudo agora (mesma fórmula de `positions.netPnlRatio`): ≥ +tp → venda; ≤ −sl → venda; a
 * venda é preenchida no estado de (gatilho + latência). Sem gatilho em `horizonMs` (10 min) → venda no
 * estado do fim do horizonte (+ latência). Curva completou com o rótulo aberto → fecha no último preço da
 * curva (como o executor). Saídas: `hitTp` (1 = bateu +tp antes de −sl) e `netReturn` realizado.
 */

export const WINDOWS_SEC = [15, 30, 60, 120, 300] as const;

export interface DatasetOptions {
  curveParams: CurveInitialParams;
  fees: CurveFeeBps;
  /** Mediana real de priority fee e tip (lamports) no instante. */
  costsAt: (t: number) => { priority: Lamports; tip: Lamports };
  rentLamports: Lamports;
  baseFeeLamports: Lamports;
  sizeLamports: Lamports;
  latencyMs: number;
  tpPct: number;
  slPct: number;
  horizonMs: number;
  sampleEveryMs: number;
  minAgeMs: number;
  maxAgeMs: number;
  /** `false` = token não elegível (lacuna de gravação, aquecimento). */
  eligible: (mint: string, createdAtMs: number) => boolean;
  onRow: (row: DatasetRow) => void;
}

export interface DatasetRow {
  mint: string;
  createdAtMs: number;
  t: number;
  features: Record<string, number>;
  hitTp: number;
  netReturn: number;
  exitReason: string;
  holdSec: number;
  entryCostLamports: bigint;
  netPnlLamports: bigint;
  exitTs: number;
}

type Timer =
  | { due: number; seq: number; kind: 'sample'; mint: string }
  | { due: number; seq: number; kind: 'entry'; label: Label }
  | { due: number; seq: number; kind: 'exit'; label: Label }
  | { due: number; seq: number; kind: 'timeout'; label: Label };

interface Label {
  mint: string;
  createdAtMs: number;
  t: number;
  features: Record<string, number>;
  tokens: bigint;
  entryCost: bigint;
  entryTs: number;
  /** Custos de saída fixados na entrada (mediana do instante da compra). */
  exitCosts: bigint;
  state: 'pending_entry' | 'open' | 'exit_pending' | 'done';
  exitReason: string;
}

/** Heap mínimo por (due, seq): ordem determinística. */
class TimerHeap {
  private readonly h: Timer[] = [];
  get size(): number {
    return this.h.length;
  }
  peek(): Timer | undefined {
    return this.h[0];
  }
  push(t: Timer): void {
    const h = this.h;
    h.push(t);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(h[i] as Timer, h[p] as Timer)) break;
      [h[i], h[p]] = [h[p] as Timer, h[i] as Timer];
      i = p;
    }
  }
  pop(): Timer | undefined {
    const h = this.h;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && less(h[l] as Timer, h[m] as Timer)) m = l;
        if (r < h.length && less(h[r] as Timer, h[m] as Timer)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m] as Timer, h[i] as Timer];
        i = m;
      }
    }
    return top;
  }
}

function less(a: Timer, b: Timer): boolean {
  return a.due < b.due || (a.due === b.due && a.seq < b.seq);
}

const BRT_OFFSET_MS = 3 * 3_600_000;

export interface DatasetStats {
  events: number;
  tokensSampled: number;
  tokensIneligible: number;
  samplesNoTrade: number;
  samplesCompleted: number;
  rows: number;
  entryUnavailable: number;
}

export class DatasetBuilder {
  private readonly store = new MarketStore();
  private readonly smartMoney = new SmartMoneyTracker();
  private readonly timers = new TimerHeap();
  private seq = 0;
  private readonly openLabels = new Map<string, Set<Label>>();
  private readonly pendingSamples = new Map<string, number>();
  private readonly byCreator = new Map<string, { mint: string; at: number }[]>();
  private lastCompaction = Number.NEGATIVE_INFINITY;
  private fees: CurveFeeBps;
  private curveParams: CurveInitialParams;
  readonly stats: DatasetStats = { events: 0, tokensSampled: 0, tokensIneligible: 0, samplesNoTrade: 0, samplesCompleted: 0, rows: 0, entryUnavailable: 0 };
  private readonly o: DatasetOptions;

  constructor(o: DatasetOptions) {
    this.o = o;
    this.fees = o.fees;
    this.curveParams = o.curveParams;
  }

  setFees(fees: CurveFeeBps): void {
    this.fees = fees;
  }

  setCurveParams(p: CurveInitialParams): void {
    this.curveParams = p;
  }

  seedSkeletons(s: readonly TokenSkeleton[]): void {
    for (const x of s) {
      this.store.seedSkeleton(x);
      this.indexCreator(x.mint, x.creator, x.createdAtMs);
    }
  }

  onEvent(e: PumpEvent): void {
    if (e.kind === 'tx_cost') return;
    this.runTimers((due) => due < e.ts);
    const mint = this.store.apply(e);
    this.smartMoney.onEvent(e);
    this.stats.events++;
    if (mint === null) return;
    if (e.kind === 'token_created') {
      this.indexCreator(mint, e.creator, e.ts);
      if (!this.o.eligible(mint, e.ts)) {
        this.stats.tokensIneligible++;
      } else {
        this.stats.tokensSampled++;
        let n = 0;
        for (let age = this.o.minAgeMs; age <= this.o.maxAgeMs; age += this.o.sampleEveryMs) {
          this.push({ due: e.ts + age, seq: 0, kind: 'sample', mint });
          n++;
        }
        this.pendingSamples.set(mint, n);
      }
    }
    const labels = this.openLabels.get(mint);
    if (!labels) return;
    const token = this.store.state.tokens.get(mint);
    if (!token) return;
    if (e.kind === 'curve_completed') {
      for (const l of [...labels]) if (l.state === 'open' || l.state === 'exit_pending') this.close(l, token, e.ts, 'graduated');
      return;
    }
    if (e.kind !== 'trade' || e.venue !== 'curve') return;
    for (const l of labels) {
      if (l.state !== 'open') continue;
      const pnl = this.pnl(l, token);
      if (pnl === null) continue;
      if (pnl >= this.o.tpPct) this.scheduleExit(l, e.ts, 'take_profit');
      else if (pnl <= -this.o.slPct) this.scheduleExit(l, e.ts, 'stop_loss');
    }
    if (e.ts - this.lastCompaction >= 60_000) this.compact(e.ts);
  }

  /** Warm-up only: updates wallet history without changing the token/label market state. */
  seedSmartMoneyEvent(e: PumpEvent): void { this.smartMoney.seed(e); }

  /** Fim dos eventos: resolve o que restou (amostras sem horizonte completo são descartadas). */
  finish(endMs: number): void {
    this.runTimers((due) => due <= endMs);
  }

  private push(t: Timer): void {
    this.timers.push({ ...t, seq: ++this.seq });
  }

  private runTimers(isDue: (due: number) => boolean): void {
    for (let t = this.timers.peek(); t && isDue(t.due); t = this.timers.peek()) {
      this.timers.pop();
      this.fire(t);
    }
  }

  private fire(t: Timer): void {
    if (t.kind === 'sample') {
      this.sample(t.mint, t.due);
      const left = (this.pendingSamples.get(t.mint) ?? 1) - 1;
      if (left <= 0) this.pendingSamples.delete(t.mint);
      else this.pendingSamples.set(t.mint, left);
      return;
    }
    const l = t.label;
    const token = this.store.state.tokens.get(l.mint);
    if (t.kind === 'entry') {
      this.enter(l, token, t.due);
      return;
    }
    if (l.state === 'done' || !token) return;
    if (t.kind === 'timeout' && l.state === 'open') {
      this.scheduleExit(l, t.due, 'time_stop');
      return;
    }
    if (t.kind === 'exit' && l.state === 'exit_pending') this.close(l, token, t.due, l.exitReason);
  }

  private sample(mint: string, t: number): void {
    const token = this.store.state.tokens.get(mint);
    if (!token?.curveReserves || token.createdAtMs === null) return;
    if (token.curveCompleted || token.venue !== 'curve') {
      this.stats.samplesCompleted++;
      return;
    }
    const last = token.trades.at(-1);
    if (!last || last.ts <= t - this.o.sampleEveryMs) {
      this.stats.samplesNoTrade++;
      return;
    }
    const label: Label = {
      mint, createdAtMs: token.createdAtMs, t, features: this.features(token, t), tokens: 0n, entryCost: 0n, entryTs: 0, exitCosts: 0n,
      state: 'pending_entry', exitReason: '',
    };
    let set = this.openLabels.get(mint);
    if (!set) {
      set = new Set();
      this.openLabels.set(mint, set);
    }
    set.add(label);
    this.push({ due: t + this.o.latencyMs, seq: 0, kind: 'entry', label });
  }

  private enter(l: Label, token: TokenState | undefined, ts: number): void {
    if (!token?.curveReserves || token.curveCompleted || token.venue !== 'curve') {
      this.stats.entryUnavailable++;
      this.drop(l);
      return;
    }
    const quoteIn = quoteInForBudget(this.o.sizeLamports, this.fees);
    const sim = bondingCurveBuy({ virtualQuote: token.curveReserves.virtualQuote, virtualToken: token.curveReserves.virtualToken }, quoteIn, this.fees);
    if (sim.tokenOut <= 0n) {
      this.stats.entryUnavailable++;
      this.drop(l);
      return;
    }
    const c = this.o.costsAt(ts);
    l.tokens = sim.tokenOut;
    l.entryCost = sim.totalQuoteCost + c.priority + c.tip + this.o.baseFeeLamports + this.o.rentLamports;
    l.exitCosts = c.priority + c.tip + this.o.baseFeeLamports;
    l.entryTs = ts;
    l.state = 'open';
    this.push({ due: ts + this.o.horizonMs, seq: 0, kind: 'timeout', label: l });
  }

  /** Valor líquido de vender tudo agora (como `positions.liquidationValue`). */
  private liquidation(l: Label, token: TokenState): bigint | null {
    if (!token.curveReserves) return null;
    const out = bondingCurveSell({ virtualQuote: token.curveReserves.virtualQuote, virtualToken: token.curveReserves.virtualToken }, l.tokens, this.fees).netQuoteOut;
    return out - l.exitCosts + this.o.rentLamports;
  }

  private pnl(l: Label, token: TokenState): number | null {
    const v = this.liquidation(l, token);
    return v === null ? null : Number(v - l.entryCost) / Number(l.entryCost);
  }

  private scheduleExit(l: Label, ts: number, reason: string): void {
    l.state = 'exit_pending';
    l.exitReason = reason;
    this.push({ due: ts + this.o.latencyMs, seq: 0, kind: 'exit', label: l });
  }

  private close(l: Label, token: TokenState, ts: number, reason: string): void {
    const ret = this.pnl(l, token);
    l.state = 'done';
    this.drop(l);
    if (ret === null) return;
    this.stats.rows++;
    this.o.onRow({
      mint: l.mint, createdAtMs: l.createdAtMs, t: l.t, features: l.features, hitTp: reason === 'take_profit' ? 1 : 0, netReturn: ret, exitReason: reason,
      holdSec: (ts - l.entryTs) / 1000,
      entryCostLamports: l.entryCost, netPnlLamports: (this.liquidation(l, token) ?? l.entryCost) - l.entryCost, exitTs: ts,
    });
  }

  private drop(l: Label): void {
    const set = this.openLabels.get(l.mint);
    set?.delete(l);
    if (set?.size === 0) this.openLabels.delete(l.mint);
  }

  private compact(nowMs: number): void {
    this.lastCompaction = nowMs;
    const keepMs = this.o.maxAgeMs + this.o.horizonMs + 120_000;
    this.store.compact(nowMs, { fullStateMaxAgeMs: keepMs, skeletonRetentionMs: 24 * 3_600_000 }, (m) => this.openLabels.has(m) || this.pendingSamples.has(m));
  }

  /**
   * Mesma definição de `features.creatorTokensCreated24h` (outros tokens do mesmo criador criados em
   * [t − 24 h, t]), via índice por criador — a função da feature varre o mercado inteiro (dezenas de
   * milhares de tokens) e seria O(amostras × tokens) aqui. Equivalência coberta em teste.
   */
  private creatorTokens24h(token: TokenState, t: number): number {
    if (token.creator === null) return 0;
    let n = 0;
    for (const x of this.byCreator.get(token.creator) ?? []) if (x.mint !== token.mint && x.at >= t - 24 * 3_600_000 && x.at <= t) n++;
    return n;
  }

  private indexCreator(mint: string, creator: string, at: number): void {
    const list = this.byCreator.get(creator) ?? [];
    if (!list.some((x) => x.mint === mint)) list.push({ mint, at });
    this.byCreator.set(creator, list);
  }

  /** Features no instante t (só eventos ≤ t: a amostra roda antes do primeiro evento com ts > t). */
  private features(token: TokenState, t: number): Record<string, number> {
    const nz = (x: number | null): number => (x === null ? Number.NaN : x);
    const f: Record<string, number> = {
      ageSec: (t - (token.createdAtMs ?? t)) / 1000,
      curveProgress: curveProgress(token, this.curveParams),
      uniqueHolders: uniqueHolderCount(token),
      top10HolderPct: nz(top10HolderPct(token)),
      sameSlotBuyPct: nz(sameSlotBuyPct(token)),
      buySellVolumeRatio60s: nz(buySellVolumeRatio60s(token, t)),
      uniqueBuyers60s: uniqueBuyers60s(token, t),
      volume60sSol: volume60sSol(token, t),
      largestSingleSellPctSupply60s: nz(largestSingleSellPctSupply60s(token, t)),
      priceAboveMean120s: (() => {
        const v = priceAboveMean120s(token, t);
        return v === null ? Number.NaN : v ? 1 : 0;
      })(),
      creatorHoldingPct: nz(creatorHoldingPct(token)),
      creatorTokensCreated24h: this.creatorTokens24h(token, t),
      creatorInitialBuyPct: nz(creatorInitialBuyPct(token)),
      hourBrt: new Date(t - BRT_OFFSET_MS).getUTCHours(),
      tradesTotal: token.trades.length,
      ...this.smartMoney.features(token.mint, t),
    };
    const cur = token.curveReserves ? marginalPrice({ virtualQuote: token.curveReserves.virtualQuote, virtualToken: token.curveReserves.virtualToken }) : Number.NaN;
    f.marginalPrice = cur;
    const supply = token.tokenTotalSupply ?? 0n;
    // uma varredura reversa até a maior janela (300 s): preços marginais, do mais novo ao mais antigo
    const recent: { ts: number; p: number }[] = [];
    const maxW = WINDOWS_SEC[WINDOWS_SEC.length - 1] ?? 300;
    for (let i = token.trades.length - 1; i >= 0; i--) {
      const tr = token.trades[i];
      if (!tr) continue;
      if (tr.ts < t - maxW * 1000) break;
      if (tr.ts > t || tr.virtualQuoteAfter === null || tr.virtualTokenAfter === null || tr.virtualTokenAfter === 0n) continue;
      recent.push({ ts: tr.ts, p: Number(tr.virtualQuoteAfter) / Number(tr.virtualTokenAfter) });
    }
    for (const w of WINDOWS_SEC) {
      const s = computeWindowStats(token, t, w * 1000);
      const buy = Number(s.buyVolumeQuote) / 1e9;
      const sell = Number(s.sellVolumeQuote) / 1e9;
      f[`vol${String(w)}s`] = buy + sell;
      f[`buyVol${String(w)}s`] = buy;
      f[`sellVol${String(w)}s`] = sell;
      f[`netFlow${String(w)}s`] = buy - sell;
      f[`buyers${String(w)}s`] = s.uniqueBuyers;
      f[`sellers${String(w)}s`] = s.uniqueSellers;
      f[`trades${String(w)}s`] = s.buyCount + s.sellCount;
      f[`buySellRatio${String(w)}s`] = sell > 0 ? buy / sell : buy > 0 ? 99 : Number.NaN;
      f[`largestSellPct${String(w)}s`] = supply > 0n ? Number((s.largestSellToken * 1_000_000n) / supply) / 1_000_000 : Number.NaN;
      // preço marginal vs média e vs o início da janela (trades da janela com reservas registradas)
      let sum = 0;
      let n = 0;
      let first = Number.NaN;
      for (const x of recent) {
        if (x.ts < t - w * 1000) break;
        sum += x.p;
        n++;
        first = x.p; // `recent` vai do mais novo ao mais antigo: o último visitado é o mais antigo da janela
      }
      f[`priceVsMean${String(w)}s`] = n > 0 ? cur / (sum / n) - 1 : Number.NaN;
      f[`priceChange${String(w)}s`] = n > 0 ? cur / first - 1 : Number.NaN;
    }
    return f;
  }
}
