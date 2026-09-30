-- Modelo de dados de docs/ARCHITECTURE.md §6.
-- Retenção: sem TTL (dados brutos são o ativo do projeto).
-- Toda linha de evento guarda `raw_b64` (bytes do evento Anchor): pode ser re-decodificada com IDL futuro.
-- `received_at`/`recv_seq`: ordem de chegada no ingest (aproxima a ordem dentro do slot; ver ARCHITECTURE §8).

CREATE TABLE IF NOT EXISTS events_trade
(
    venue                   Enum8('curve' = 1, 'pumpswap' = 2),
    slot                    UInt64,
    ts                      DateTime64(3, 'UTC'),
    sig                     String,
    event_index             UInt16,
    received_at             DateTime64(3, 'UTC'),
    recv_seq                UInt64,
    mint                    String,
    pool                    String,
    trader                  String,
    side                    Enum8('buy' = 1, 'sell' = 2),
    quote_mint              String,
    quote_amount            UInt64,
    token_amount            UInt64,
    -- curva
    virtual_quote_reserves  Nullable(UInt64),
    virtual_token_reserves  Nullable(UInt64),
    real_quote_reserves     Nullable(UInt64),
    real_token_reserves     Nullable(UInt64),
    -- pumpswap
    user_quote_amount       Nullable(UInt64),
    pool_base_reserves      Nullable(UInt64),
    pool_quote_reserves     Nullable(UInt64),
    lp_fee                  Nullable(UInt64),
    -- ambos
    protocol_fee            UInt64,
    creator_fee             UInt64,
    ix_name                 Nullable(String),
    raw_b64                 String
)
ENGINE = MergeTree
ORDER BY (mint, slot, sig, event_index);

CREATE TABLE IF NOT EXISTS events_token
(
    slot                UInt64,
    ts                  DateTime64(3, 'UTC'),
    sig                 String,
    event_index         UInt16,
    received_at         DateTime64(3, 'UTC'),
    recv_seq            UInt64,
    mint                String,
    creator             String,
    name                String,
    symbol              String,
    uri                 String,
    bonding_curve       String,
    quote_mint          String,
    token_total_supply  UInt64,
    raw_b64             String
)
ENGINE = MergeTree
ORDER BY (mint);

-- Metadados buscados da `uri` (assíncrono, pode falhar): tabela separada, só inserção.
CREATE TABLE IF NOT EXISTS token_metadata
(
    mint         String,
    fetched_at   DateTime64(3, 'UTC'),
    ok           UInt8,
    description  Nullable(String),
    image        Nullable(String),
    twitter      Nullable(String),
    telegram     Nullable(String),
    website      Nullable(String),
    raw_json     Nullable(String),
    error        Nullable(String)
)
ENGINE = MergeTree
ORDER BY (mint, fetched_at);

CREATE TABLE IF NOT EXISTS events_lifecycle
(
    kind           Enum8('curve_completed' = 1, 'pool_created' = 2),
    slot           UInt64,
    ts             DateTime64(3, 'UTC'),
    sig            String,
    event_index    UInt16,
    received_at    DateTime64(3, 'UTC'),
    recv_seq       UInt64,
    mint           String,
    bonding_curve  Nullable(String),
    pool           Nullable(String),
    quote_mint     Nullable(String),
    creator        Nullable(String),
    raw_b64        String
)
ENGINE = MergeTree
ORDER BY (mint, slot);

