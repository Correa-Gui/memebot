# Roadmap

Regra: uma fase por vez. Só avance quando **todos** os critérios de aceite da fase estiverem marcados.
Os dias são estimativas para quem trabalha diariamente no projeto com o Claude Code.

## Marcos principais

| Marco | Dia estimado | O que você tem |
|---|---|---|
| M1 — Dados em stream gravando (local) | **dia 2–3** | Eventos do Pump.fun chegando e salvos no ClickHouse local 24h, via pm2 |
| M2 — Primeiro paper trading ao vivo | **≈ dia 8** | Estratégia por regras simples operando em simulação, com custos reais |
| Ponto de decisão — ≈ 200 operações em paper | **≈ dia 15** | Critério de sucesso da `docs/STRATEGY.md` §7 avaliado; decide se segue para backtest/sinais/VPS |
| VPS + live mínimo | **≈ dia 20** (condicional) | Só se o ponto de decisão acima for aprovado |
| M3 — Backtest confiável | condicional (Fase 4) | Replay determinístico + relatório de PnL líquido — só se o paper indicar |
| M4 — Modelo de risco + sinais | condicional (Fase 5) | XGBoost, smart money e (opcional) Jev como features — só se o paper indicar |
| M5 — Live em micro-tamanho | dia 21+ | Só se M2 e o ponto de decisão mostrarem expectativa positiva após taxas |

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

- [x] `packages/curve-math`: buy/sell na bonding curve e no PumpSwap, com taxas vindas da config lida.
  *(Curva: exata desde a Fase 2. PumpSwap: exato desde 2026-10-02 — `pumpSwapBuyExactBaseOut` (instrução
  `buy`), `pumpSwapBuyExactQuoteIn` (`buy_exact_quote_in`) e `pumpSwapSell` em
  `packages/curve-math/src/pumpswap.ts`, 0 de diferença em base, quote bruto/líquido, cada taxa e reservas
  depois do swap. A divergência registrada antes (pool `DycbAuWK…`, sell, `quoteOutGross` 200653 calculado ×
  215867 real) vinha de ignorar `virtual_quote_reserves` (i128) da conta `Pool`/eventos — ver tarefa
  "Resolver swap exato do PumpSwap" abaixo.)*
- [x] Fixtures "golden": 50+ trades reais gravados; teste que reproduz os valores **exatos**.
  *(120 fixtures da bonding curve, extraídas de `memebot.events_trade` — `packages/curve-math/scripts/extract-golden-fixtures.ts`
  — 0 de diferença em `tokenOut`/`quoteOutGross`/taxas/reservas. PumpSwap: 99 fixtures de eventos reais
  decodificados do `raw_b64` (`packages/curve-math/scripts/extract-pumpswap-fixtures.ts`) — 30+ `buy`,
  30+ `buy_exact_quote_in`, 30+ `sell`, pools com quote WSOL, base WSOL e quote ≠ WSOL, com e sem reserva
  virtual, com cashback — 0 de diferença em tudo, inclusive reservas depois (= reservas do próximo evento
  do mesmo pool). Mais 3 transações reais via RPC em `test/fixtures/pumpswap-rpc/vaults.json`, conferindo
  as reservas com os saldos das vaults da pool.)*
- [x] Testes de propriedade (comprar e vender em seguida sempre perde as taxas; preço cresce com o supply vendido).
- [x] `packages/state`: estado em memória por token (reservas, holders e saldos, fluxo de compra/venda por janela, primeiros compradores, carteiras do criador).

**Aceite:** 100% dos fixtures golden batem com 0 de diferença na matemática da curva. *(Cumprido para a bonding
curve — 120/120 fixtures reais com 0 de diferença — e, desde 2026-10-02, também para o PumpSwap — 99/99
fixtures reais e 3/3 transações conferidas via RPC. A v0 continua restrita à bonding curve
(`filters.allowedVenues: [curve]`); incluir tokens graduados é decisão do usuário, ver `docs/STRATEGY.md` §2.)*

