-- Trades com o mint preenchido a partir da tabela `pools` quando a pool não estava resolvida na gravação
-- (mint = ''). Consultas de análise/backtest devem ler desta view, não de events_trade direto.
CREATE VIEW IF NOT EXISTS v_trades AS
SELECT
    t.* EXCEPT (mint, quote_mint),
    if(t.mint = '', p.base_mint, t.mint) AS mint,
    if(t.quote_mint = '', p.quote_mint, t.quote_mint) AS quote_mint,
    t.mint = '' AND p.base_mint != '' AS mint_backfilled
FROM events_trade AS t
LEFT JOIN (SELECT pool, base_mint, quote_mint FROM pools FINAL) AS p ON t.pool = p.pool
SETTINGS join_use_nulls = 0;