-- Pool do PumpSwap → base/quote (de CreatePoolEvent ou lida da conta Pool). Pré-carregada no início do ingest.
CREATE TABLE IF NOT EXISTS pools
(
    pool        String,
    base_mint   String,
    quote_mint  String,
    source      Enum8('create_pool_event' = 1, 'account' = 2),
    seen_at     DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(seen_at)
ORDER BY (pool);

-- Custos de transação amostrados (priority fee, tip Jito) para calibrar o paper executor.
CREATE TABLE IF NOT EXISTS tx_costs
(
    slot            UInt64,
    sig             String,
    sampled_at      DateTime64(3, 'UTC'),
    fee             UInt64,
    priority_fee    UInt64,
    jito_tip        Nullable(UInt64),
    compute_units   Nullable(UInt32),
    num_signatures  UInt16
)
ENGINE = MergeTree
ORDER BY (slot, sig);

CREATE TABLE IF NOT EXISTS ingest_gaps
(
    run_id       String,
    detected_at  DateTime64(3, 'UTC'),
    kind         Enum8('reconnect' = 1, 'log_truncated' = 2, 'parse_error' = 3, 'unknown_event' = 4,
                       'pool_unresolved' = 5, 'trailing_bytes' = 6),
    from_slot    Nullable(UInt64),
    to_slot      Nullable(UInt64),
    sig          Nullable(String),
    program      Nullable(String),
    detail       String
)
ENGINE = MergeTree
ORDER BY (detected_at);

CREATE TABLE IF NOT EXISTS events_social
(
    ts          DateTime64(3, 'UTC'),
    author      String,
    source      Enum8('x' = 1, 'telegram' = 2, 'other' = 3),
    text        String,
    media_urls  Array(String),
    url         String
)
ENGINE = MergeTree
ORDER BY (ts, author);

CREATE TABLE IF NOT EXISTS protocol_config
(
    ts            DateTime64(3, 'UTC'),
    run_id        String,
    program_id    String,
    account       String,
    account_type  String,
    config_json   String,
    config_hash   String
)
ENGINE = MergeTree
ORDER BY (ts);

CREATE TABLE IF NOT EXISTS runs
(
    run_id       String,
    started_at   DateTime64(3, 'UTC'),
    mode         Enum8('record' = 1, 'paper' = 2, 'live' = 3, 'replay' = 4),
    config_hash  String,
    git_commit   String,
    idl_hash     String
)
ENGINE = MergeTree
ORDER BY (run_id);

CREATE TABLE IF NOT EXISTS decisions
(
    run_id         String,
    ts             DateTime64(3, 'UTC'),
    decision_id    String,
    mint           String,
    type           Enum8('enter' = 1, 'exit' = 2, 'reject' = 3),
    reason         String,
    features_json  String
)
ENGINE = MergeTree
ORDER BY (run_id, ts);

CREATE TABLE IF NOT EXISTS fills
(
    run_id              String,
    ts                  DateTime64(3, 'UTC'),
    decision_id         String,
    mint                String,
    side                Enum8('buy' = 1, 'sell' = 2),
    sol_in              UInt64,
    sol_out             UInt64,
    token_delta         Int64,
    protocol_fee        UInt64,
    creator_fee         UInt64,
    priority_fee        UInt64,
    jito_tip            UInt64,
    rent                UInt64,
    expected_price_sol  Float64,
    realized_price_sol  Float64,
    slippage_bps        Int32,
    landed_slot         Nullable(UInt64),
    status              Enum8('filled' = 1, 'failed' = 2, 'expired' = 3),
    error               Nullable(String)
)
ENGINE = MergeTree
ORDER BY (run_id, ts);

CREATE TABLE IF NOT EXISTS signals_log
(
    run_id       String,
    ts           DateTime64(3, 'UTC'),
    signal       Enum8('risk_model' = 1, 'jev' = 2),
    input_json   String,
    output_json  String,
    latency_ms   UInt32,
    cost_usd     Nullable(Float64)
)
ENGINE = MergeTree
ORDER BY (run_id, ts);

CREATE TABLE IF NOT EXISTS wallet_stats
(
    wallet             String,
    computed_at        DateTime64(3, 'UTC'),
    pnl_lamports       Int64,
    win_rate           Float64,
    avg_hold_sec       Float64,
    sells_all_at_once  UInt8
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (wallet);