- [x] **Resolver swap exato do PumpSwap** (pré-requisito para incluir tokens graduados no universo, v1).
  *(2026-10-02. Causa: o IDL oficial `pump_amm.json` tem `virtual_quote_reserves: i128` na conta `Pool` e nos
  eventos `BuyEvent`/`SellEvent`; o constant product usa `Qe = pool_quote_token_reserves +
  virtual_quote_reserves` (≈ 17,58 SOL nas pools graduadas da Pump.fun; 0 em pools sem offset) e a base real.
  Confirmado: (1) via RPC — reservas do evento = `preTokenBalances` das vaults e `Pool.virtual_quote_reserves`
  lido por `getAccountInfo` = campo do evento (pool `Cr469Kh7…`, 3 tx, `test/fixtures/pumpswap-rpc/`);
  (2) em massa — 52.758 eventos (40 pools WSOL) + amostras de pools com base WSOL e quote ≠ WSOL, 100% exatos;
  continuidade de reservas entre eventos consecutivos 46.829/46.864 (as 35 quebras são evento faltando/ordem
  no slot: base e quote quebram juntas). Regras: taxas `ceil(valor·bps/10000)` por componente (lp, protocolo,
  criador, cashback); venda `bruto = floor(Qe·in/(B+in))`, vault perde `bruto − lp`; `buy` (base exata)
  `líquido = ceil(Qe·out/(B−out))`; `buy_exact_quote_in`: `n0 = floor(gastável·10000/(10000+Σbps))`, taxas
  sobre `n0`, `líquido = min(n0, gastável − taxas)`, `out = floor(B·(líquido−1)/(Qe+líquido−1))`; nas duas
  compras a vault ganha `líquido + lp`. O tier de taxa usa market cap com `Qe` (99,0% de acerto contra 88,3%
  com o saldo real; exceções são pools fora da regra de tiers). Custo de ida e volta medido nos fixtures
  (compra + venda imediata, 0,1 SOL, quote WSOL): ~237 bps no tier 20/5/95, ~247 bps no tier 2/93/30, ~218 bps
  no 20/5/85. **Pendente fora deste pacote (resolvido no item seguinte):** o `normalize` (`packages/ingest`) ainda não gravava
  `virtual_quote_reserves`/`cashback`/bps por trade do PumpSwap; o estado (`pumpSwapReserves`) precisa desse
  campo antes de qualquer simulação. O paper executor continua lançando `PumpSwapSimulationNotValidatedError`
  até o usuário decidir incluir graduados.)*
- [x] **Dados do PumpSwap completos e persistentes** (pré-requisito para testar o universo graduado no replay).
  *(2026-10-02. `PumpSwapTradeEvent.swapDetails` (offset virtual, bps por componente, cashback, variante da
  instrução, `base_supply`) preenchido pelo normalize; `TokenState.pumpSwapReserves` agora é o estado DEPOIS do
  trade (antes guardava o ANTES, defasado em um trade) com `virtualQuote`/`feeBps`/`baseSupply`; tabela lateral
  `pumpswap_trade_extra` + view parametrizada `v_pumpswap_trades` na migração `011_pumpswap_trade_extra.sql`
  (**não aplicada** — aplicar é do usuário/orquestrador); recorder grava a tabela se ela existir; backfill
  `packages/ingest/scripts/backfill-pumpswap-trade-extra.ts` (streaming, lotes, retomável por fatia de mint,
  idempotente) pronto e testado com fixture, **não executado** — urgente após aplicar a 011, porque `raw_b64`
  expira em 30 dias. Ver ARCHITECTURE §4/§6.)*

## Fase 3 — Estratégia por regras + paper executor (dias 5–10) → M2

