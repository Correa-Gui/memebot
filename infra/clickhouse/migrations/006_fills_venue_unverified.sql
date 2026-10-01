-- ROADMAP Fase 3/parte B (2026-10-01): colunas novas de `fills` usadas pelo paper executor
-- (packages/execution/src/fill.ts). Todas com DEFAULT: ADD COLUMN com DEFAULT cobre as linhas
-- existentes na leitura, sem UPDATE/mutação.
-- venue_unverified: 1 = posição fechada no último preço da bonding curve porque o token graduou
--   (o swap do PumpSwap ainda não é simulado — docs/ROADMAP.md Fase 2 / docs/STRATEGY.md §2).
-- cost_estimate_source: origem da priority fee/tip ('tx_costs_median' ou 'fallback' quando há
--   menos amostras em tx_costs que PAPER_COST_MIN_SAMPLES); 'unknown' para linhas antigas.
-- cost_capped: 1 = a estimativa passou do limite (hard limit/config) e foi trocada pelo limite.
-- rent_refund: rent da conta de token devolvido na venda que zera a posição.
ALTER TABLE fills ADD COLUMN IF NOT EXISTS venue_unverified UInt8 DEFAULT 0;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS cost_estimate_source Enum8('unknown' = 0, 'tx_costs_median' = 1, 'fallback' = 2) DEFAULT 'unknown';
ALTER TABLE fills ADD COLUMN IF NOT EXISTS cost_capped UInt8 DEFAULT 0;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS rent_refund UInt64 DEFAULT 0;
