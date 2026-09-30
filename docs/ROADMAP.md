# Roadmap

Regra: uma fase por vez. Só avance quando **todos** os critérios de aceite da fase estiverem marcados.
Os dias são estimativas para quem trabalha diariamente no projeto com o Claude Code.

## Marcos principais

| Marco | Dia estimado | O que você tem |
|---|---|---|
| M1 — Dados em stream gravando | **dia 2–3** | Eventos do Pump.fun chegando e salvos no ClickHouse 24h |
| M2 — Primeiro paper trading ao vivo | **dia 7–10** | Estratégia por regras simples operando em simulação, com custos reais |
| M3 — Backtest confiável | dia 12–15 | Replay determinístico + relatório de PnL líquido |
| M4 — Modelo de risco + sinais | dia 15–21 | XGBoost, smart money e (opcional) Jev como features |
| M5 — Live em micro-tamanho | dia 21+ | Só se M2–M4 mostrarem expectativa positiva após taxas |

---

## Fase 0 — Fundação (dia 1)

- [x] Monorepo pnpm, TypeScript estrito, vitest, eslint, `pnpm check`.
- [x] `packages/core`: tipos `Lamports`/`TokenAmount`, `Clock`, config com zod carregando `.env`, logger pino com redação de segredos (teste provando a redação).
- [x] `.gitignore` com `.env`, `*.keypair.json`, `secrets/`, `data/`.
- [x] `docker-compose.yml` com ClickHouse e script de migração das tabelas de `ARCHITECTURE.md` §6.
- [x] `config/protocol.ts` com program IDs do Pump.fun e PumpSwap (fonte + data em comentário).

**Aceite:** `pnpm check` passa; `docker compose up -d` sobe o banco e as migrações criam as tabelas.

## Fase 1 — Ingestão e gravação (dias 1–3) → M1

- [x] `packages/ingest`: fonte **WebSocket** (`logsSubscribe` com `mentions` nos programas Pump.fun e PumpSwap, commitment `confirmed`); reconexão automática com backoff; heartbeat. Parse dos eventos Anchor nas linhas `Program data:` dos logs.
- [x] Detecção de lacunas: ao reconectar, registrar o intervalo de slots perdido em uma tabela `ingest_gaps` (o backtest ignora tokens afetados).
- [x] A fonte fica atrás da interface `EventSource`; `INGEST_SOURCE=grpc` (Yellowstone) fica como implementação opcional para depois.
- [x] Parser dos eventos (`token_created`, `trade`, `curve_completed`, `pool_created`) a partir dos logs/eventos do programa. Usar o IDL oficial. *(Decoder genérico dirigido pelo IDL oficial vendorizado + checagem de tipo por campo; zod nas fronteiras RPC/WebSocket. Testado com 6 transações reais gravadas em `packages/ingest/test/fixtures`.)*
- [x] Captura de `priorityFee` e tip Jito ~~de cada transação~~ **por amostragem** (para calibrar custos depois). *(Desvio deliberado: buscar toda transação custaria até ~400 GB/dia de RPC — ver ARCHITECTURE §8. Tabela `tx_costs`.)*
- [x] `packages/recorder`: inserção em lote no ClickHouse (flush a cada 1 s ou 1.000 eventos), sem perder eventos em reconexão.
- [x] Leitura periódica da configuração de taxas on-chain → `protocol_config`.
- [x] Busca assíncrona dos metadados do token (URI → nome, descrição, imagem, links sociais) com timeout.
- [ ] `pnpm bot --mode=record` rodando via systemd — **adiado para a migração à VPS** (ver seção "Migração para VPS"). *(Unit pronta em `infra/systemd/`. Enquanto isso, o bot roda localmente com pm2 — ver README.)*
- [x] Script de sanidade: contagem de eventos por minuto, tokens criados por hora, gaps de slot. *(`pnpm sanity --hours=24`)*
- [x] Modo de conferência manual: `pnpm bot --mode=record --debug-events=20` imprime os eventos com link do Solscan, sem gravar.

