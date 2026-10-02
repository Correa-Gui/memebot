-- 2026-10-02, pedido do usuário: TTL de 30 dias SÓ na coluna raw_b64 de events_trade.
-- Os eventos (linhas) e todos os campos decodificados ficam para sempre — a regra "eventos brutos
-- sem TTL" (001_init.sql, ARCHITECTURE §6) continua valendo para as linhas. Depois de 30 dias
-- (contados de received_at) o raw_b64 volta ao valor padrão da coluna (string vazia); o que se perde é
-- só a possibilidade de re-decodificar trades antigos com um IDL futuro.
-- Motivo: raw_b64 é a maior parte do disco (~9 GB/dia de events_trade medido em 2026-10-01).
-- Column TTL exige DateTime (não DateTime64): toDateTime(received_at).
ALTER TABLE events_trade MODIFY COLUMN raw_b64 String TTL toDateTime(received_at) + INTERVAL 30 DAY
