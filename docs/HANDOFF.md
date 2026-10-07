# HANDOFF — memebot (contexto para retomar em conversa nova)

Atualizado em 03/10/2026, às 23h50 BRT. Retrato detalhado e gerado pelo próprio repositório em `docs/STATUS.md`
(71 features, 14 experimentos, custos, conjuntos de dados já consumidos). Anexe este arquivo (e, se quiser, CLAUDE.md e docs/ROADMAP.md) ao abrir uma
conversa nova com o revisor e diga: "Continue a partir do HANDOFF."

## 1. O projeto em uma frase
Bot de paper trading (e, se um dia passar no critério, live em tamanho mínimo) de memecoins no Pump.fun/Solana,
construído com o Claude Code no PC do usuário. Objetivo atual: descobrir **com dados** se existe alguma
estratégia com vantagem real depois de todos os custos. Nada de dinheiro real até lá.

## 2. Papéis e forma de trabalhar
- **Usuário:** opera o Claude Code local, cola prompts, devolve relatórios. Prefere respostas em PT-BR,
  diretas, e quer entender o "porquê".
- **Revisor (esta conversa):** valida cada relatório, aponta riscos, escreve o próximo prompt.
  **Todo prompt vem com o modelo indicado no topo** (Sonnet / Opus / Haiku).
- **Claude Code:** implementa; relatórios no formato da seção 2.1 do CLAUDE.md.
- Regras de uso:
  - **uma sessão local por vez** (duas sessões já reiniciaram o mesmo pm2 e picotaram runs);
  - nada de agentes em paralelo ou vigias em background sem pedido;
  - sessão nova (`/clear`) por tarefa;
  - saídas grandes vão para `data/reports/`.

### Guia de modelos
| Tarefa | Modelo |
|---|---|
| Docs, config, Telegram, relatórios, scripts simples | **Sonnet** |
| curve-math, paper executor, risk, replay/backtest, live, auditorias | **Opus** |
| Conferências rápidas (ler log, contar algo) | **Haiku** |

## 3. Infraestrutura (decidido)
- Tudo **local** (Windows), bot via **pm2** (`ecosystem.config.cjs`, apps record/paper). A VPS só entra depois
  que o paper passar no critério da STRATEGY §7 e antes do live.
- ClickHouse no Docker: limite de 1800 MiB efetivo; configs montadas arquivo a arquivo.
- **RPC:** WebSocket = RPC público da Solana (sem cobrança por volume; ~150–160 MB/min ≈ 217 GB/dia de
  tráfego); HTTP = **Helius free** (~18 req/min, 0 × 429, ~78% do plano).
  - A Helius cobra o WS por volume desde maio/2026 (20 créditos/MB), então o WS pago está fora de questão.
  - `POOL_RESOLVE_PER_SEC = 0,1`; `INGEST_COST_SAMPLES_PER_SEC = 0,2`.
- Disco: ~9 GB/dia (~375 MiB/h em events_trade); 948 GB livres. TTL de 30 dias **só na coluna raw_b64**
  (migração 008); linhas e campos decodificados não expiram.
- Telegram: `TELEGRAM_MODE=hourly` (resumo na virada da hora BRT). Imediatos: início/fim, queda/reinício,
  stream > 60 s parado, kill switch.
- `pnpm status` mostra a origem das variáveis (env × .env × padrão). O daemon do pm2 já herdou variável
  velha uma vez.
- Qualidade do run: `provisional` se o tempo sem stream passar de 1% do run (tabela run_health,
  view v_run_quality).

## 4. Estado das fases
- **Fase 0, Fase 1:** concluídas. O systemd fica adiado para a VPS.
- **Fase 2:**
  - curve-math da bonding curve: **exata** (fixtures golden com 0 de diferença).
  - **PumpSwap: parcial.** Divergência de ~7,6% numa venda real (pool DycbAuWK…, esperado 200653 ×
    real 215867/213600). Universo restrito a `allowedVenues: [curve]`. O paper lança erro explícito em
    simulação de PumpSwap; um token que gradua com posição aberta fecha no último preço da curva com
    `venueUnverified`.
- **Fase 3:** features, strategy v0.1, risk/hard-limits, paper executor pessimista, positions, report,
  funnel e Telegram prontos. `bot --mode=paper` está em [~] porque falta o aceite de 24 h. Rodou 8,3 h sem
  travar; foi encerrado por decisão depois do kill switch.
