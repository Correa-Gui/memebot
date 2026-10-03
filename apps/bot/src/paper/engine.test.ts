import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { createLogger } from '@memebot/core';
import type { CurveTradeEvent, PumpEvent, PumpSwapTradeEvent, TokenCreatedEvent } from '@memebot/core';
import { parseCurveInitialParams } from '@memebot/curve-math';
import { estimateTxCosts, fillCashFlow } from '@memebot/execution';
import type { Fill } from '@memebot/execution';
import { LAMPORTS_PER_SIGNATURE } from '@memebot/ingest';
import type { DecisionRecord } from '@memebot/recorder';
import { HARD_LIMITS, buildEffectiveRiskLimits } from '@memebot/risk';
import { loadStrategyConfig } from '@memebot/strategy';
import type { StrategyV0Config } from '@memebot/strategy';
import { describe, expect, it } from 'vitest';
import { PaperClock } from './clock.ts';
import { PaperEngine, type PaperEngineOptions } from './engine.ts';

const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => { cb(); } }) });
const CONFIG = loadStrategyConfig(fileURLToPath(new URL('../../../../config/strategy.v0.yaml', import.meta.url)));
const CURVE = parseCurveInitialParams({
  initial_virtual_token_reserves: '1073000000000000', initial_virtual_sol_reserves: '30000000000', initial_real_token_reserves: '793100000000000',
});
const K = 30_000_000_000n * 1_073_000_000_000_000n;
const T0 = 1_790_000_000_000;
const SOL_QUOTE = '11111111111111111111111111111111';

let seq = 0;
function base(ts: number) {
  seq++;
  return { slot: BigInt(ts), ts, sig: `s${String(seq)}`, eventIndex: 0, receivedAtMs: ts, recvSeq: seq, rawB64: '' };
}
function created(mint: string, ts: number, creator = 'creator'): TokenCreatedEvent {
  return { kind: 'token_created', ...base(ts), mint, creator, name: 'N', symbol: `S${mint}`, uri: 'https://x', bondingCurve: 'bc', quoteMint: SOL_QUOTE, tokenTotalSupply: 1_000_000_000_000_000n };
}
function trade(mint: string, ts: number, vq: bigint, trader: string, side: 'buy' | 'sell' = 'buy', tokenAmount = 1_000_000_000_000n): CurveTradeEvent {
  return {
    kind: 'trade', venue: 'curve', ...base(ts), mint, trader, side, quoteMint: SOL_QUOTE, quoteAmount: 300_000_000n, tokenAmount,
    virtualQuoteReserves: vq, virtualTokenReserves: K / vq, realQuoteReserves: 0n, realTokenReserves: 0n, protocolFee: 0n, creatorFee: 0n, ixName: side,
  };
}

/** Token que passa em todos os filtros: 70 compradores distintos, 1 por segundo, preço subindo. */
function healthyToken(mint: string, t0: number, creator = 'creator'): PumpEvent[] {
  const events: PumpEvent[] = [created(mint, t0, creator)];
  for (let i = 1; i <= 70; i++) events.push(trade(mint, t0 + i * 1_000, 30_000_000_000n + BigInt(i) * 200_000_000n, `${mint}-w${String(i)}`));
  return events;
}

interface Harness {
  engine: PaperEngine;
  decisions: DecisionRecord[];
  fills: Fill[];
  notes: string[];
}

function harnessWith(extra: Pick<PaperEngineOptions, 'streamSilenceMs' | 'pumpSwapEnabled' | 'entriesFromMs'>, config?: StrategyV0Config): Harness {
  return harness(config ? { config } : {}, extra);
}

