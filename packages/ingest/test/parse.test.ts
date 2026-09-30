import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, WSOL_MINT } from '../../../config/protocol.ts';
import { parseLogs } from '../src/log-parser.ts';
import { Normalizer, poolRetryDelayMs, type PoolResolver } from '../src/normalize.ts';
import { lamportDelta, loadFixture, notificationOf } from './fixtures.ts';

const noResolver: PoolResolver = () => Promise.resolve('not_pool');

async function normalizeFixture(name: string, resolver: PoolResolver = noResolver) {
  const fx = loadFixture(name);
  const parsed = parseLogs(notificationOf(fx));
  const result = await new Normalizer(resolver).normalize(parsed, 1_000, 7);
  return { fx, parsed, ...result };
}

async function bondingCurveOf(mint: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PUMP_FUN_PROGRAM_ID),
    seeds: [new TextEncoder().encode('bonding-curve'), getAddressEncoder().encode(address(mint))],
  });
  return pda;
}

describe('fixtures reais da mainnet', () => {
  it('trade na curva: valores batem com a variação de saldo da bonding curve', async () => {
    const { fx, events, gaps } = await normalizeFixture('curve-trade');
    expect(gaps).toEqual([]);
    const trade = events.find((e) => e.kind === 'trade');
    if (trade?.kind !== 'trade' || trade.venue !== 'curve') throw new Error('trade de curva ausente');

    expect(trade.sig).toBe(fx.notification.signature);
    expect(trade.slot).toBe(BigInt(fx.notification.slot));
    expect(trade.side).toBe('buy');
    expect(trade.receivedAtMs).toBe(1_000);
    expect(trade.recvSeq).toBe(7);
    // timestamp do evento == blockTime da transação (fonte independente)
    expect(trade.ts).toBe((fx.tx.blockTime ?? 0) * 1000);
    // SOL que entrou na curva == quote_amount do evento
    expect(lamportDelta(fx, await bondingCurveOf(trade.mint))).toBe(trade.quoteAmount);
  });

  it('criação de token inclui a compra do criador na mesma transação', async () => {
    const { events, gaps } = await normalizeFixture('curve-create');
    expect(gaps).toEqual([]);
    const created = events.find((e) => e.kind === 'token_created');
    const trade = events.find((e) => e.kind === 'trade');
    if (created?.kind !== 'token_created' || trade?.kind !== 'trade') throw new Error('eventos ausentes');
    expect(trade.mint).toBe(created.mint);
    expect(created.bondingCurve).toBe(await bondingCurveOf(created.mint));
    expect(created.name.length).toBeGreaterThan(0);
  });

  it('curve_completed e depois migração com pool_created', async () => {
    const complete = await normalizeFixture('curve-complete');
    const done = complete.events.find((e) => e.kind === 'curve_completed');
    if (done?.kind !== 'curve_completed') throw new Error('curve_completed ausente');

    const migration = await normalizeFixture('migration');
    const pool = migration.events.find((e) => e.kind === 'pool_created');
    if (pool?.kind !== 'pool_created') throw new Error('pool_created ausente');
    expect(pool.mint).toBe(done.mint);
    expect(pool.quoteMint).toBe(WSOL_MINT);
  });

  it('trade no PumpSwap usa base/quote da pool resolvida', async () => {
    const resolved: string[] = [];
    const resolver = (pool: string) => {
      resolved.push(pool);
      return Promise.resolve({ baseMint: 'BaseMint1111111111111111111111111111111111', quoteMint: WSOL_MINT });
    };
    const { events, gaps } = await normalizeFixture('amm-buy', resolver);
    const trade = events.find((e) => e.kind === 'trade');
    if (trade?.kind !== 'trade' || trade.venue !== 'pumpswap') throw new Error('trade pumpswap ausente');
    expect(resolved).toEqual([trade.pool]);
    expect(trade.mint).toBe('BaseMint1111111111111111111111111111111111');
    expect(trade.side).toBe('buy');
    expect(gaps).toEqual([]);
  });

  it('pool criada (CreatePoolEvent) fica em cache: trade seguinte nessa pool não chama o resolver', async () => {
    let calls = 0;
    const normalizer = new Normalizer(() => {
      calls++;
      return Promise.resolve('not_pool' as const);
    });
    const migration = parseLogs(notificationOf(loadFixture('migration')));
    const created = (await normalizer.normalize(migration, 1, 1)).events.find((e) => e.kind === 'pool_created');
    if (created?.kind !== 'pool_created') throw new Error('pool_created ausente');

    // trade real do PumpSwap, redirecionado para a pool recém-criada
    const buy = parseLogs(notificationOf(loadFixture('amm-buy')));
    const moved = { ...buy, events: buy.events.map((e) => ({ ...e, data: { ...e.data, pool: created.pool } })) };
    const trade = (await normalizer.normalize(moved, 2, 2)).events.find((e) => e.kind === 'trade');
    if (trade?.kind !== 'trade' || trade.venue !== 'pumpswap') throw new Error('trade ausente');
    expect(trade.mint).toBe(created.mint);
    expect(trade.quoteMint).toBe(WSOL_MINT);
    expect(calls).toBe(0);
  });

  it('falha transitória: não repete o RPC antes do backoff e grava um gap por tentativa (não por trade)', async () => {
    let calls = 0;
    const normalizer = new Normalizer(() => {
      calls++;
      return Promise.reject(new Error('HTTP 429'));
    });
    const buy = parseLogs(notificationOf(loadFixture('amm-buy')));
    const at = async (ms: number) => (await normalizer.normalize(buy, ms, 0)).gaps.length;

    expect(await at(0)).toBe(1); // 1ª tentativa falha → espera 1 s
    expect(await at(500)).toBe(0); // dentro da janela: nem RPC nem gap
    expect(calls).toBe(1);
    expect(await at(1_000)).toBe(1); // 2ª tentativa → espera 2 s
    expect(await at(2_500)).toBe(0);
    expect(await at(3_000)).toBe(1);
    expect(calls).toBe(3);
    expect(poolRetryDelayMs(1)).toBe(1_000);
    expect(poolRetryDelayMs(20)).toBe(300_000);
  });

  it("'not_pool' fica em cache negativo definitivo", async () => {
    let calls = 0;
    const normalizer = new Normalizer(() => {
      calls++;
      return Promise.resolve('not_pool' as const);
    });
    const buy = parseLogs(notificationOf(loadFixture('amm-buy')));
    await normalizer.normalize(buy, 0, 0);
    const again = await normalizer.normalize(buy, 10_000_000, 1);
    expect(calls).toBe(1);
    expect(again.gaps).toEqual([]);
  });

  it('trades concorrentes na mesma pool compartilham uma única chamada', async () => {
    let calls = 0;
    let release: (v: 'not_pool') => void = () => undefined;
    const normalizer = new Normalizer(() => {
      calls++;
      return new Promise((r) => (release = r));
    });
    const buy = parseLogs(notificationOf(loadFixture('amm-buy')));
    const a = normalizer.normalize(buy, 0, 0);
    const b = normalizer.normalize(buy, 0, 1);
    release('not_pool');
    const gaps = [...(await a).gaps, ...(await b).gaps];
    expect(calls).toBe(1);
    expect(gaps).toHaveLength(1);
  });

  it('falha de rede no resolver não perde o trade', async () => {
    const failing: PoolResolver = () => Promise.reject(new Error('fetch failed'));
    const { events, gaps } = await normalizeFixture('amm-buy', failing);
    expect(events.filter((e) => e.kind === 'trade')).toHaveLength(1);
    expect(gaps.map((g) => g.kind)).toEqual(['pool_unresolved']);
  });

  it('pool não resolvida grava o trade com mint vazio e registra gap', async () => {
    const { events, gaps } = await normalizeFixture('amm-sell');
    const trade = events.find((e) => e.kind === 'trade');
    if (trade?.kind !== 'trade' || trade.venue !== 'pumpswap') throw new Error('trade pumpswap ausente');
    expect(trade.mint).toBe('');
    expect(trade.side).toBe('sell');
    expect(trade.ixName).toBeNull();
    expect(gaps.map((g) => g.kind)).toEqual(['pool_unresolved']);
  });
});

