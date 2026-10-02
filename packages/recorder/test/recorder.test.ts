import { createLogger, type CurveTradeEvent, type PumpSwapTradeEvent } from '@memebot/core';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchWriter } from '../src/batch-writer.ts';
import { chTime, eventToRow, pumpSwapTradeExtraRow, type Row, type TableName } from '../src/rows.ts';

const silent = createLogger({
  destination: new Writable({
    write: (_c, _e, cb) => {
      cb();
    },
  }),
});

const trade: CurveTradeEvent = {
  kind: 'trade',
  venue: 'curve',
  slot: 400_000_000n,
  ts: 1_790_730_054_000,
  sig: 'sig1',
  eventIndex: 0,
  receivedAtMs: 1_790_730_054_321,
  recvSeq: 5,
  rawB64: 'AAAA',
  mint: 'Mint',
  trader: 'Trader',
  side: 'buy',
  quoteMint: '11111111111111111111111111111111',
  quoteAmount: 29_629_629n,
  tokenAmount: 18_446_744_073_709_551_615n, // u64 máximo: não pode perder precisão
  virtualQuoteReserves: 1n,
  virtualTokenReserves: 2n,
  realQuoteReserves: 3n,
  realTokenReserves: 4n,
  protocolFee: 5n,
  creatorFee: 6n,
  ixName: 'buy',
};

const pumpswapTrade: PumpSwapTradeEvent = {
  kind: 'trade',
  venue: 'pumpswap',
  slot: 400_000_000n,
  ts: 1_790_730_054_000,
  sig: 'sig2',
  eventIndex: 0,
  receivedAtMs: 1_790_730_054_321,
  recvSeq: 6,
  rawB64: 'AAAA',
  pool: 'Pool1',
  mint: '',
  quoteMint: '',
  poolUnresolved: true,
  trader: 'Trader',
  side: 'buy',
  tokenAmount: 1n,
  quoteAmount: 2n,
  userQuoteAmount: 2n,
  poolBaseReserves: 3n,
  poolQuoteReserves: 4n,
  lpFee: 5n,
  protocolFee: 6n,
  creatorFee: 7n,
  ixName: 'buy',
};

describe('eventToRow', () => {
  it('u64 vira string sem perda e tempo vira DateTime64 UTC', () => {
    const { table, row } = eventToRow(trade, 0);
    expect(table).toBe('events_trade');
    expect(row['token_amount']).toBe('18446744073709551615');
    expect(row['ts']).toBe('2026-09-30 01:00:54.000'); // date -u -d @1790730054
    expect(row['received_at']).toBe(chTime(trade.receivedAtMs));
    expect(row['pool']).toBe('');
    expect(row['lp_fee']).toBeNull();
    expect(row['pool_unresolved']).toBe(0); // curva não tem pool a resolver
  });

  it('trade do PumpSwap com pool não resolvida grava a flag pool_unresolved = 1', () => {
    const { row } = eventToRow(pumpswapTrade, 0);
    expect(row['pool']).toBe('Pool1');
    expect(row['mint']).toBe('');
    expect(row['pool_unresolved']).toBe(1);
  });

  it('trade do PumpSwap com pool resolvida grava a flag pool_unresolved = 0', () => {
    const { row } = eventToRow({ ...pumpswapTrade, mint: 'Base1', quoteMint: 'Quote1', poolUnresolved: false }, 0);
    expect(row['mint']).toBe('Base1');
    expect(row['pool_unresolved']).toBe(0);
  });

  it('pumpswap_trade_extra: i128 negativo e u64 máximo viram string sem perda; events_trade não muda', () => {
    const details = {
      instruction: 'buy_exact_quote_in' as const,
      virtualQuoteReserves: -170_141_183_460_469_231_731_687_303_715_884_105_728n, // i128 mínimo
      lpFeeBps: 20n,
      protocolFeeBps: 5n,
      creatorFeeBps: 95n,
      cashbackFeeBps: 0n,
      cashbackFee: 0n,
      buybackFeeBps: 5000n,
      buybackFee: 3n,
      holderRewardsBps: 0n,
      holderRewards: 0n,
      baseSupply: 18_446_744_073_709_551_615n,
    };
    const row = pumpSwapTradeExtraRow(
      { sig: 'sig2', eventIndex: 3, slot: 400_000_000n, tsMs: pumpswapTrade.ts, pool: 'Pool1' },
      details,
      'recorder',
      pumpswapTrade.receivedAtMs,
    );
    expect(row).toEqual({
      sig: 'sig2',
      event_index: 3,
      slot: '400000000',
      ts: '2026-09-30 01:00:54.000',
      pool: 'Pool1',
      instruction: 'buy_exact_quote_in',
      virtual_quote_reserves: '-170141183460469231731687303715884105728',
      lp_fee_bps: '20',
      protocol_fee_bps: '5',
      creator_fee_bps: '95',
      cashback_fee_bps: '0',
      cashback_fee: '0',
      buyback_fee_bps: '5000',
      buyback_fee: '3',
      holder_rewards_bps: '0',
      holder_rewards: '0',
      base_supply: '18446744073709551615',
      source: 'recorder',
      inserted_at: chTime(pumpswapTrade.receivedAtMs),
    });
    // os campos extras não vazam para events_trade (tabela grande fica igual)
    const withDetails = eventToRow({ ...pumpswapTrade, swapDetails: details }, 0).row;
    expect(withDetails).toEqual(eventToRow(pumpswapTrade, 0).row);
  });
});

describe('BatchWriter', () => {
  let inserted: { table: TableName; rows: Row[] }[];
  let fail: boolean;
  let writer: BatchWriter;

  beforeEach(() => {
    vi.useFakeTimers();
    inserted = [];
    fail = false;
    writer = new BatchWriter({
      logger: silent,
      flushIntervalMs: 1_000,
      maxBatchRows: 3,
      maxBufferedRows: 5,
      insert: (table, rows) => {
        if (fail) return Promise.reject(new Error('ClickHouse fora'));
        inserted.push({ table, rows });
        return Promise.resolve();
      },
    });
    writer.start();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('faz flush por tempo', async () => {
    writer.add('events_trade', { a: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inserted).toEqual([{ table: 'events_trade', rows: [{ a: 1 }] }]);
    await writer.stop();
  });

  it('faz flush ao atingir o tamanho de lote', async () => {
    writer.add('events_trade', { a: 1 });
    writer.add('events_trade', { a: 2 });
    writer.add('events_token', { b: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(inserted.flatMap((i) => i.rows)).toHaveLength(3);
    await writer.stop();
  });

  it('mantém as linhas quando o insert falha e grava no próximo flush, na ordem', async () => {
    fail = true;
    writer.add('events_trade', { a: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    writer.add('events_trade', { a: 2 });
    expect(writer.stats.failedFlushes).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inserted).toEqual([{ table: 'events_trade', rows: [{ a: 1 }, { a: 2 }] }]);
    expect(writer.stats).toMatchObject({ written: 2, buffered: 0, dropped: 0 });
    await writer.stop();
  });

  it('com banco fora por muito tempo, descarta as mais antigas e conta', async () => {
    fail = true;
    for (let i = 0; i < 7; i++) writer.add('events_trade', { i });
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.stats.dropped).toBeGreaterThan(0);
    expect(writer.stats.buffered).toBeLessThanOrEqual(5);
    fail = false;
    await writer.stop();
  });

  it('stop grava o que sobrou', async () => {
    writer.add('ingest_gaps', { g: 1 });
    await writer.stop();
    expect(inserted).toEqual([{ table: 'ingest_gaps', rows: [{ g: 1 }] }]);
  });
});
