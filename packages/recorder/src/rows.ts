import type { IngestGap, OnchainEventBase, PumpEvent } from '@memebot/core';

export type Row = Record<string, string | number | null>;
export type TableName =
  | 'events_trade'
  | 'events_token'
  | 'events_lifecycle'
  | 'tx_costs'
  | 'ingest_gaps'
  | 'pools'
  | 'token_metadata'
  | 'protocol_config'
  | 'runs';

/** DateTime64(3, 'UTC') no formato de texto do ClickHouse. */
export function chTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/** UInt64/Int64 vão como string: o JSON do ClickHouse aceita e não há perda de precisão. */
const u = (v: bigint): string => v.toString();
const uOrNull = (v: bigint | null): string | null => (v === null ? null : v.toString());

function base(e: OnchainEventBase): Row {
  return {
    slot: u(e.slot),
    ts: chTime(e.ts),
    sig: e.sig,
    event_index: e.eventIndex,
    received_at: chTime(e.receivedAtMs),
    recv_seq: e.recvSeq,
    raw_b64: e.rawB64,
  };
}

export function eventToRow(e: PumpEvent, nowMs: number): { table: TableName; row: Row } {
  switch (e.kind) {
    case 'token_created':
      return {
        table: 'events_token',
        row: {
          ...base(e),
          mint: e.mint,
          creator: e.creator,
          name: e.name,
          symbol: e.symbol,
          uri: e.uri,
          bonding_curve: e.bondingCurve,
          quote_mint: e.quoteMint,
          token_total_supply: u(e.tokenTotalSupply),
        },
      };
    case 'trade': {
      const common: Row = {
        ...base(e),
        venue: e.venue,
        mint: e.mint,
        trader: e.trader,
        side: e.side,
        quote_mint: e.quoteMint,
        quote_amount: u(e.quoteAmount),
        token_amount: u(e.tokenAmount),
        protocol_fee: u(e.protocolFee),
        creator_fee: u(e.creatorFee),
        ix_name: e.ixName,
      };
      if (e.venue === 'curve') {
        return {
          table: 'events_trade',
          row: {
            ...common,
            pool: '',
            virtual_quote_reserves: u(e.virtualQuoteReserves),
            virtual_token_reserves: u(e.virtualTokenReserves),
            real_quote_reserves: u(e.realQuoteReserves),
            real_token_reserves: u(e.realTokenReserves),
            user_quote_amount: null,
            pool_base_reserves: null,
            pool_quote_reserves: null,
            lp_fee: null,
          },
        };
      }
      return {
        table: 'events_trade',
        row: {
          ...common,
          pool: e.pool,
          virtual_quote_reserves: null,
          virtual_token_reserves: null,
          real_quote_reserves: null,
          real_token_reserves: null,
          user_quote_amount: u(e.userQuoteAmount),
          pool_base_reserves: u(e.poolBaseReserves),
          pool_quote_reserves: u(e.poolQuoteReserves),
          lp_fee: u(e.lpFee),
        },
      };
    }
    case 'curve_completed':
      return {
        table: 'events_lifecycle',
        row: { ...base(e), kind: 'curve_completed', mint: e.mint, bonding_curve: e.bondingCurve, pool: null, quote_mint: null, creator: null },
      };
    case 'pool_created':
      return {
        table: 'events_lifecycle',
        row: { ...base(e), kind: 'pool_created', mint: e.mint, bonding_curve: null, pool: e.pool, quote_mint: e.quoteMint, creator: e.creator },
      };
    case 'tx_cost':
      return {
        table: 'tx_costs',
        row: {
          slot: u(e.slot),
          sig: e.sig,
          sampled_at: chTime(nowMs),
          fee: u(e.feeLamports),
          priority_fee: u(e.priorityFee),
          jito_tip: uOrNull(e.jitoTip),
          compute_units: e.computeUnits,
          num_signatures: e.numSignatures,
        },
      };
  }
}

export function gapToRow(g: IngestGap, runId: string): Row {
  return {
    run_id: runId,
    detected_at: chTime(g.detectedAtMs),
    kind: g.kind,
    from_slot: uOrNull(g.fromSlot),
    to_slot: uOrNull(g.toSlot),
    sig: g.sig,
    program: g.program,
    detail: g.detail,
  };
}
