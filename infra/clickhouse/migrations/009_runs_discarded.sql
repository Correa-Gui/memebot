-- 2026-10-02. Runs descartados não entram em análises (report/sanity/funil mostram o aviso e o motivo;
-- sanity os exclui). Ex.: run reiniciado por mudança de config. Marcar com:
--   ALTER TABLE runs UPDATE discarded = 1, discard_reason = '<motivo>' WHERE run_id = '<id>'
-- (mutação numa tabela minúscula). Nada é apagado: os eventos gravados no período continuam válidos.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS discarded UInt8 DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS discard_reason String DEFAULT ''