describe('parseLogs', () => {
  const tradeLine = loadFixture('curve-trade').notification.logs.find((l) => l.startsWith('Program data: ')) ?? '';

  it('descarta transação com erro', () => {
    const fx = loadFixture('curve-trade');
    const parsed = parseLogs({ ...notificationOf(fx), err: { InstructionError: [0, 'Custom'] } });
    expect(parsed.failed).toBe(true);
    expect(parsed.events).toEqual([]);
  });

  it('ignora evento forjado emitido por outro programa', () => {
    const fake = 'Fake1111111111111111111111111111111111111111';
    const parsed = parseLogs({
      slot: 1n,
      signature: 'sig',
      err: null,
      logs: [`Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`, `Program ${fake} invoke [2]`, tradeLine, `Program ${fake} success`, `Program ${PUMP_FUN_PROGRAM_ID} success`],
    });
    expect(parsed.events).toEqual([]);
  });

  it('marca log truncado e para de ler', () => {
    const parsed = parseLogs({
      slot: 1n,
      signature: 'sig',
      err: null,
      logs: [`Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`, 'Log truncated', tradeLine],
    });
    expect(parsed.truncated).toBe(true);
    expect(parsed.events).toEqual([]);
  });

  it('registra discriminador desconhecido e dado corrompido', () => {
    const unknown = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).toString('base64');
    const corrupt = Buffer.from(tradeLine.slice('Program data: '.length), 'base64').subarray(0, 20).toString('base64');
    const parsed = parseLogs({
      slot: 1n,
      signature: 'sig',
      err: null,
      logs: [`Program ${PUMP_SWAP_PROGRAM_ID} invoke [1]`, `Program data: ${unknown}`, `Program ${PUMP_SWAP_PROGRAM_ID} success`, `Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`, `Program data: ${corrupt}`, `Program ${PUMP_FUN_PROGRAM_ID} success`],
    });
    expect(parsed.problems.map((p) => p.kind)).toEqual(['unknown_event', 'parse_error']);
  });
});