- **Fase 4 (antecipada, EM ANDAMENTO):**
  - replay determinístico + varredura de hipóteses (sweeps "paper_wall" e "event", ~40 min cada);
  - separação por tempo: ~60% ajuste / ~40% validação;
  - kill switch desligado só no replay.
  - Hipóteses de entrada:
    - (a) confirmação de N s;
    - (b) não perseguir: preço ≤ X% acima da média de 120 s;
    - (c) entrar no recuo de Y% após o pico;
    - (d) "vender tudo em +40%" combinado com a melhor entrada.
  - Também: retomar a matemática do PumpSwap.

## 5. Mudanças de estratégia já feitas
- v0 → **v0.1**: o proxy de bundle ignora as compras do criador. O criador compra no tx do create em 72%
  dos tokens, mas pouco (mediana de 0,5% do supply); essa compra vira `creatorInitialBuyPct`.
- O filtro "≥3 rugs do criador" virou "criador criou ≥ 3 tokens em 24 h" (`maxCreatorTokens24h`).
- `allowedQuoteMints: [SOL]`; `allowedVenues: [curve]`; `sizeSol` 0,05.
- `priceAboveMean120s` usa preço marginal (reservas virtuais); `curveProgress` usa a reserva inicial da
  conta Global.

## 6. Resultados (o que os dados disseram)
**Run v0.1 de 02/10** (`paper-2026-10-02T03-36-33-931Z-2e4393`, 00:36–05:40 BRT, kill switch de perda
diária):

| | |
|---|---|
| Operações | 112 |
| Acerto | 29,5% |
| PnL bruto | −0,028 SOL |
| PnL líquido | −0,207 SOL |
| P(expectativa > 0) | 16% |
| IC 95% da expectativa | −0,0053 a +0,0018 SOL/op |
| STRATEGY §7 | ✗ nos 4 itens |

- **Sem vantagem bruta**, e os custos (~3,2%/op: curva 2,5% + priority/tip/base 0,7%) tornam o resultado
  negativo. Seria preciso mais de ~3% de vantagem bruta por operação.
- **Entra no topo:** 69% das saídas são por stop, com mediana de 29 s após a entrada; o MFE mediano antes do
  stop é −5,5%; depois do stop o preço cai −35% em 5 min e −48% em 1 h. O stop está certo; a entrada está
  errada.
- Saídas simuladas: a melhor é **vender tudo em +40%** (−0,096), ainda negativa. Moonbag e trailing pioram.
  Segurar mais não compensa.
- **Pista:** tokens com 3 ou mais entradas deram +0,046 SOL (n = 40) → hipótese de **comprar no recuo**.
- Idade e volume do token não dão padrão consistente entre runs.
- **Pista estrutural:** PumpSwap custa ~0,6% na ida e volta, contra ~2,5% na curva. Por isso **fechar a
  matemática do PumpSwap é prioridade**; isso abre o universo de tokens graduados (bate com o conselho
  "foque em market cap maior").
- Custos reais medidos: priority ~43 mil lamports (3,2 mil amostras); tip ~97,5 mil lamports
  (253 amostras). O fallback antigo de 500 mil era muito pessimista.
- Slippage: compras ~85–97 bps melhores que a decisão (o preço recua nos 800 ms de latência, outro sinal de
  entrada no topo).

## 6b. Resultados de 03/10 (Fase 4 + graduados + ML v1)
- **Replay de hipóteses de entrada** (a/b/c, relógio paper_wall): nenhuma variante positiva em ajuste E
  validação, e o ranking muda com o relógio usado → ruído. O replay reproduz o paper: 69 de 73 entradas
  coincidem. Todas as variantes foram melhores na validação (04h–09h BRT) que no ajuste (21h–04h): o
  período pesa mais que a regra.
- **Bug do relógio:** o Windows estava ~23 s adiantado e o serviço de hora estava parado. Corrigido em
  03/10 às 18h18 (pool.ntp.org); desvio atual de +1,8 s. O "agora" da estratégia passou a vir do ts dos
  eventos; stream parado e kill switch usam o relógio monotônico local.
- **Graduados (PumpSwap):** nenhuma variante positiva nos dois períodos (1–10 min, 5–60 min,
  mcap US$100k–1M, +40%).
- **ML v1** (XGBoost; 100.930 amostras de 13.970 tokens; divisão 60/20/20 por tempo e por token):
  - AUC no teste 0,768 (logística: 0,669); no top 5%, 32% bateram +40% antes de −20% (média: 13%);
  - **retorno no teste −4,7%/op, IC [−8,3%; −1,1%]** em 481 operações (sem modelo: −6,0%);
  - **o modelo tem poder de ordenação real, mas não cobre os custos.** O empate exigiria ~40% de acerto
    com a saída +40/−20.
  - Features mais usadas: preço marginal, nº de trades em 15–60 s, concentração (top 10 e criador),
    progresso da curva, holders, compras no slot de criação.
  - **Os conjuntos de treino, validação e teste do ml-v1 estão consumidos**: o ML v2 tem de ser testado
    em dados gravados depois de 03/10.
