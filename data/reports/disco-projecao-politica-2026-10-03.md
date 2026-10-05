# Projeção de disco e política de retenção — snapshot de 2026-10-03

> **Atualização em 2026-10-05:** depois do snapshot Parquet verificado até `2026-10-05T18:37:07.729Z`, foram aplicados TTLs de 14 dias em `events_trade.raw_b64` e 60 dias em `pumpswap_trade_extra` e `ingest_gaps`. O ClickHouse recusou TTL em `events_trade.sig`, pois a coluna pertence ao `ORDER BY`; não foi substituído por TTL de linha. Veja [auditoria de continuidade, smart money e disco](audit-continuity-smart-money-disk-2026-10-05.md) para hashes, contagens e resultado completo. As projeções e medições abaixo são o retrato de 2026-10-03, antes dessas alterações.

## 1. Tamanho atual por tabela (medido agora, `system.parts`)

| Tabela | Tamanho em disco | Linhas | Partição? | TTL hoje? |
|---|---|---|---|---|
| `events_trade` | 7,06 GiB | 19.797.702 | **não** | só coluna `raw_b64`: 30 dias |
| `pumpswap_trade_extra` | 2,06 GiB | 16.241.523 | sim, `toYYYYMM(ts)` | nenhum |
| `ingest_gaps` | 566,40 MiB | 6.325.437 | não | nenhum |
| (resto: `events_token`, `decisions`, `fills`, etc.) | ≈ 30 MiB no total | — | — | — |
| **Total memebot** | **≈ 9,69 GiB** | — | — | — |

(STATUS.md trazia 7,70 GiB porque foi gerado há algumas horas; o volume cresceu desde então —
consistente com a taxa de ingestão.)

Maiores colunas dentro de `events_trade`: `raw_b64` (3,85 GiB, já com TTL de 30 dias) e `sig`
(1,63 GiB, **sem TTL**). Dentro de `pumpswap_trade_extra`: `sig` (1,30 GiB, **sem TTL**) — ou seja, a
assinatura da transação é guardada em dobro (events_trade + pumpswap_trade_extra) e cresce pra sempre
nas duas.

**Disco do host:** 167 GiB livres de 931 GiB (83% usado), medido no STATUS mais recente. Isso é disco
do HOST/Docker, não só memebot — os ≈ 9,69 GiB do banco são uma fração pequena dos 764 GiB já usados;
a maior parte do uso não é do memebot (provavelmente WSL2/Docker Desktop, imagens, outros dados).
**Recomendo checar isso separadamente** — não dá pra resolver os 83% com política de TTL no memebot,
já que o banco não é a causa principal do uso atual.

## 2. Taxa de crescimento medida

Usei o bloco de gravação mais longo e estável (2026-10-01 22:16 → 2026-10-02 11:53 UTC, 13h37min =
817 min, contínuo) pra medir taxa real, em vez de média sobre todo o período (que inclui sessões
curtas de dev com taxa diferente):

| Tabela | Linhas no bloco | Linhas/hora |
|---|---|---|
| `events_trade` | 12.816.390 | ≈ 940.800/h |
| `pumpswap_trade_extra` | 10.652.070 | ≈ 782.600/h |
| `ingest_gaps` | 155 | ≈ 11/h (baixo nesse bloco — ver §4) |

Bytes por linha (tamanho atual / linhas atuais):
- `events_trade` **sem** `raw_b64` (parte que não tem TTL, cresce pra sempre): 3,21 GiB / 19,8 M ≈ **165 bytes/linha**.
- `events_trade` só `raw_b64` (tem TTL 30 dias, platô, não cresce indefinidamente): 206 bytes/linha.
- `pumpswap_trade_extra` (sem TTL, cresce pra sempre): 2,06 GiB / 16,2 M ≈ **136 bytes/linha**.

### Projeção — se `memebot-record` ficar ligado 24/7 a partir de agora (é o que está rodando agora no pm2)

| Componente | Crescimento/dia |
|---|---|
| `events_trade` sem `raw_b64` (permanente) | ≈ 3,47 GiB/dia |
| `pumpswap_trade_extra` (permanente, sem TTL) | ≈ 2,39 GiB/dia |
| `raw_b64` (platô em ~30 dias, não some, só deixa de CRESCER) | ≈ 4,3 GiB/dia até o platô (~130 GiB de platô se rodar 24/7 o mês todo) |
| **Total nos primeiros ~30 dias** | **≈ 10,2 GiB/dia** |
| **Total depois do platô do `raw_b64`** | **≈ 5,9 GiB/dia (permanente, sem mais nada)** |

Com 167 GiB livres: **≈ 16 dias até estourar o disco** se `memebot-record` continuar 24/7 nesse
ritmo (fase de rampa do `raw_b64`), ou ≈ 28 dias (167/5,9) se já estivesse em regime permanente — ou
seja, o número realista hoje é **entre 2 e 3 semanas**, não meses. Isso é bem mais urgente do que o
STATUS sugere, porque o STATUS foi escrito olhando pra um padrão de uso intermitente (sessões curtas),
e agora o pm2 mostra `memebot-record` ligado continuamente de novo.

### Projeção — se continuar no padrão intermitente observado (≈ 17% do tempo ligado, como nos últimos 4 dias)

Mesmas taxas ÷ ~5,8 (fator do duty cycle): ≈ 1,0–1,7 GiB/dia → **≈ 100–160 dias até estourar**.

**A diferença entre os dois cenários é grande — a decisão de deixar `memebot-record` ligado 24/7 ou
intermitente muda o prazo em ~6x.** Vale confirmar qual é o plano antes de decidir a urgência da
política abaixo.

