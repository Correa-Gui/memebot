import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BackfillStats, backfillRow, mintChunks } from '../scripts/pumpswap-extra-backfill-core.ts';
import { parseLogs } from '../src/log-parser.ts';
import { Normalizer, pumpSwapSwapDetails } from '../src/normalize.ts';
import { decodePumpSwapSwapDetails } from '../src/pumpswap-extra.ts';
import { loadFixture, notificationOf } from './fixtures.ts';

/**
 * Fixtures golden do PumpSwap (eventos reais, `raw_b64` original + campos esperados), extraídas por
 * `packages/curve-math/scripts/extract-pumpswap-fixtures.ts` — fonte independente para conferir a
 * decodificação usada pelo normalize e pelo backfill.
 */
interface GoldenFixture {
  source: { sig: string; eventIndex: number; slot: string; pool: string; eventRawB64: string };
  ixName: 'buy' | 'buy_exact_quote_in' | 'sell';
  before: { virtualQuote: string };
  feeBps: { lp: string; protocol: string; creator: string; cashback: string };
  event: { cashback: string };
}
const golden = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'curve-math', 'test', 'fixtures', 'golden', 'pumpswap.json'), 'utf8'),
) as GoldenFixture[];

async function tradeOf(name: string) {
  const parsed = parseLogs(notificationOf(loadFixture(name)));
  const { events } = await new Normalizer(() => Promise.resolve('not_pool' as const)).normalize(parsed, 0, 0);
  const t = events.find((e) => e.kind === 'trade');
  if (t?.kind !== 'trade' || t.venue !== 'pumpswap') throw new Error('trade pumpswap ausente');
  return { t, parsed };
}

describe('normalize: swapDetails do PumpSwap (fixtures reais da mainnet)', () => {
  it('BuyEvent (`buy`): virtual_quote_reserves, bps, cashback e base_supply', async () => {
    const { t } = await tradeOf('amm-buy');
    expect(t.swapDetails).toEqual({
      instruction: 'buy',
      virtualQuoteReserves: 17_584_505_288n,
      lpFeeBps: 20n,
      protocolFeeBps: 5n,
      creatorFeeBps: 75n,
      cashbackFeeBps: 0n,
      cashbackFee: 0n,
      buybackFeeBps: 5000n,
      buybackFee: 177n,
      holderRewardsBps: 0n,
      holderRewards: 0n,
      baseSupply: t.swapDetails?.baseSupply,
    });
    expect(t.swapDetails?.baseSupply).toBeGreaterThan(0n);
  });

  it('SellEvent: instruction = sell, pool sem offset virtual (0)', async () => {
    const { t } = await tradeOf('amm-sell');
    expect(t.swapDetails).toMatchObject({ instruction: 'sell', virtualQuoteReserves: 0n, lpFeeBps: 25n, protocolFeeBps: 5n, creatorFeeBps: 0n });
  });

  it('ix_name desconhecido num BuyEvent: trade continua, sem swapDetails', async () => {
    const parsed = parseLogs(notificationOf(loadFixture('amm-buy')));
    const moved = { ...parsed, events: parsed.events.map((e) => ({ ...e, data: { ...e.data, ix_name: 'buy_v9' } })) };
    const { events, gaps } = await new Normalizer(() => Promise.resolve('not_pool' as const)).normalize(moved, 0, 0);
    const t = events.find((e) => e.kind === 'trade');
    if (t?.kind !== 'trade' || t.venue !== 'pumpswap') throw new Error('trade ausente');
    expect(t.swapDetails).toBeUndefined();
    expect(gaps).toEqual([]);
    expect(pumpSwapSwapDetails('BuyEvent', moved.events[0]?.data ?? {})).toBeNull();
  });
});

