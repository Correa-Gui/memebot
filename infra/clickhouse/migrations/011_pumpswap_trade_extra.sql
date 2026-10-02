-- 2026-10-02: campos do BuyEvent/SellEvent do PumpSwap que `events_trade` não guarda e que a
-- matemática exata do swap exige (packages/curve-math/src/pumpswap.ts; ROADMAP Fase 2, "Resolver
-- swap exato do PumpSwap"). Tabela LATERAL em vez de ADD COLUMN em events_trade (11M+ linhas):
-- nada de mutação na tabela grande, e o backfill escreve só aqui.
--
-- Chave: (sig, event_index), a mesma de um trade em events_trade. ReplacingMergeTree(inserted_at):
-- gravar a mesma linha de novo (recorder + backfill, ou backfill repetido) é idempotente — leia
-- com FINAL (ou pela view abaixo, que já usa FINAL).
-- Fonte dos campos: IDL oficial packages/ingest/src/idl/pump_amm.json (BuyEvent/SellEvent);
-- virtual_quote_reserves é i128 no IDL (Int128 aqui).
-- instruction: 'buy' (base exata), 'buy_exact_quote_in' (quote gastável), 'sell'.
-- source: 'recorder' (gravado ao vivo) ou 'backfill' (decodificado de events_trade.raw_b64 por
--   packages/ingest/scripts/backfill-pumpswap-trade-extra.ts; raw_b64 tem TTL de 30 dias, 008).
CREATE TABLE IF NOT EXISTS pumpswap_trade_extra
(
    sig                     String,
    event_index             UInt16,
    slot                    UInt64,
    ts                      DateTime64(3, 'UTC'),
    pool                    String,
    instruction             Enum8('buy' = 1, 'buy_exact_quote_in' = 2, 'sell' = 3),
    virtual_quote_reserves  Int128,
    lp_fee_bps              UInt64,
    protocol_fee_bps        UInt64,
    creator_fee_bps         UInt64,
    cashback_fee_bps        UInt64,
    cashback_fee            UInt64,
    buyback_fee_bps         UInt64,
    buyback_fee             UInt64,
    holder_rewards_bps      UInt64,
    holder_rewards          UInt64,
    base_supply             UInt64,
    source                  Enum8('recorder' = 1, 'backfill' = 2),
    inserted_at             DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (sig, event_index);

-- View PARAMETRIZADA por intervalo de slot [from_slot, to_slot): o JOIN monta em memória só o lado
-- direito do intervalo pedido (o ClickHouse está limitado a ~1,8 GiB; um JOIN da tabela inteira
-- não caberia). Uso: SELECT * FROM v_pumpswap_trades(from_slot = 452000000, to_slot = 452100000).
-- has_extra = 0: trade sem linha lateral (gravado antes da 011 e sem backfill, ou raw_b64 já
-- expirado); os campos extras vêm com o valor padrão (0) e NÃO devem ser usados nesse caso.
CREATE VIEW IF NOT EXISTS v_pumpswap_trades AS
SELECT
    t.*,
    x.sig != '' AS has_extra,
    x.instruction AS instruction,
    x.virtual_quote_reserves AS pool_virtual_quote_reserves,
    x.lp_fee_bps AS lp_fee_bps,
    x.protocol_fee_bps AS protocol_fee_bps,
    x.creator_fee_bps AS creator_fee_bps,
    x.cashback_fee_bps AS cashback_fee_bps,
    x.cashback_fee AS cashback_fee,
    x.buyback_fee_bps AS buyback_fee_bps,
    x.buyback_fee AS buyback_fee,
    x.holder_rewards_bps AS holder_rewards_bps,
    x.holder_rewards AS holder_rewards,
    x.base_supply AS base_supply
FROM
(
    SELECT * FROM v_trades
    WHERE venue = 'pumpswap' AND slot >= {from_slot:UInt64} AND slot < {to_slot:UInt64}
) AS t
LEFT JOIN
(
    SELECT * FROM pumpswap_trade_extra FINAL
    WHERE slot >= {from_slot:UInt64} AND slot < {to_slot:UInt64}
) AS x ON t.sig = x.sig AND t.event_index = x.event_index
SETTINGS join_use_nulls = 0;