**Aceite:** ≥ 12 h contínuas localmente sem gap > 60 s (ou gaps registrados em `ingest_gaps`); contagem de tokens criados por hora na mesma ordem de grandeza das fontes públicas (Dune/Bitquery). 24 h completas passam a ser critério da migração para VPS. *(Verificar com `pnpm sanity --hours=12`.)*

## Fase 2 — Matemática exata e estado (dias 3–6)

- [ ] `packages/curve-math`: buy/sell na bonding curve e no PumpSwap, com taxas vindas da config lida.
- [ ] Fixtures "golden": 50+ trades reais gravados; teste que reproduz os valores **exatos**.
- [ ] Testes de propriedade (comprar e vender em seguida sempre perde as taxas; preço cresce com o supply vendido).
- [ ] `packages/state`: estado em memória por token (reservas, holders e saldos, fluxo de compra/venda por janela, primeiros compradores, carteiras do criador).
- [ ] Coleta de **rugs rotulados** (queda de TVL / inatividade, conforme a literatura) para treino futuro.

**Aceite:** 100% dos fixtures golden batem com 0 de diferença na matemática da curva.

## Fase 3 — Estratégia por regras + paper executor (dias 5–10) → M2

- [ ] `packages/features` v0 (só regras, sem ML): idade do token, progresso da curva, holders únicos, % do top 10, % dos primeiros compradores do mesmo bloco (proxy de bundle), razão buy/sell 60 s, volume 60 s, se o criador já tem tokens anteriores.
- [ ] `packages/strategy` v0 conforme `docs/STRATEGY.md` (filtros duros + gatilho de momentum + saídas).
- [ ] `packages/risk`: `hard-limits.ts`, sizing fixo, máximo de posições simultâneas, limite de perda diária, kill switch.
- [ ] `packages/execution/paper.ts` pessimista (latência, custos, falhas) conforme `ARCHITECTURE.md` §5.
- [ ] `packages/positions`: take profit escalonado, stop, time stop.
- [ ] `pnpm bot --mode=paper` gravando `decisions` e `fills`.
- [ ] `packages/monitor`: alerta Telegram a cada entrada/saída e resumo a cada hora.
- [ ] `pnpm report --run=<id>`: nº de trades, taxa de acerto, PnL bruto e **líquido**, custos por categoria, distribuição de retornos, drawdown.

**Aceite:** paper rodando 24 h sem travar; cada fill tem custos detalhados; relatório gerado.

## Fase 4 — Backtest determinístico (dias 9–15) → M3

- [ ] `EventSource` de replay a partir do ClickHouse, `Clock` simulado.
- [ ] `apps/backtest` com config versionada; resultado gravado em `runs` com hash da config e commit git.
- [ ] Teste: mesmo intervalo, duas execuções, decisões idênticas.
- [ ] Comparar backtest × paper do mesmo período (diferença deve ser pequena; se não for, corrigir antes de seguir).
- [ ] Separação treino/validação **por tempo** (nunca aleatória) para qualquer ajuste de parâmetro.

**Aceite:** divergência backtest × paper < 10% no PnL líquido do mesmo período; replay determinístico.

## Fase 5 — Sinais (dias 12–21) → M4

Cada item só entra na estratégia se o backtest fora da amostra melhorar o PnL líquido.
- [ ] `research/`: dataset de features aos N minutos de vida + rótulo (rug / sobreviveu / retorno futuro).
- [ ] XGBoost de risco; export ONNX; `signals/risk-model` com o mesmo cálculo de features do TS (teste de paridade Python × TS).
- [ ] `wallets/`: métricas por carteira (PnL, acerto, tempo médio de posição, se vende tudo de uma vez); lista de smart money recalculada diariamente; feature "n de smart wallets comprando".
- [ ] `social/`: fonte de posts de contas monitoradas (lista em `config/social-accounts.yaml`). Avaliar custo da API do X antes de assinar.
- [ ] `signals/narrative`: cliente Jev atrás de `NarrativeClassifier`, com timeout, cache por (post, mint) e log em `signals_log`.
- [ ] Ablação no backtest: estratégia com e sem cada sinal.

