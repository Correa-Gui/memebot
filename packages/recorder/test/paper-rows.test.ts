import { describe, expect, it } from 'vitest';
import {
  FILLS_REQUIRED_COLUMNS,
  decisionToRow,
  fillToRow,
  parseProtocolConfigRow,
  parseTokenCreationRows,
  parseTxCostRows,
} from '../src/paper-rows.ts';
import type { FillRecord } from '../src/paper-rows.ts';

const FILL: FillRecord = {
  runId: 'paper-1', ts: 1_790_730_054_000, decisionId: 'paper-1:m:1:1', mint: 'm', side: 'buy',
  solIn: 50_000_000n, solOut: 0n, tokenDelta: 1_234n, protocolFee: 472_000n, creatorFee: 149_000n,
  priorityFee: 225_000n, jitoTip: 300_000n, rent: 1_513_840n, rentRefund: 0n, baseFee: 5_000n,
  expectedPriceLamportsPerUnit: 0.03, realizedPriceLamportsPerUnit: 0.031, slippageBps: 333, landedSlot: null,
  status: 'filled', error: null, venueUnverified: false, costEstimateSource: 'fallback', costCappedByHardLimit: true,
  priorityFeeSource: 'tx_costs_p75', jitoTipSource: 'fallback',
  virtualQuoteBefore: 30_000_000_000n, virtualTokenBefore: 1_073_000_000_000_000n,
};

describe('fillToRow', () => {
  it('grava todas as colunas da 006 com u64 como string', () => {
    const row = fillToRow(FILL);
    expect(row).toMatchObject({
      run_id: 'paper-1', ts: '2026-09-30 01:00:54.000', side: 'buy', sol_in: '50000000', token_delta: '1234',
      base_fee: '5000', rent: '1513840', rent_refund: '0', cost_estimate_source: 'fallback', cost_capped: 1,
      venue_unverified: 0, priority_fee_source: 'tx_costs_p75', jito_tip_source: 'fallback', expected_price_lamports_per_unit: 0.03, realized_price_lamports_per_unit: 0.031,
      virtual_quote_before: '30000000000', virtual_token_before: '1073000000000000', landed_slot: null,
    });
    for (const col of FILLS_REQUIRED_COLUMNS) expect(row).toHaveProperty(col);
  });

  it('NaN vira 0 (Float64 não aceita NaN em JSON); venda tem token_delta negativo; reservas nulas viram 0', () => {
    const row = fillToRow({
      ...FILL, side: 'sell', tokenDelta: -1_234n, status: 'failed', realizedPriceLamportsPerUnit: Number.NaN,
      slippageBps: Number.POSITIVE_INFINITY, virtualQuoteBefore: null, virtualTokenBefore: null,
    });
    expect(row).toMatchObject({ token_delta: '-1234', realized_price_lamports_per_unit: 0, slippage_bps: 0, virtual_quote_before: '0' });
  });
});

describe('decisionToRow', () => {
  it('features vira JSON (NaN → null)', () => {
    const row = decisionToRow({ runId: 'r', ts: 0, decisionId: 'd', mint: 'm', type: 'reject', reason: 'minUniqueHolders', features: { uniqueHolders: 12, top10: Number.NaN } });
    expect(row).toMatchObject({ type: 'reject', reason: 'minUniqueHolders', features_json: '{"uniqueHolders":12,"top10":null}' });
  });
});

describe('parse das leituras', () => {
  it('token_created, tx_costs e protocol_config (u64 como string)', () => {
    expect(parseTokenCreationRows([{ mint: 'm', creator: 'c', ts_ms: '1790730054000', slot: '400000000', quote_mint: '', token_total_supply: '1000000000000000' }])).toEqual([
      { mint: 'm', creator: 'c', createdAtMs: 1_790_730_054_000, createdAtSlot: 400_000_000n, quoteMint: null, tokenTotalSupply: 1_000_000_000_000_000n },
    ]);
    expect(parseTxCostRows([{ priority_fee: '150000', jito_tip: null }, { priority_fee: '1', jito_tip: '2' }])).toEqual([
      { priorityFee: 150_000n, jitoTip: null }, { priorityFee: 1n, jitoTip: 2n },
    ]);
    expect(parseProtocolConfigRow({ config_json: '{"a":"1"}', config_hash: 'h', ts_ms: '5' })).toEqual({ configJson: { a: '1' }, configHash: 'h', tsMs: 5 });
  });

  it('recusa linha fora do formato', () => {
    expect(() => parseTxCostRows([{ priority_fee: 'x', jito_tip: null }])).toThrow();
    expect(() => parseTokenCreationRows([{ mint: '', creator: 'c' }])).toThrow();
  });
});