- [x] `packages/features` v0 (só regras, sem ML): idade do token, progresso da curva, holders únicos, % do top 10, % dos primeiros compradores do mesmo bloco (proxy de bundle), razão buy/sell 60 s, volume 60 s, se o criador já tem tokens anteriores. *(2026-10-01. `tokenAgeSec`, `curveProgress`, `uniqueHolderCount`, `top10HolderPct`, `sameSlotBuyPct`, `buySellVolumeRatio60s`, `uniqueBuyers60s`, `volume60sSol`, `largestSingleSellPctSupply60s`, `priceAboveMean120s`, `creatorHoldingPct`, `creatorTokensCreated24h`, `riskScore` — ver `packages/features/src/index.ts`, cada uma com fórmula/janela/aproximação documentada no comentário. Correção de 2026-10-01: `curveProgress` usa `initial_real_token_reserves` da conta `Global` (`parseCurveInitialParams`) como denominador; `priceAboveMean120s` usa só preço marginal (`virtualQuote/virtualToken` após cada trade, gravado no `TradeRecord`).)*
- [x] `packages/strategy` v0 conforme `docs/STRATEGY.md` (filtros duros + gatilho de momentum). Decide só `enter`/`reject` (motivo = chave do filtro); saídas (§6) são responsabilidade de `packages/positions` e sizing/risco de `packages/risk` (ver `ARCHITECTURE.md` §4). Testado com config sintética (um teste por filtro) e com o `config/strategy.v0.yaml` real (um aprovado, um rejeitado). *(2026-10-01, `packages/strategy/src/evaluate.ts`.)*
- [x] `packages/risk`: `hard-limits.ts`, sizing fixo, máximo de posições simultâneas, limite de perda diária, kill switch. *(2026-10-01. Config acima do hard limit = erro explícito; `sizing.sizeSol` reduzido de 0,1 para 0,05 SOL. Sizing com teto de impacto (busca binária, rejeita abaixo de 50% do tamanho). Kill switch com os 5 gatilhos de RISK §3 — divergência de saldo só ativa no live; `data/STOP` via adaptador `isStopFilePresent`. `decisionId` determinístico. Ver `packages/risk/src/`.)*
- [x] `packages/execution/paper.ts` pessimista (latência, custos, falhas) conforme `ARCHITECTURE.md` §5. *(2026-10-01. Máquina de estados pura; custos = mediana de `tx_costs` × 1,5 com mínimo de 30 amostras e fallback marcado no fill (`cost_estimate_source`); hard limits conferidos de novo; PumpSwap → `PumpSwapSimulationNotValidatedError`; graduação → `venue_unverified`. Migração `006_fills_paper_columns.sql` (ex-`006_fills_venue_unverified.sql`, renomeada e ampliada antes de aplicada: `base_fee`, preços `*_lamports_per_unit`, `virtual_*_before`) **não aplicada** — aplicar com `pnpm migrate` é decisão do usuário. Taxa base por assinatura cobrada em todo fill desde 2026-10-01.)*
  **Regra (enquanto o universo for só curva — a matemática do PumpSwap já é exata desde 2026-10-02, mas ligar
  graduados é decisão do usuário):** nunca simular um swap no PumpSwap — se
  uma posição aberta na curva graduar, fechar no último preço conhecido da bonding curve e marcar o fill com
  `venue_unverified: true`, sem calcular venda no PumpSwap. Qualquer código que tentar simular um swap
  PumpSwap enquanto essa limitação existir deve **lançar erro explícito**, nunca silenciar ou aproximar.
- [x] `packages/positions`: take profit escalonado, trailing stop, stop loss, time stop e saídas de emergência (venda individual > 5% do supply, criador vendendo) e graduação; percentuais líquidos de taxas de saída. *(2026-10-01, `packages/positions/src/exits.ts` — fórmula do PnL líquido e precedência documentadas ali e em `docs/STRATEGY.md` §6.)*
- [~] `pnpm bot --mode=paper` gravando `decisions` e `fills`. *(2026-10-01: implementado e testado com eventos sintéticos — `apps/bot/src/paper/` (orquestrador sem I/O + adaptador), `MarketStore` com compactação de memória, pré-carga de 24 h de `token_created`, rent por RPC, custos de `tx_costs` recarregados. Falta o aceite: rodar 24 h de verdade com RPC pago e a migração 006 aplicada — o paper recusa iniciar sem as colunas da 006.)*
- [x] `packages/monitor`: alerta Telegram a cada entrada/saída e resumo a cada hora. *(2026-10-01. `fetch` nativo, timeout, retry com backoff, fila limitada, desligado com aviso sem token/chat, token removido de qualquer erro logado; testado com `fetch` falso. Envio real ainda não exercitado — depende do token do usuário.)*
- [x] `pnpm report --run=<id>`: nº de trades, taxa de acerto, PnL bruto e **líquido**, custos por categoria, distribuição de retornos, drawdown. *(2026-10-01. Cálculo puro em `apps/bot/src/report/compute.ts` testado com fixtures; também critérios da STRATEGY §7, tokens rejeitados por filtro, custo médio por categoria (inclui taxa base e slippage), fills com custo de fallback e tabela de sensibilidade 0,05/0,1/0,25/0,5 SOL; `--json`. Ainda não rodado contra um run paper real.)*