function harness(
  overrides: { failRate?: number; seed?: number; tradeAlerts?: boolean; config?: StrategyV0Config; killSwitchEnabled?: boolean } = {},
  extra: Pick<PaperEngineOptions, 'streamSilenceMs' | 'pumpSwapEnabled' | 'entriesFromMs'> = {},
): Harness {
  const decisions: DecisionRecord[] = [];
  const fills: Fill[] = [];
  const notes: string[] = [];
  const engine = new PaperEngine({
    runId: 'paper-test',
    config: overrides.config ?? CONFIG,
    limits: buildEffectiveRiskLimits(overrides.config ?? CONFIG),
    curveParams: CURVE,
    fees: { protocolFeeBps: 95n, creatorFeeBps: 30n },
    costs: estimateTxCosts([], { minSamples: 30, fallbackPriorityFeeLamports: 500_000n, fallbackJitoTipLamports: 500_000n }),
    latencyMs: 800,
    failRate: overrides.failRate ?? 0,
    tokenAccountRentLamports: 1_513_840n,
    baseFeeLamportsPerSignature: LAMPORTS_PER_SIGNATURE,
    seed: overrides.seed ?? 1,
    startMs: T0,
    sinks: { decision: (d) => decisions.push(d), fill: (f) => fills.push(f), notify: (m) => notes.push(m.text), log: silent },
    ...(overrides.tradeAlerts === undefined ? {} : { tradeAlerts: overrides.tradeAlerts }),
    ...(overrides.killSwitchEnabled === undefined ? {} : { killSwitchEnabled: overrides.killSwitchEnabled }),
    ...extra,
  });
  return { engine, decisions, fills, notes };
}

function run(h: Harness, events: readonly PumpEvent[], tickUntil?: number): void {
  for (const e of events) h.engine.onEvent(e, e.kind === 'tx_cost' ? 0 : e.ts);
  const last = events.at(-1);
  if (tickUntil !== undefined && last && last.kind !== 'tx_cost') {
    for (let t = last.ts + 1_000; t <= tickUntil; t += 1_000) h.engine.onTick(t);
  }
}

describe('PaperEngine — entrada', () => {
  it('token saudável: rejeita antes da idade mínima sem gravar linha, entra após 60 s, preenche com latência', () => {
    const h = harness();
    run(h, healthyToken('A', T0), T0 + 75_000);
    // nada gravado antes de 60 s (fora da janela de idade não é avaliado)
    expect(h.decisions.every((d) => d.ts >= T0 + 60_000)).toBe(true);
    const enters = h.decisions.filter((d) => d.type === 'enter');
    expect(enters).toHaveLength(1);
    expect(enters[0]?.reason).toBe('momentum_trigger');
    expect(enters[0]?.features).toMatchObject({ protocolFeeBps: 95, creatorFeeBps: 30, costEstimateSource: 'priority:fallback/tip:fallback' });
    const buy = h.fills.find((f) => f.side === 'buy');
    expect(buy).toMatchObject({ status: 'filled', baseFee: LAMPORTS_PER_SIGNATURE, rent: 1_513_840n, decisionId: enters[0]?.decisionId });
    expect(buy?.solIn).toBeLessThanOrEqual(HARD_LIMITS.maxPositionLamports);
    expect(h.engine.openPositions).toHaveLength(1);
    expect(h.notes.some((n) => n.includes('<b>\u{1F7E2} COMPRA \u00b7 SA [paper]</b>'))).toBe(true);
  });

  it('rejeições deduplicadas: uma linha por mudança de motivo, contagem por mint distinto', () => {
    const h = harness();
    // poucos compradores: sempre minUniqueHolders
    const events: PumpEvent[] = [created('B', T0)];
    for (let i = 1; i <= 90; i++) events.push(trade('B', T0 + i * 1_000, 30_000_000_000n + BigInt(i) * 10_000_000n, `w${String(i % 5)}`));
    run(h, events);
    const rejects = h.decisions.filter((d) => d.mint === 'B');
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({ type: 'reject', reason: 'minUniqueHolders' });
    const stats = h.engine.takeMinuteStats();
    expect(stats.rejectedMintsByReason.get('minUniqueHolders')?.size).toBe(1);
  });

  it('avaliação limitada a 1×/s por mint (vários trades no mesmo segundo → 1 avaliação)', () => {
    const h = harness();
    const events: PumpEvent[] = [created('C', T0)];
    for (let i = 0; i < 50; i++) events.push(trade('C', T0 + 61_000, 30_000_000_000n, `w${String(i % 3)}`));
    run(h, events);
    expect(h.decisions.filter((d) => d.mint === 'C')).toHaveLength(1);
  });

  it('token pré-carregado do banco (criação não vista ao vivo) nunca é avaliado, mas conta para o filtro de criador', () => {
    const h = harness();
    expect(h.engine.seedSkeletons([0, 1, 2].map((i) => ({ mint: `old${String(i)}`, creator: 'creator', createdAtMs: T0 - 3_600_000, createdAtSlot: null, quoteMint: SOL_QUOTE, tokenTotalSupply: null })))).toBe(3);
    run(h, [trade('old0', T0 + 61_000, 30_000_000_000n, 'x')]);
    expect(h.decisions.filter((d) => d.mint === 'old0')).toHaveLength(0);
    run(h, healthyToken('D', T0), T0 + 75_000);
    expect(h.decisions.filter((d) => d.mint === 'D').map((d) => d.reason)).toEqual(['maxCreatorTokens24h']);
  });

  it('kill switch data/STOP bloqueia novas entradas (motivo de risco gravado)', () => {
    const h = harness();
    h.engine.setStopFile(true);
    run(h, healthyToken('E', T0), T0 + 75_000);
    expect(h.decisions.map((d) => d.reason)).toEqual(['kill_switch:stop_file']);
    expect(h.fills).toHaveLength(0);
    // alerta imediato uma única vez, mesmo com várias avaliações bloqueadas
    expect(h.notes.filter((n) => n.includes('kill switch acionado'))).toHaveLength(1);
    expect(h.notes.find((n) => n.includes('kill switch acionado'))).toContain('kill_switch:stop_file');
    expect(h.engine.takeHourlySummary(T0 + 3_600_000, { streamGapMs: 0, http429PerMin: 0 }).entriesBlockedBy).toBe('kill_switch:stop_file');
  });

  it('TELEGRAM_MODE=hourly (tradeAlerts=false): nenhuma mensagem por entrada/saída, mas o resumo da hora conta tudo', () => {
    const h = harness({ tradeAlerts: false });
    run(h, healthyToken('G', T0), T0 + 75_000 + CONFIG.exits.timeStopSec * 1000);
    expect(h.fills.some((f) => f.side === 'buy' && f.status === 'filled')).toBe(true);
    expect(h.fills.some((f) => f.side === 'sell' && f.status === 'filled')).toBe(true);
    expect(h.notes).toEqual([]);
    const s = h.engine.takeHourlySummary(T0 + 3_600_000, { streamGapMs: 1_500, http429PerMin: 0.5 });
    expect(s).toMatchObject({ openedOperations: 1, closedOperations: 1, evaluatedTokens: 1, health: { streamGapMs: 1_500, http429PerMin: 0.5 } });
    expect(s.exitsByReason.get('time_stop')).toBe(1);
    expect(s.best?.symbol).toBeDefined();
    expect(s.worst).toBeNull(); // uma operação só: não repete como "pior"
    expect(s.capitalLamports).toBe(CONFIG.risk.maxOpenPositions > 0 ? 50_000_000n * BigInt(CONFIG.risk.maxOpenPositions) : 0n);
  });

  it('stopEntries: nenhuma nova posição', () => {
    const h = harness();
    h.engine.stopEntries();
    run(h, healthyToken('F', T0), T0 + 75_000);
    expect(h.decisions).toHaveLength(0);
  });
});

