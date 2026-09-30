-- ROADMAP Fase 1, item 3 (validação externa 2026-09-30): runs no RPC público não têm a mesma
-- confiabilidade (429 frequente, pools sem resolver) de runs no RPC pago. `quality` marca isso
-- para sanity/backtest excluírem por padrão (ver apps/bot/src/sanity.ts, docs/ARCHITECTURE.md §6).
-- DEFAULT 'provisional': toda execução registrada até aqui usou o RPC público
-- (api.mainnet-beta.solana.com); ADD COLUMN com DEFAULT já cobre as linhas existentes na leitura,
-- sem precisar de UPDATE/mutação.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS quality Enum8('provisional' = 1, 'production' = 2) DEFAULT 'provisional';
