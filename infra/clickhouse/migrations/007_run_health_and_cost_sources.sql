-- 2026-10-01. Qualidade de run MEDIDA (substitui a heurística "endpoint público") e origem dos custos
-- por tipo nos fills.
--
-- ingest_gaps.duration_ms: tempo sem stream de uma lacuna `reconnect` — da última mensagem recebida
--   antes do silêncio até a primeira notificação depois de reconectar (inclui os 30 s de heartbeat).
--   0 para os outros tipos (são pontuais) e para linhas antigas.
-- run_health: uma linha por minuto por run (gravada pelo próprio bot, então sobrevive a um crash até o
--   último minuto). stream_gap_ms é cumulativo e inclui uma lacuna ainda aberta. rpc_host/ws_host são só
--   o host (sem path/query, onde provedores põem a API key) — informativo.
-- v_run_quality: provisional quando o tempo sem stream passa de 1% do tempo do run (ver ARCHITECTURE §6).
-- fills.priority_fee_source / jito_tip_source: origem de cada custo — mediana × 1,5 (≥ mínimo de amostras),
--   p75 das amostras disponíveis (poucas amostras) ou fallback configurado (nenhuma amostra).
ALTER TABLE ingest_gaps ADD COLUMN IF NOT EXISTS duration_ms UInt64 DEFAULT 0;

CREATE TABLE IF NOT EXISTS run_health
(
    run_id String,
    ts DateTime64(3, 'UTC'),
    uptime_ms UInt64,
    stream_gap_ms UInt64,
    rpc_host String,
    ws_host String
)
ENGINE = MergeTree
ORDER BY (run_id, ts);

CREATE VIEW IF NOT EXISTS v_run_quality AS
SELECT
    run_id,
    argMax(uptime_ms, ts) AS uptime_ms,
    argMax(stream_gap_ms, ts) AS stream_gap_ms,
    argMax(rpc_host, ts) AS rpc_host,
    argMax(ws_host, ts) AS ws_host,
    if(uptime_ms = 0, 0, stream_gap_ms / uptime_ms) AS stream_gap_ratio,
    if(stream_gap_ratio > 0.01, 'provisional', 'production') AS measured_quality
FROM run_health
GROUP BY run_id;

ALTER TABLE fills ADD COLUMN IF NOT EXISTS priority_fee_source Enum8('unknown' = 0, 'tx_costs_median' = 1, 'tx_costs_p75' = 2, 'fallback' = 3) DEFAULT 'unknown';
ALTER TABLE fills ADD COLUMN IF NOT EXISTS jito_tip_source Enum8('unknown' = 0, 'tx_costs_median' = 1, 'tx_costs_p75' = 2, 'fallback' = 3) DEFAULT 'unknown'