describe('PaperEngine — saídas, PnL e memória', () => {
  it('envia um gráfico depois de cada dez operações fechadas', () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      const start = T0 + i * 700_000;
      run(h, healthyToken(`B${String(i)}`, start, `creator-${String(i)}`), start + 75_000);
      for (let t = start + 76_000; t <= start + 700_000; t += 1_000) h.engine.onTick(t);
      if (i === 8) expect(h.notes.filter((note) => note.includes('\u{1F4CA} PnL'))).toHaveLength(0);
    }
    expect(h.notes.filter((note) => note.includes('\u{1F4CA} PnL'))).toHaveLength(1);
    expect(h.notes.find((note) => note.includes('\u{1F4CA} PnL'))).toContain('1–10');
  });

  it('time stop por tick sem eventos: vende tudo, grava decisão exit, PnL do run = soma dos fluxos de caixa', () => {
    const h = harness();
    run(h, healthyToken('G', T0), T0 + 75_000 + CONFIG.exits.timeStopSec * 1000);
    const exit = h.decisions.find((d) => d.type === 'exit');
    expect(exit?.reason).toBe('time_stop');
    expect(exit?.features['entryDecisionId']).toBe(h.decisions.find((d) => d.type === 'enter')?.decisionId);
    expect(h.engine.openPositions).toHaveLength(0);
    const sell = h.fills.find((f) => f.side === 'sell' && f.status === 'filled');
    expect(sell).toMatchObject({ baseFee: LAMPORTS_PER_SIGNATURE, rentRefund: 1_513_840n });
    const cash = h.fills.reduce((acc, f) => acc + fillCashFlow(f), 0n);
    expect(h.engine.runNetPnlLamports).toBe(cash);
    const summary = h.engine.takeHourlySummary(T0 + 3_600_000, { streamGapMs: 0, http429PerMin: 0 });
    expect(summary).toMatchObject({ openedOperations: 1, closedOperations: 1, openPositions: 0, runNetPnlLamports: cash });
    expect(summary.winningOperations).toBe(cash > 0n ? 1 : 0);
    expect(h.notes.some((n) => n.includes('VENDA') && n.includes('tempo esgotado'))).toBe(true);
  });

  it('stop loss disparado por evento (venda forte de terceiro derruba o preço)', () => {
    const h = harness();
    run(h, healthyToken('H', T0), T0 + 72_000);
    expect(h.engine.openPositions).toHaveLength(1);
    run(h, [trade('H', T0 + 73_000, 30_000_000_000n, 'dumper', 'sell', 1_000_000_000n)], T0 + 76_000);
    expect(h.decisions.find((d) => d.type === 'exit')?.reason).toBe('stop_loss');
    expect(h.engine.openPositions).toHaveLength(0);
  });

  it('compactação: tokens antigos perdem trades, posição aberta é preservada', () => {
    const h = harness();
    run(h, healthyToken('I', T0), T0 + 72_000);
    run(h, healthyToken('J', T0 + 1), undefined);
    // 5 min depois: I ainda tem posição (estado completo), J já está fora da janela de idade? não (≤ 11 min)
    for (let t = T0 + 73_000; t <= T0 + 5 * 60_000; t += 1_000) h.engine.onTick(t);
    expect(h.engine.tokenState('J')?.trades.length).toBe(70);
    // 20 min depois: J (sem posição, idade > maxAgeSec + 1 min) vira esqueleto; I fechou por time stop e também
    for (let t = T0 + 5 * 60_000; t <= T0 + 20 * 60_000; t += 1_000) h.engine.onTick(t);
    expect(h.engine.tokenState('J')).toMatchObject({ creator: 'creator', createdAtMs: T0 + 1, trades: [] });
    expect(h.engine.tokenState('I')?.trades).toEqual([]);
    expect(h.decisions.find((d) => d.mint === 'I' && d.type === 'exit')?.reason).toBe('time_stop');
  });

  it('determinismo: mesma sequência e seed → mesmas decisões e fills', () => {
    const events = [...healthyToken('K', T0), ...healthyToken('L', T0 + 500)].sort((a, b) => (a.kind === 'tx_cost' || b.kind === 'tx_cost' ? 0 : a.ts - b.ts));
    const a = harness({ failRate: 0.3, seed: 7 });
    const b = harness({ failRate: 0.3, seed: 7 });
    run(a, events, T0 + 800_000);
    run(b, events, T0 + 800_000);
    expect(a.fills.length).toBeGreaterThan(0);
    expect(b.decisions).toEqual(a.decisions);
    expect(b.fills).toEqual(a.fills);
  });
});

