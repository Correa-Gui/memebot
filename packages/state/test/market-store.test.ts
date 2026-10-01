import type { PumpEvent } from '@memebot/core';
import { describe, expect, it } from 'vitest';
import { applyEvent, createEmptyMarketState } from '../src/market-state.ts';
import { MarketStore, compactTokenState, compactionActionFor } from '../src/market-store.ts';
import type { CompactionPolicy } from '../src/market-store.ts';
import { curveTrade, getToken, poolCreated, pumpSwapTrade, tokenCreated } from './helpers.ts';

const MIN = 60_000;
const POLICY: CompactionPolicy = { fullStateMaxAgeMs: 15 * MIN, skeletonRetentionMs: 24 * 60 * MIN };

/** PRNG simples semeado (LCG) só para gerar sequências de eventos reprodutíveis no teste. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

function randomEvents(seed: number, n: number): PumpEvent[] {
  const rand = lcg(seed);
  const mints = ['m0', 'm1', 'm2', 'm3'];
  const events: PumpEvent[] = [];
  let ts = 1_000;
  for (let i = 0; i < n; i++) {
    ts += Math.floor(rand() * 500);
    const mint = mints[Math.floor(rand() * mints.length)] ?? 'm0';
    const r = rand();
    if (r < 0.05) events.push(tokenCreated({ mint, ts, creator: `c${String(Math.floor(rand() * 3))}` }));
    else if (r < 0.07) events.push({ kind: 'curve_completed', mint, bondingCurve: 'bc', slot: 1n, ts, sig: `cc${String(i)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: i, rawB64: '' });
    else if (r < 0.09) events.push(poolCreated({ pool: `pool-${mint}`, mint, ts }));
    else if (r < 0.15) events.push(pumpSwapTrade({ pool: `pool-${mint}`, ts, side: rand() < 0.5 ? 'buy' : 'sell', trader: `w${String(Math.floor(rand() * 10))}` }));
    else {
      events.push(curveTrade({
        mint, ts, side: rand() < 0.6 ? 'buy' : 'sell', trader: `w${String(Math.floor(rand() * 10))}`,
        tokenAmount: BigInt(1 + Math.floor(rand() * 1_000_000)), virtualQuoteReserves: BigInt(30_000_000_000 + Math.floor(rand() * 1e9)),
      }));
    }
  }
  return events;
}

describe('MarketStore', () => {
  it('equivalente a applyEvent: mesma sequência → mesmos tokens e poolToMint (200 sequências semeadas)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const events = randomEvents(seed, 120);
      const pure = events.reduce(applyEvent, createEmptyMarketState());
      const store = new MarketStore();
      for (const e of events) store.apply(e);
      expect(new Map(store.state.tokens)).toEqual(new Map(pure.tokens));
      expect(new Map(store.state.poolToMint)).toEqual(new Map(pure.poolToMint));
    }
  });

  it('apply devolve o mint afetado (null para tx_cost e PumpSwap sem pool conhecida)', () => {
    const store = new MarketStore();
    expect(store.apply(tokenCreated({ mint: 'a', ts: 1 }))).toBe('a');
    expect(store.apply(pumpSwapTrade({ pool: 'unknown', ts: 2, side: 'buy', trader: 'x' }))).toBeNull();
    expect(store.apply({ kind: 'tx_cost', slot: 1n, sig: 's', feeLamports: 5_000n, priorityFee: 0n, jitoTip: null, computeUnits: null, numSignatures: 1 })).toBeNull();
    store.apply(poolCreated({ pool: 'p', mint: 'a', ts: 3 }));
    expect(store.apply(pumpSwapTrade({ pool: 'p', ts: 4, side: 'buy', trader: 'x' }))).toBe('a');
  });

  it('seedSkeleton só insere mint ausente e guarda só criador/horário', () => {
    const store = new MarketStore();
    store.apply(tokenCreated({ mint: 'live', ts: 10, creator: 'alice' }));
    expect(store.seedSkeleton({ mint: 'live', creator: 'bob', createdAtMs: 5, createdAtSlot: 1n, quoteMint: null, tokenTotalSupply: null })).toBe(false);
    expect(getToken(store.state, 'live').creator).toBe('alice');
    expect(store.seedSkeleton({ mint: 'old', creator: 'bob', createdAtMs: 5, createdAtSlot: 7n, quoteMint: 'q', tokenTotalSupply: 9n })).toBe(true);
    const old = getToken(store.state, 'old');
    expect(old).toMatchObject({ creator: 'bob', createdAtMs: 5, createdAtSlot: 7n, venue: 'unknown', trades: [] });
    expect(old.creatorWallets.has('bob')).toBe(true);
  });
});

describe('compactação', () => {
  const now = 100 * MIN;
  const full = (createdAtMs: number) => {
    let s = applyEvent(createEmptyMarketState(), tokenCreated({ mint: 'm', ts: createdAtMs, creator: 'alice' }));
    s = applyEvent(s, curveTrade({ mint: 'm', ts: createdAtMs + 1, side: 'buy', trader: 'bob' }));
    return getToken(s, 'm');
  };

  it('dentro da janela: mantém; fora: compacta; > 24 h: remove; sem criação observada: remove', () => {
    expect(compactionActionFor(full(now - 5 * MIN), now, POLICY, false)).toBe('keep');
    expect(compactionActionFor(full(now - 20 * MIN), now, POLICY, false)).toBe('compact');
    expect(compactionActionFor(full(now - 25 * 60 * MIN), now, POLICY, false)).toBe('drop');
    const noCreation = getToken(applyEvent(createEmptyMarketState(), curveTrade({ mint: 'x', ts: 1, side: 'buy', trader: 'b' })), 'x');
    expect(compactionActionFor(noCreation, now, POLICY, false)).toBe('drop');
  });

  it('graduado compacta mesmo jovem; protegido (posição/ordem) nunca muda; compacto não recompacta', () => {
    const graduated = { ...full(now - MIN), curveCompleted: true };
    expect(compactionActionFor(graduated, now, POLICY, false)).toBe('compact');
    expect(compactionActionFor(full(now - 30 * 60 * MIN), now, POLICY, true)).toBe('keep');
    expect(compactionActionFor(compactTokenState(full(now - 20 * MIN)), now, POLICY, false)).toBe('keep');
  });

  it('compactTokenState mantém criador/horário/reservas e descarta trades, saldos e primeiros compradores', () => {
    const t = full(now - 20 * MIN);
    const c = compactTokenState(t);
    expect(c).toMatchObject({ mint: 'm', creator: 'alice', createdAtMs: t.createdAtMs, createdAtSlot: t.createdAtSlot, curveReserves: t.curveReserves, trades: [], firstBuyers: [] });
    expect(c.holderBalances.size).toBe(0);
    expect(t.trades).toHaveLength(1); // puro: não muta o original
  });

  it('MarketStore.compact aplica a política e respeita os protegidos', () => {
    const store = new MarketStore();
    store.apply(tokenCreated({ mint: 'young', ts: now - MIN }));
    store.apply(curveTrade({ mint: 'young', ts: now - MIN + 1, side: 'buy', trader: 'b' }));
    store.apply(tokenCreated({ mint: 'old', ts: now - 20 * MIN }));
    store.apply(curveTrade({ mint: 'old', ts: now - 20 * MIN + 1, side: 'buy', trader: 'b' }));
    store.apply(tokenCreated({ mint: 'held', ts: now - 20 * MIN }));
    store.apply(curveTrade({ mint: 'held', ts: now - 20 * MIN + 1, side: 'buy', trader: 'b' }));
    store.apply(curveTrade({ mint: 'orphan', ts: now, side: 'buy', trader: 'b' }));
    store.seedSkeleton({ mint: 'ancient', creator: 'c', createdAtMs: now - 25 * 60 * MIN, createdAtSlot: null, quoteMint: null, tokenTotalSupply: null });

    const r = store.compact(now, POLICY, (m) => m === 'held');
    expect(r).toEqual({ compacted: 1, dropped: 2 });
    expect([...store.state.tokens.keys()].sort()).toEqual(['held', 'old', 'young']);
    expect(getToken(store.state, 'old').trades).toHaveLength(0);
    expect(getToken(store.state, 'old').creator).toBe('creator-1');
    expect(getToken(store.state, 'young').trades).toHaveLength(1);
    expect(getToken(store.state, 'held').trades).toHaveLength(1);
  });
});
