-- Corrige um esquecimento da migração 003: o kind IngestGap 'pool_unresolved' foi renomeado para
-- 'pool_resolve_failed' no código (packages/core/src/events.ts), mas o Enum8 desta coluna não
-- tinha sido atualizado — toda gravação de um gap desse tipo falhava com UNKNOWN_ELEMENT_OF_ENUM.
-- Mantém o valor antigo no enum (linhas históricas continuam legíveis) e adiciona o novo.
ALTER TABLE ingest_gaps MODIFY COLUMN kind
    Enum8('reconnect' = 1, 'log_truncated' = 2, 'parse_error' = 3, 'unknown_event' = 4,
          'pool_unresolved' = 5, 'trailing_bytes' = 6, 'pool_resolve_failed' = 7);