describe('PaperEngine — hipóteses do replay (desligadas por padrão)', () => {
  const withEntry = (patch: Partial<StrategyV0Config['entry']>): StrategyV0Config => ({ ...CONFIG, entry: { ...CONFIG.entry, ...patch } });
  /** Depois do token saudável (70 s subindo), trades de outros compradores levando `vq` até `toVq` em `n` passos de 1 s. */
  const tail = (mint: string, fromVq: bigint, toVq: bigint, n: number, side: 'buy' | 'sell'): PumpEvent[] =>
    Array.from({ length: n }, (_, k) => trade(mint, T0 + 71_000 + k * 1_000, fromVq + ((toVq - fromVq) * BigInt(k + 1)) / BigInt(n), `${mint}-t${String(k)}`, side));

  it('opções ausentes ≡ v0.1 explícita: mesmas decisões e fills, nenhum sinal pendente', () => {
    const events = [...healthyToken('P', T0), ...healthyToken('Q', T0 + 500)].sort((a, b) => (a.kind === 'tx_cost' || b.kind === 'tx_cost' ? 0 : a.ts - b.ts));
    const a = harness({ failRate: 0.3, seed: 3 });
    const b = harness({ failRate: 0.3, seed: 3, killSwitchEnabled: true, config: { ...CONFIG, entry: { ...CONFIG.entry } } });
    run(a, events, T0 + 800_000);
    run(b, events, T0 + 800_000);
    expect(a.decisions.some((d) => d.type === 'enter')).toBe(true);
    expect(b.decisions).toEqual(a.decisions);
    expect(b.fills).toEqual(a.fills);
    expect(a.engine.pendingSignalCount).toBe(0);
  });

  it('(a) confirmação: sinal aos 60 s, entra quando a janela fecha acima do preço do sinal', () => {
    const h = harness({ config: withEntry({ confirmation: { windowSec: 30, maxDipPct: 0.1 } }) });
    run(h, healthyToken('R', T0), T0 + 89_000);
    expect(h.engine.pendingSignalCount).toBe(1);
    expect(h.decisions.filter((d) => d.type === 'enter')).toHaveLength(0);
    h.engine.onTick(T0 + 90_000);
    const enter = h.decisions.find((d) => d.type === 'enter');
    expect(enter?.reason).toBe('momentum_confirmed');
    expect(enter?.features).toMatchObject({ signalWaitMs: 30_000, signal_ageSec: 60 });
    h.engine.onTick(T0 + 91_000);
    expect(h.fills.find((f) => f.side === 'buy')?.status).toBe('filled');
  });

  it('(a) confirmação: queda > maxDipPct cancela (reject confirmation_dip), sem compra', () => {
    const h = harness({ config: withEntry({ confirmation: { windowSec: 30, maxDipPct: 0.1 } }) });
    run(h, [...healthyToken('S', T0), ...tail('S', 44_000_000_000n, 36_000_000_000n, 5, 'sell')], T0 + 120_000);
    expect(h.decisions.filter((d) => d.mint === 'S').map((d) => d.reason)).toContain('confirmation_dip');
    expect(h.fills).toHaveLength(0);
  });

  it('(c) recuo: entra quando o preço recua retracePct do máximo desde o sinal', () => {
    const h = harness({ config: withEntry({ pullback: { retracePct: 0.25, windowSec: 180, minUniqueBuyers60s: 15 } }) });
    run(h, [...healthyToken('U', T0), ...tail('U', 44_000_000_000n, 37_000_000_000n, 5, 'sell')], T0 + 80_000);
    const enter = h.decisions.find((d) => d.type === 'enter');
    expect(enter?.reason).toBe('momentum_pullback');
    expect(Number(enter?.features['firePrice'])).toBeLessThanOrEqual(Number(enter?.features['signalMaxPrice']) * 0.75);
  });

  it('killSwitchEnabled: false ignora o kill switch (só replay de pesquisa)', () => {
    const h = harness({ killSwitchEnabled: false });
    h.engine.setStopFile(true);
    run(h, healthyToken('V', T0), T0 + 75_000);
    expect(h.decisions.filter((d) => d.type === 'enter')).toHaveLength(1);
  });
});

