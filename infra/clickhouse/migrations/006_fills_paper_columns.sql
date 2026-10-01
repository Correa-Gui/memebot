-- ROADMAP Fase 3 (2026-10-01): colunas de `fills` usadas pelo paper executor
-- (packages/execution/src/fill.ts) e pelo `pnpm report`. Criada como 006_fills_venue_unverified.sql
-- na parte B e renomeada/ampliada ANTES de ser aplicada (a versão de uma migração é o nome do arquivo,
-- ver infra/clickhouse/migrate.ts; nenhum banco registrou a 006 em schema_migrations).
-- Todas as colunas novas têm DEFAULT: ADD COLUMN com DEFAULT cobre linhas existentes na leitura, sem
-- UPDATE/mutação (a tabela `fills` estava vazia quando esta migração foi escrita).
--
-- venue_unverified: 1 = posição fechada no último preço da bonding curve porque o token graduou
--   (o swap do PumpSwap ainda não é simulado — docs/ROADMAP.md Fase 2 / docs/STRATEGY.md §2).
-- cost_estimate_source: origem da priority fee/tip ('tx_costs_median' ou 'fallback' quando há
--   menos amostras em tx_costs que PAPER_COST_MIN_SAMPLES); 'unknown' para linhas antigas.
-- cost_capped: 1 = a estimativa passou do limite (hard limit/config) e foi trocada pelo limite.
-- rent_refund: rent da conta de token devolvido na venda que zera a posição.
-- base_fee: taxa base por assinatura do runtime da Solana (5000 lamports × assinaturas,
--   https://solana.com/docs/core/fees), cobrada em toda tx que entra no bloco (filled/failed/expired).
-- expected/realized_price_*: o valor sempre foi lamports por unidade mínima do token (mesma unidade
--   de `marginalPrice`), não SOL — o nome antigo `*_price_sol` enganava.
-- virtual_quote_before/virtual_token_before: reservas virtuais da curva usadas no preenchimento
--   (antes da nossa ordem); 0 = sem reservas. Usadas pela tabela de sensibilidade do `pnpm report`.
ALTER TABLE fills ADD COLUMN IF NOT EXISTS venue_unverified UInt8 DEFAULT 0;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS cost_estimate_source Enum8('unknown' = 0, 'tx_costs_median' = 1, 'fallback' = 2) DEFAULT 'unknown';
ALTER TABLE fills ADD COLUMN IF NOT EXISTS cost_capped UInt8 DEFAULT 0;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS rent_refund UInt64 DEFAULT 0;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS base_fee UInt64 DEFAULT 0;
ALTER TABLE fills RENAME COLUMN IF EXISTS expected_price_sol TO expected_price_lamports_per_unit;
ALTER TABLE fills RENAME COLUMN IF EXISTS realized_price_sol TO realized_price_lamports_per_unit;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS virtual_quote_before UInt64 DEFAULT 0;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS virtual_token_before UInt64 DEFAULT 0;
