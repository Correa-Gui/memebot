-- ROADMAP Fase 1, item 2 (validação externa 2026-09-30): renomeia `pools` para `pumpswap_pools`
-- (nome mais específico — só guarda pools do PumpSwap) e adiciona created_slot.
-- Pools resolvidas por leitura de conta (pool criada antes da gravação) não têm slot de criação
-- conhecido: created_slot fica 0 nesse caso (ver packages/recorder/src/recorder.ts).
RENAME TABLE pools TO pumpswap_pools;
ALTER TABLE pumpswap_pools ADD COLUMN IF NOT EXISTS created_slot UInt64 DEFAULT 0 AFTER quote_mint;

-- Flag explícita em vez de inferir "não resolvida" de mint = '' (pedido da validação externa).
ALTER TABLE events_trade ADD COLUMN IF NOT EXISTS pool_unresolved UInt8 DEFAULT 0;

-- v_trades agora lê de pumpswap_pools; mint_backfilled sinaliza quando o mint veio do join
-- (pool ainda não estava resolvida na gravação), para quem quiser tratar essas linhas à parte.
CREATE OR REPLACE VIEW v_trades AS
SELECT
    t.* EXCEPT (mint, quote_mint),
    if(t.mint = '', p.base_mint, t.mint) AS mint,
    if(t.quote_mint = '', p.quote_mint, t.quote_mint) AS quote_mint,
    t.pool_unresolved = 1 AND p.base_mint != '' AS mint_backfilled
FROM events_trade AS t
LEFT JOIN (SELECT pool, base_mint, quote_mint FROM pumpswap_pools FINAL) AS p ON t.pool = p.pool
SETTINGS join_use_nulls = 0;