## 3. Política definida em 2026-10-03 (situação atualizada abaixo)

Objetivo do usuário: manter uso abaixo de 80% sem perder o que importa pra smart money/ML (trades
decodificados, tokens, pools). As colunas DECODIFICADAS (preços, reservas, fees, side, mint, etc.) já
são a maior parte das tabelas depois de tirar `raw_b64`/`sig` — ou seja, dá pra manter o que importa e
só aliviar o que é redundante ou só histórico de depuração.

### 3.1 `pumpswap_trade_extra` — TTL de partição (fácil, já particionada por mês)

```sql
ALTER TABLE memebot.pumpswap_trade_extra
  MODIFY TTL toDateTime(ts) + INTERVAL 60 DAY DELETE;
```

Como já é `PARTITION BY toYYYYMM(ts)`, a deleção é por partição inteira (rápida, sem mutation custosa).
**Precisa exportar antes** (ver 3.3) porque perde a linha inteira, não só uma coluna.

### 3.2 `events_trade` — baixar TTL do `raw_b64` e adicionar TTL na coluna `sig`

`raw_b64` já tem TTL de 30 dias (zera a coluna, mantém a linha — os dados decodificados continuam).
Isso já evita crescimento ilimitado dessa coluna. Duas opções, à escolha:
- Manter 30 dias (platô ~130 GiB em uso 24/7) — ok se o disco crescer (ver §4 do host).
- Baixar pra 14 dias (platô ~60 GiB) se quiser mais margem.

`sig` (1,63 GiB hoje, sem TTL, crescimento permanente) — adicionar TTL de coluna também, ex.:

Expression prevista para o TTL de `sig` (não aplicável no esquema atual):

```sql
ALTER TABLE memebot.events_trade
  MODIFY COLUMN sig String TTL toDateTime(received_at) + toIntervalDay(45);
```

O ClickHouse 24.8 a rejeita com `Trying to set TTL for key column sig`.

`sig` só é necessário pra correlacionar com `pumpswap_trade_extra` e para dedupe/auditoria de curto
prazo. Embora a política proponha TTL de coluna, o ClickHouse 24.8 rejeita TTL em `sig`, pois ela faz
parte do `ORDER BY (mint, slot, sig, event_index)`. TTL de linha apagaria também os dados decodificados
e teria custo alto sem partição temporal; por isso não foi usado. Para limitar `sig` preservando os
trades, será necessária uma migração de esquema que retire essa coluna da chave de ordenação, com
recriação ordenada da tabela.

### 3.3 Export pra Parquet antes de qualquer TTL/delete apagar dados

Antes de qualquer linha ser deletada (`pumpswap_trade_extra`, `ingest_gaps`) ou coluna ser zerada
(`raw_b64`), rodar o job `pnpm export:cold` que:

1. Seleciona o intervalo que vai expirar em N dias (janela de segurança, ex. exporta dados que
   completam 25 dias quando o TTL é 30 — dá 5 dias de margem pra rodar/conferir).
2. Grava em Parquet comprimido (`FORMAT Parquet`, `ZSTD`) particionado por tabela/data, ex.:
   `data/cold/events_trade/dt=2026-10-01/part-0000.parquet`.
3. Confere contagem de linhas exportadas = contagem de linhas na janela antes de seguir.
4. Só então o TTL (configurado com margem, acima) libera o ClickHouse.

Isso preserva 100% do histórico fora do ClickHouse (fica fora do caminho crítico do `pnpm report`/
`pnpm backtest`, mas disponível se precisar reprocessar `sig`/`raw_b64` antigos pra ML/smart money).

### 3.4 `ingest_gaps`

Tabela pequena (566 MiB) — TTL simples de linha é suficiente, sem precisar de partição:

```sql
ALTER TABLE memebot.ingest_gaps
  MODIFY TTL toDateTime(detected_at) + INTERVAL 60 DAY DELETE;
```

## 4. Observações do retrato de 2026-10-03, revisadas em 2026-10-05

1. A leitura de 83% de uso do host e 167 GiB livres é de 2026-10-03, antes do snapshot Parquet; não é
   a medição atual. Em `2026-10-05T20:41:45Z`, C: tinha 17,76 GiB livres e o snapshot ocupava 21,23 GiB
   em `data/cold`. Como nenhuma linha atingiu a idade dos TTLs, eles ainda não liberaram espaço.
2. A hipótese de 2026-10-03 de que 6,3 M linhas eram principalmente `pool_unresolved` foi corrigida:
   99,4% eram `trailing_bytes` (8 bytes extras em eventos ainda decodificados); havia 23.894
   `pool_unresolved`. Ver a auditoria de 2026-10-05 para a divisão e impacto no replay/dataset.

## 5. Resumo das ações e situação em 2026-10-05

| Ação | Tabela | Situação |
|---|---|---|---|
| `TTL toDateTime(ts) + 60 DAY DELETE` (com Parquet conferido) | `pumpswap_trade_extra` | Aplicado após export. |
| `MODIFY COLUMN sig ... TTL 45 DAY` | `events_trade` | Não aplicado: coluna de chave de ordenação; requer migração da tabela. |
| `raw_b64` TTL 30→14 dias | `events_trade` | Aplicado após export; linhas permanecem no ClickHouse. |
| `TTL toDateTime(detected_at) + 60 DAY DELETE` | `ingest_gaps` | Aplicado após export. |
| `pnpm export:cold --snapshot --through 2026-10-05T18:37:07.729Z` | três tabelas | 708 partes verificadas; manifesto e hashes em `data/cold/manifest.json`. |
