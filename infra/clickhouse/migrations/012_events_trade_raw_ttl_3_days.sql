-- 2026-10-06: reduzir apenas raw_b64; linhas e campos decodificados permanecem.
-- Snapshot verificado até 2026-10-05T18:37:07.729Z em data/cold/manifest.json.
-- Não materializar em massa com C: baixo: partes existentes podem manter o TTL
-- antigo até serem mescladas/recalculadas. Reavaliar após recuperar espaço.
ALTER TABLE events_trade MODIFY COLUMN raw_b64 String TTL toDateTime(received_at) + INTERVAL 3 DAY
SETTINGS materialize_ttl_after_modify = 0;