describe('PaperClock', () => {
  it('agora = maior ts de evento; em silêncio anda pelo monotônico desde a última chegada − 2 s; nunca volta', () => {
    let mono = 1_000;
    const c = new PaperClock(() => mono);
    expect(c.ready).toBe(false);
    expect(c.silenceMs()).toBeNull();
    expect(() => c.nowMs()).toThrow();
    c.observeEvent(T0);
    expect(c.nowMs()).toBe(T0);
    mono = 1_900; // chegadas normais: o termo monotônico fica atrás do ts
    c.observeEvent(T0 + 1_000);
    c.observeEvent(T0 + 500); // ts antigo fora de ordem: não volta
    mono = 2_500;
    expect(c.nowMs()).toBe(T0 + 1_000);
    expect(c.silenceMs()).toBe(600);
    mono = 12_500; // 10,6 s de silêncio
    expect(c.nowMs()).toBe(T0 + 1_000 + 10_600 - 2_000);
    expect(c.silenceMs()).toBe(10_600);
    c.observeEvent(T0 + 3_000); // evento atrasado depois do silêncio: o relógio não volta
    expect(c.nowMs()).toBe(T0 + 9_600);
  });
});

describe('PaperEngine ao vivo — relógio local errado não muda decisões', () => {
  /**
   * Emula o adaptador `run-paper.ts`: o tempo real (monotônico) anda; cada evento chega 700 ms depois do
   * seu ts on-chain e é carimbado com `receivedAtMs = parede` (tempo real + desvio do relógio local);
   * ticks a cada 1 s de tempo real. O engine recebe `PaperClock.nowMs()` e o silêncio monotônico.
   */
  function driveLive(events: readonly PumpEvent[], wallOffsetMs: number, untilMs: number): Harness {
    let realMs = T0 - 10_000;
    const clock = new PaperClock(() => realMs);
    const h = harnessWith({ streamSilenceMs: () => clock.silenceMs() });
    const arrivals = events.map((e) => ({ e, at: (e.kind === 'tx_cost' ? 0 : e.ts) + 700 })).sort((a, b) => a.at - b.at);
    let i = 0;
    for (let tick = T0 + 300; tick <= untilMs; tick += 1_000) {
      while (i < arrivals.length && (arrivals[i]?.at ?? Infinity) <= tick) {
        const a = arrivals[i++];
        if (!a || a.e.kind === 'tx_cost') continue;
        realMs = a.at;
        const ev = { ...a.e, receivedAtMs: realMs + wallOffsetMs };
        clock.observeEvent(ev.ts);
        h.engine.onEvent(ev, clock.nowMs());
      }
      realMs = tick;
      if (clock.ready) h.engine.onTick(clock.nowMs());
    }
    return h;
  }

  it('relógio local 30 s adiantado (e 30 s atrasado): mesmas decisões, fills e PnL', () => {
    const events = [...healthyToken('W', T0), ...healthyToken('X', T0 + 400, 'creator-x')].sort((a, b) => (a.kind === 'tx_cost' || b.kind === 'tx_cost' ? 0 : a.ts - b.ts));
    const until = T0 + 75_000 + CONFIG.exits.timeStopSec * 1000 + 5_000;
    const right = driveLive(events, 0, until);
    const ahead = driveLive(events, 30_000, until);
    const behind = driveLive(events, -30_000, until);
    expect(right.decisions.filter((d) => d.type === 'enter').length).toBeGreaterThan(0);
    expect(right.decisions.some((d) => d.type === 'exit')).toBe(true);
    expect(ahead.decisions).toEqual(right.decisions);
    expect(ahead.fills).toEqual(right.fills);
    expect(behind.decisions).toEqual(right.decisions);
    expect(ahead.engine.runNetPnlLamports).toBe(right.engine.runNetPnlLamports);
  });

  it('entradas e idade do token iguais às do replay (agora = ts do evento)', () => {
    const events = healthyToken('Y', T0);
    const live = driveLive(events, 30_000, T0 + 72_000);
    const replay = harness();
    run(replay, events, T0 + 72_000);
    const enter = (h: Harness) => h.decisions.find((d) => d.type === 'enter');
    expect(enter(live)?.ts).toBe(enter(replay)?.ts);
    expect(enter(live)?.features).toEqual(enter(replay)?.features);
  });

  it('kill switch stream_stale usa o silêncio monotônico informado, não o ts dos eventos', () => {
    // ts dos eventos contínuos (sem lacuna), mas o adaptador mede 31 s sem mensagens → bloqueia
    const stale = harnessWith({ streamSilenceMs: () => 31_000 });
    run(stale, healthyToken('Z', T0), T0 + 75_000);
    expect(stale.decisions.map((d) => d.reason)).toEqual(['kill_switch:stream_stale']);
    // silêncio de 29 s → não bloqueia
    const ok = harnessWith({ streamSilenceMs: () => 29_000 });
    run(ok, healthyToken('Z', T0), T0 + 75_000);
    expect(ok.decisions.filter((d) => d.type === 'enter')).toHaveLength(1);
  });
});