**Aceite:** relatório de ablação mostrando o ganho (ou não) de cada sinal; só os que ajudam ficam ativos.

## Fase 6 — Live em micro-tamanho (dia 21+) → M5

Pré-requisitos: ≥ 200 operações em paper com PnL líquido positivo **e** backtest fora da amostra positivo.
- [ ] `execution/live.ts`: monta a transação, simula, envia (RPC com priority fee + Jito com `jitodontfront`), confirma, registra fill real.
- [ ] Fechamento de contas de token vazias (recuperar rent) implementado localmente.
- [ ] Carteira quente dedicada com saldo pequeno; saldo máximo verificado a cada operação.
- [ ] Rodar live e paper **em paralelo** nos mesmos sinais para medir a diferença real (slippage, falhas).
- [ ] Tamanho inicial: o menor de `hard-limits.ts` (ex.: 0,02–0,05 SOL por operação).

**Aceite:** 100 operações live; diferença live × paper medida e usada para recalibrar o paper executor.

## Migração para VPS

Por enquanto o bot roda na máquina local (pm2). A migração pode acontecer a qualquer momento depois da Fase 1
e é **pré-requisito da Fase 6** (live não roda em máquina pessoal).

- [ ] VPS Linux (Ubuntu 24.04) na mesma região do RPC pago; ClickHouse via `docker compose` com dados migrados da máquina local (export/import Parquet).
- [ ] **systemd:** instalar `infra/systemd/memebot-record.service` seguindo `infra/systemd/README.md` (usuário `memebot`, `.env` com permissão 600, `Restart=always`); conferir parada limpa com `systemctl stop` (buffer gravado).
- [ ] **24 h de gravação** contínua sem gap > 60 s; `pnpm sanity --hours=24` com tokens/hora na mesma ordem de grandeza de Dune/Bitquery.
- [ ] **Teste de latência:** `ping` para `ny.mainnet.block-engine.jito.wtf` e `frankfurt.mainnet.block-engine.jito.wtf`; latência HTTP/WebSocket até o RPC; linha de base de `received_at − ts` (`pnpm sanity`) comparada com a medida local — escolher a região pelo menor valor.
- [ ] **Hardening** (RISK_AND_SECURITY §4): usuário sem sudo, SSH só por chave e senha desativada, `ufw` liberando só SSH, portas do ClickHouse só em `127.0.0.1`, `unattended-upgrades`, `systemd-analyze security memebot-record` revisado, backup semanal em Parquet para fora da VPS (sem chaves).

**Aceite:** os cinco itens acima; a partir daí o systemd substitui o pm2 e a VPS vira o ambiente padrão de gravação.

## Backlog (avaliar depois da Fase 5, só com evidência nos dados)

- [ ] **Grafo de financiamento de holders** (estilo "bubble map"): agrupar carteiras que receberam SOL da mesma origem nas últimas N horas; feature "% do supply em clusters ligados". Complementa o proxy de bundle da Fase 3.
- [ ] **Canais de "call" do Telegram como fonte social (só leitura):** registrar cada call (canal, mint, horário) e medir o que acontece com o preço depois. Gera um score por canal: quem chama cedo e bem × quem chama para vender em cima dos seguidores. Entra como feature, nunca como gatilho.
- [ ] **Narrativas de posts antigos:** permitir ao `NarrativeClassifier` casar tokens com posts antigos de contas relevantes (tokens criados sobre algo dito meses atrás), usando um índice local dos posts gravados.
- [ ] **Outras redes (BNB Chain, Base):** só se os dados da Solana justificarem. Exige novo `ingest`, nova `curve-math` e novo parser por launchpad; a estratégia e o risco reaproveitam as interfaces.