**Aceite:** paper rodando 24 h sem travar; cada fill tem custos detalhados; relatório gerado.

## Fase 4 — Backtest determinístico (dias 9–15) → M3 **(condicional: só se o paper trading da v0 mostrar resultado — ver `docs/STRATEGY.md` §7)**

- [ ] `EventSource` de replay a partir do ClickHouse, `Clock` simulado.
- [ ] `apps/backtest` com config versionada; resultado gravado em `runs` com hash da config e commit git.
- [ ] Teste: mesmo intervalo, duas execuções, decisões idênticas.
- [ ] Comparar backtest × paper do mesmo período (diferença deve ser pequena; se não for, corrigir antes de seguir).
- [ ] Separação treino/validação **por tempo** (nunca aleatória) para qualquer ajuste de parâmetro.

**Aceite:** divergência backtest × paper < 10% no PnL líquido do mesmo período; replay determinístico.

## Fase 5 — Sinais (dias 12–21) → M4 **(condicional: só se o paper trading da v0 mostrar resultado — ver `docs/STRATEGY.md` §7)**

Cada item só entra na estratégia se o backtest fora da amostra melhorar o PnL líquido.
- [ ] Coleta de **rugs rotulados** (queda de TVL / inatividade, conforme a literatura) para treino futuro. *(Movido da Fase 2: não é bloqueante para curve-math/estado; só importa se chegarmos ao modelo de risco.)*
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

Por enquanto o bot roda na máquina local (pm2). A migração **acontece somente depois que o paper trading da v0
atingir o critério de sucesso de `docs/STRATEGY.md` §7**, e antes da Fase 6 — até lá, tudo roda localmente com pm2.

- [ ] VPS Linux (Ubuntu 24.04) na mesma região do RPC pago; ClickHouse via `docker compose` com dados migrados da máquina local (export/import Parquet).
- [ ] **systemd:** instalar `infra/systemd/memebot-record.service` seguindo `infra/systemd/README.md` (usuário `memebot`, `.env` com permissão 600, `Restart=always`); conferir parada limpa com `systemctl stop` (buffer gravado).
- [ ] **24 h de gravação** contínua sem gap > 60 s; `pnpm sanity --hours=24` com tokens/hora na mesma ordem de grandeza de Dune/Bitquery.
- [ ] **Teste de latência:** `ping` para `ny.mainnet.block-engine.jito.wtf` e `frankfurt.mainnet.block-engine.jito.wtf`; latência HTTP/WebSocket até o RPC; linha de base de `received_at − ts` (`pnpm sanity`) comparada com a medida local — escolher a região pelo menor valor.
- [ ] **Hardening** (RISK_AND_SECURITY §4): usuário sem sudo, SSH só por chave e senha desativada, `ufw` liberando só SSH, portas do ClickHouse só em `127.0.0.1`, `unattended-upgrades`, `systemd-analyze security memebot-record` revisado, backup semanal em Parquet para fora da VPS (sem chaves).

**Aceite:** os cinco itens acima; a partir daí o systemd substitui o pm2 e a VPS vira o ambiente padrão de gravação.

## Backlog — estacionado (avaliar depois da Fase 5, só com evidência nos dados)

- [ ] **Grafo de financiamento de holders** (estilo "bubble map"): agrupar carteiras que receberam SOL da mesma origem nas últimas N horas; feature "% do supply em clusters ligados". Complementa o proxy de bundle da Fase 3.
- [ ] **Canais de "call" do Telegram como fonte social (só leitura):** registrar cada call (canal, mint, horário) e medir o que acontece com o preço depois. Gera um score por canal: quem chama cedo e bem × quem chama para vender em cima dos seguidores. Entra como feature, nunca como gatilho.
- [ ] **Narrativas de posts antigos:** permitir ao `NarrativeClassifier` casar tokens com posts antigos de contas relevantes (tokens criados sobre algo dito meses atrás), usando um índice local dos posts gravados.
- [ ] **Outras redes (BNB Chain, Base):** só se os dados da Solana justificarem. Exige novo `ingest`, nova `curve-math` e novo parser por launchpad; a estratégia e o risco reaproveitam as interfaces.