describe('PaperEngine — universo graduado (replay, pumpSwapEnabled)', () => {
  const G0 = loadStrategyConfig(fileURLToPath(new URL('../../../../config/variants/g0-grad-1-10m.yaml', import.meta.url)));
  const B0 = 206_900_000_000_000n;
  const Q0 = 67_000_000_000n;
  function swapBuy(mint: string, ts: number, i: number): PumpSwapTradeEvent {
    return {
      kind: 'trade', venue: 'pumpswap', ...base(ts), pool: `pool-${mint}`, mint, quoteMint: 'So11111111111111111111111111111111111111112', poolUnresolved: false,
      trader: `${mint}-g${String(i)}`, side: 'buy', tokenAmount: 1_000_000_000_000n, quoteAmount: 300_000_000n, userQuoteAmount: 303_600_000n,
      poolBaseReserves: B0 - BigInt(i) * 1_000_000_000_000n, poolQuoteReserves: Q0 + BigInt(i) * 300_000_000n, lpFee: 600_000n, protocolFee: 150_000n, creatorFee: 2_850_000n, ixName: 'buy_exact_quote_in',
      swapDetails: { instruction: 'buy_exact_quote_in', virtualQuoteReserves: 17_584_505_396n, lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n, cashbackFeeBps: 0n, cashbackFee: 0n, buybackFeeBps: 0n, buybackFee: 0n, holderRewardsBps: 0n, holderRewards: 0n, baseSupply: 1_000_000_000_000_000n },
    };
  }
  /** Token criado há 1 h, curva com compradores antigos, gradua em T0 e recebe 80 compras no PumpSwap (1/s). */
  function graduatedFlow(mint: string): PumpEvent[] {
    const ev: PumpEvent[] = [created(mint, T0 - 3_600_000, `dev-${mint}`)];
    for (let i = 1; i <= 5; i++) ev.push(trade(mint, T0 - 3_000_000 + i * 1_000, 30_000_000_000n + BigInt(i) * 1_000_000_000n, `${mint}-old${String(i)}`));
    ev.push({ kind: 'curve_completed', ...base(T0), mint, bondingCurve: 'bc' });
    ev.push({ kind: 'pool_created', ...base(T0 + 100), pool: `pool-${mint}`, mint, quoteMint: 'So11111111111111111111111111111111111111112', creator: 'x' });
    for (let i = 0; i < 80; i++) ev.push(swapBuy(mint, T0 + 1_000 + i * 1_000, i));
    return ev;
  }

  it('graduação vista no run: entra no PumpSwap depois de 60 s, posição venue pumpswap, sai por regra de preço/tempo (nunca graduated)', () => {
    const h = harnessWith({ pumpSwapEnabled: true }, G0);
    run(h, graduatedFlow('GA'), T0 + 81_000 + G0.exits.timeStopSec * 1000);
    const enter = h.decisions.find((d) => d.type === 'enter');
    expect(enter?.ts).toBeGreaterThanOrEqual(T0 + 60_000);
    expect(enter?.features).toMatchObject({ venue: 'pumpswap', sinceGraduationSec: expect.any(Number) as number });
    const buyFill = h.fills.find((f) => f.side === 'buy' && f.status === 'filled');
    expect(buyFill?.venueUnverified).toBe(false);
    const exit = h.decisions.find((d) => d.type === 'exit');
    expect(exit?.reason).toBeDefined();
    expect(exit?.reason).not.toBe('graduated');
    expect(h.fills.find((f) => f.side === 'sell' && f.status === 'filled')?.venueUnverified).toBe(false);
    // holders/janelas só depois da graduação: os compradores da curva foram zerados na graduação
    expect(h.engine.tokenState('GA')?.holderBalances.has('GA-old1')).toBe(false);
  });

  it('sem pumpSwapEnabled (paper ao vivo) a mesma config não avalia nada; entriesFromMs bloqueia o aquecimento', () => {
    const off = harnessWith({}, G0);
    run(off, graduatedFlow('GB'), T0 + 120_000);
    expect(off.decisions).toHaveLength(0);
    const warm = harnessWith({ pumpSwapEnabled: true, entriesFromMs: T0 + 1_000_000 }, G0);
    run(warm, graduatedFlow('GC'), T0 + 120_000);
    expect(warm.decisions).toHaveLength(0);
  });

  it('v0.1 com pumpSwapEnabled: decisões idênticas às sem a flag (a flag só muda o universo graduado)', () => {
    const events = [...healthyToken('P1', T0), ...graduatedFlow('GD')].sort((a, b) => (a.kind === 'tx_cost' || b.kind === 'tx_cost' ? 0 : a.ts - b.ts));
    const a = harness({ seed: 5 });
    const b = harness({ seed: 5 }, { pumpSwapEnabled: true });
    run(a, events, T0 + 800_000);
    run(b, events, T0 + 800_000);
    expect(a.decisions.some((d) => d.type === 'enter')).toBe(true);
    expect(b.decisions).toEqual(a.decisions);
    expect(b.fills).toEqual(a.fills);
  });
});