describe('decodePumpSwapSwapDetails (base do backfill)', () => {
  it('bate com as 99 fixtures golden reais (instrução, offset virtual, bps, cashback)', () => {
    expect(golden.length).toBeGreaterThanOrEqual(50);
    for (const fx of golden) {
      const r = decodePumpSwapSwapDetails(fx.source.eventRawB64);
      if (!r.ok) throw new Error(`${fx.source.sig}: ${r.reason}`);
      expect(r.details.instruction).toBe(fx.ixName);
      expect(r.details.virtualQuoteReserves).toBe(BigInt(fx.before.virtualQuote));
      expect(r.details.lpFeeBps).toBe(BigInt(fx.feeBps.lp));
      expect(r.details.protocolFeeBps).toBe(BigInt(fx.feeBps.protocol));
      expect(r.details.creatorFeeBps).toBe(BigInt(fx.feeBps.creator));
      expect(r.details.cashbackFeeBps).toBe(BigInt(fx.feeBps.cashback));
      expect(r.details.cashbackFee).toBe(BigInt(fx.event.cashback));
    }
  });

  it('descarta com motivo, sem lançar: raw vazio, evento que não é swap, lixo', () => {
    const curve = parseLogs(notificationOf(loadFixture('curve-trade'))).events[0]?.rawB64 ?? '';
    expect(decodePumpSwapSwapDetails('')).toMatchObject({ ok: false, reason: 'empty_raw' });
    expect(decodePumpSwapSwapDetails(curve)).toMatchObject({ ok: false, reason: 'not_swap_event' });
    expect(decodePumpSwapSwapDetails(Buffer.from('lixo').toString('base64'))).toMatchObject({ ok: false, reason: 'not_swap_event' });
    const golden0 = golden[0]?.source.eventRawB64 ?? '';
    const truncated = Buffer.from(golden0, 'base64').subarray(0, 60).toString('base64');
    expect(decodePumpSwapSwapDetails(truncated)).toMatchObject({ ok: false, reason: 'decode_error' });
  });
});

describe('backfill: linha de events_trade → linha de pumpswap_trade_extra', () => {
  it('converte uma linha real (JSONEachRow) com as colunas da migração 011', () => {
    const fx = golden.find((f) => f.ixName === 'buy_exact_quote_in');
    if (!fx) throw new Error('fixture ausente');
    const out = backfillRow(
      { sig: fx.source.sig, event_index: fx.source.eventIndex, slot: fx.source.slot, ts_ms: '1790899119000', pool: fx.source.pool, raw_b64: fx.source.eventRawB64 },
      Date.UTC(2026, 9, 2),
    );
    if (!out.ok) throw new Error(out.reason);
    expect(out.row).toMatchObject({
      sig: fx.source.sig,
      event_index: fx.source.eventIndex,
      slot: fx.source.slot,
      ts: new Date(1_790_899_119_000).toISOString().replace('T', ' ').replace('Z', ''),
      pool: fx.source.pool,
      instruction: 'buy_exact_quote_in',
      virtual_quote_reserves: fx.before.virtualQuote,
      lp_fee_bps: fx.feeBps.lp,
      source: 'backfill',
      inserted_at: '2026-10-02 00:00:00.000',
    });
    expect(Object.keys(out.row).sort()).toEqual(
      [
        'sig', 'event_index', 'slot', 'ts', 'pool', 'instruction', 'virtual_quote_reserves', 'lp_fee_bps', 'protocol_fee_bps',
        'creator_fee_bps', 'cashback_fee_bps', 'cashback_fee', 'buyback_fee_bps', 'buyback_fee', 'holder_rewards_bps',
        'holder_rewards', 'base_supply', 'source', 'inserted_at',
      ].sort(),
    );
  });

  it('estatísticas contam descartes por motivo', () => {
    const s = new BackfillStats();
    s.add(backfillRow({ sig: 'a', event_index: 0, slot: '1', ts_ms: 0, pool: 'p', raw_b64: '' }, 0), 'a');
    s.add(backfillRow({ sig: 'b', event_index: 0, slot: '1', ts_ms: 0, pool: 'p', raw_b64: golden[0]?.source.eventRawB64 ?? '' }, 0), 'b');
    expect(s.read).toBe(2);
    expect(s.skipped.get('empty_raw')).toBe(1);
    expect(s.summary()).toContain('empty_raw=1');
  });

  it("fatias de mint cobrem tudo, sem sobreposição: '' + faixas base58 contíguas", () => {
    const chunks = mintChunks();
    expect(chunks[0]?.where).toBe("mint = ''");
    expect(chunks[1]?.where).toBe("mint != '' AND mint < '2'");
    expect(chunks.at(-1)?.where).toBe("mint >= 'z'");
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    // cada fatia começa onde a anterior termina
    for (let i = 2; i < chunks.length; i++) {
      const prevUpper = /mint < '(.)'/.exec(chunks[i - 1]?.where ?? '')?.[1];
      expect(chunks[i]?.where.startsWith(`mint >= '${String(prevUpper)}'`)).toBe(true);
    }
  });
});