- **PumpSwap RESOLVIDO** (02–03/10): a causa era ignorar `virtual_quote_reserves` e a regra de pool sem
  criador. 11.463.859 de 11.463.859 trades reais exatos; fixtures golden criadas. (Substitui o "parcial"
  da seção 4.)
- **Disco:** o STATUS de 03/10 mede 167 GiB livres de 931 (83% usados). O banco tem 7,7 GiB e cresce
  ~9–11 GB/dia → **~2–3 semanas até encher**. O TTL de 30 dias do raw_b64 não chega a tempo; ver a política
  de disco antes de ~15/10.
- **Slippage −6,1% no report do paper (favorável) está sob suspeita**: se for erro de sinal ou de
  cálculo, o paper está otimista. Verificar antes de qualquer novo paper.
- **NTP configurado** (`sc.exe config w32time start= auto`, manualpeerlist pool.ntp.org, resync OK).
  O STATUS §8/§9 que diz "sem fonte NTP" está desatualizado.
- **Paper v0.1 parado** (repetia o mesmo prejuízo). Só o `memebot-record` roda (~20 mil eventos/min).
  O bloco contínuo de dados de melhor qualidade antes de 03/10 é de só ~13h37 (01→02/10).

## 7. Próximos passos (em ordem) — ATUALIZADO 03/10
1. Até ~07/10: só o gravador, para juntar 3–4 dias contínuos. Conferir `pnpm status` uma vez por dia.
   Cuidar de `pm2 save`, das horas ativas do Windows Update e de `pm2 resurrect` se o PC reiniciar.
2. ~07/10: **persistência de carteiras** (Sonnet). A = 2 primeiros dias, B = 2 últimos; top 50 × carteiras
   aleatórias; simular seguir a carteira com 1/5/30 s de atraso; separar humano × bot × sniper; medir o
   quanto cada carteira é copiada.
3. Se houver persistência: features de smart money sem vazamento (score por janela móvel só com trades
   < t) → **ML v2** (Opus), treino nos dados antigos e teste só nos dias novos.
4. **Critério de parada:** se o ML v2 não ficar positivo nos dados novos, com IC acima de zero, o projeto
   entra em pausa. Último caminho possível: narrativa (X + Jev), caro.

## 7-antigo. Próximos passos (versão de 03/10 de manhã, mantida como histórico)
1. Ler o resultado dos sweeps da Fase 4 (resumo do arquivo em data/reports/). Só valem variantes
   **positivas em ajuste E validação**.
2. PumpSwap exato → testar no replay o universo de graduados.
3. Se nada passar: **smart money** a partir dos próprios dados gravados (carteiras com PnL consistente em
   vários tokens; penalidade para carteiras muito copiadas), testado no replay.
4. Variante vencedora → nova versão em paper por ~1 dia (~200 operações) → STRATEGY §7.
5. Só depois: VPS (systemd, hardening, 24 h) → Fase 6 live mínimo (0,02–0,05 SOL), com auditoria
   independente antes.

## 8. Estacionado (backlog, só com evidência)
Twitter/X + Jev (TypeSafe) para narrativa (a API do X é cara; o Jev só faz sentido com uma fonte social);
canais de call do Telegram (lista de ~39 em config/telegram-channels.yaml, `unverified`, só leitura, score
por canal); J7 Tracker (verificar API e termos); fee sharing/claim; destino do supply do dev (lock ×
transferência); ritmo de distribuição do bundle; grafo de financiamento ("bubble map"); regime de meta;
PvP de narrativa; outras redes (BNB, Base, Robinhood Chain, ARC).

## 9. Regras inegociáveis (resumo do CLAUDE.md)
- Nunca ler, imprimir ou commitar `.env`, keypair ou tokens. O nome e o símbolo do token passam por escape
  de HTML (vêm de terceiros).
- O live exige `LIVE_CONFIRM` + hard-limits no código (só podem ser reduzidos) + simulação antes de enviar.
- Hard-limits:
  - 0,05 SOL por posição;
  - 3 posições;
  - 0,2 SOL de perda por dia;
  - 1 SOL na carteira quente;
  - slippage ≤ 15%.
- O projeto não faz: sandwich, front-running, wash trading, bot de volume, criação ou promoção de token,
  SDKs de origem duvidosa, sites que "limpam" contas.
- Slippage de 99% e chave privada em .txt (dicas dos vídeos) estão **proibidos**.
- Não é recomendação de investimento. Tributação de cripto: registrar as operações e consultar um
  contador.