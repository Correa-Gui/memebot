# STATUS — retrato do projeto

Gerado em 2026-10-03 20:01 BRT (23:01 UTC). Só leitura: código, YAML, `ROADMAP.md`, `STRATEGY.md` e os
relatórios em `data/reports/`. Números vindos de relatório citam o arquivo; números medidos nesta geração
(pm2, ClickHouse, logs) são "medidos agora" e descrevem o instante acima — não são histórico fixo. Para o
estado futuro, regenere este arquivo.

## 1. Estado operacional

**pm2** (medido agora):

| App | Status | Uptime |
|---|---|---|
| `memebot-record` | online | ~5 min (reiniciou 2026-10-03T22:56:13Z — não disparado por esta geração) |
| `memebot-paper` | stopped | — |

**RPCs** (só hosts, origem `config sources` do log): `RPC_URL` → `mainnet.helius-rpc.com` (fonte `.env`,
Helius pago); `RPC_WS_URL` → `api.mainnet-beta.solana.com` (fonte `.env`, WS público da Solana).

**Ingest do recorder** (última linha `ingest`, 2026-10-03T19:59:17Z local): 19.982 eventos/min, 88.688
mensagens WS/min (168,7 MB/min), qualidade `production` (0% de tempo sem stream na janela), 18 requisições
HTTP/min (0 limitadas), amostragem de custo 12/min.

**Desvio relógio local × ts dos eventos** (campo `clockSkew`, mesma linha): mediana **+1.798 ms**, min 1.083,
máx 3.269 — dentro do normal (~1–2 s de chegada do WS), abaixo do limite de alerta de 5 s. Antes da
sincronização de hoje (18:18 BRT) o desvio medido era de dezenas de segundos (ver §8).

**Banco (ClickHouse, medido agora):** 7,70 GiB em disco; `events_trade` 5,58 GiB / 15.595.953 linhas;
`pumpswap_trade_extra` 1,66 GiB / 12.855.987 linhas; `ingest_gaps` 190 MiB. Disco do host: 167 GiB livres de
931 GiB (83% usado) — a pasta `data/` do repo (logs, reports, csv de ML) tem 139 MiB; o banco vive no volume
do Docker, fora dessa pasta.

**Período coberto pelos dados** (min/max de `events_trade`, UTC): **2026-09-30 01:18:50 → 2026-10-03
22:59:48** (= 2026-09-29 22:18:50 BRT → 2026-10-03 19:59:48 BRT). Não é contínuo — blocos de gravação
(gap > 5 min entre eles):

| Bloco (UTC) | Duração aprox. | Observação |
|---|---|---|
| 09-30 01:18 → 01:26 | 8 min | sessão curta inicial |
| 09-30 01:57 → 02:35 | 38 min | sessão curta inicial |
| **10-01 22:16 → 10-02 11:53** | **13h37min** | bloco principal — usado no sweep de hipóteses, no replay e no dataset de ML; tem 2 lacunas internas pequenas (28 e 31 min) excluídas por token afetado, não por corte do bloco |
| 10-03 19:41 → 21:16 | 1h35min | sessão curta |
| 10-03 22:56 → agora | ~5 min | sessão em andamento |

Critério de aceite da Fase 1 (≥ 12 h contínuas sem gap > 60 s) nunca foi reconfirmado com `pnpm sanity`
nesta sessão; o bloco principal (13h37) cumpre na prática, mas não há uma medição formal recente registrada.

## 2. Fases (ROADMAP.md)

**Fase 0 — Fundação:** todos os itens `[x]`.

**Fase 1 — Ingestão e gravação → M1:** todos `[x]`, exceto `pnpm bot --mode=record` via systemd `[ ]`
(adiado para a VPS; unit pronta em `infra/systemd/`, roda local via pm2).

**Fase 2 — Matemática exata e estado:** todos `[x]`. Curva e PumpSwap exatos (PumpSwap: 11.463.859/11.463.859
trades reais conferidos em 2026-10-03, incluindo a regra de pool sem criador). Fixtures golden dos dois.
Dados do PumpSwap persistentes (migração 011 aplicada, backfill rodado).

**Fase 3 — Estratégia + paper executor → M2:** todos `[x]`, exceto:
- `pnpm bot --mode=paper` `[~]` — implementado e testado com eventos sintéticos; falta o aceite formal de
  "24 h sem travar" com RPC pago (os runs reais até agora são mais curtos, ou cortados pelo kill switch).

**Fase 4 — Backtest determinístico → M3 (condicional):**
- `[~]` Comparar backtest × paper do mesmo período — comparação feita (`paper-...-2e4393`), mas pendente
  repetir com o relógio corrigido (já corrigido em 2026-10-03) num paper novo.
- Todo o resto `[x]`: replay/sweep, determinismo, separação por tempo, universo graduado testado no replay.

**Fase 5 — Sinais → M4 (condicional):**
- `[x]` dataset de ML (`pnpm ml:dataset`).
- `[~]` XGBoost/ONNX — treinado e avaliado (`ml-v1`), critério de retorno NÃO cumprido, sem export ONNX.
- `[ ]` `wallets/` (smart money), `[ ]` `social/`, `[ ]` `signals/narrative`, `[ ]` ablação — nada iniciado.

**Fase 6 — Live:** todos `[ ]` (bloqueado pelos pré-requisitos: nenhum paper/backtest ainda é positivo).

**Migração para VPS:** todos `[ ]` (condicional ao critério da STRATEGY §7, não atingido).

## 3. Features

### Base v0 (packages/features/src/index.ts) — usadas em filtro/gatilho e como ponto de partida do dataset de ML

| Feature | Fórmula (resumo) | Janela | Aproximação? | Onde é usada |
|---|---|---|---|---|
| `tokenAgeSec` | `(nowMs − createdAtMs) / 1000` | — | não | filtro (idade min/max) |
| `curveProgress` | `(realTokenInicial − realTokenAtual) / realTokenInicial`, clamp [0,1] | — | não | filtro-base, dataset ML |
| `uniqueHolderCount` | nº de carteiras com saldo inferido > 0 | vida toda | sim — só trades vistos pelos 2 programas (sem transferências diretas) | filtro |
| `top10HolderPct` | soma dos 10 maiores saldos / supply | vida toda | sim (mesma limitação) | filtro |
| `sameSlotBuyPct` | % comprado no mesmo slot da criação, excluindo o criador (proxy de bundle v0.1) | slot da criação | sim — proxy, não é bundle real | filtro |
| `creatorHoldingPct` | saldo inferido do criador / supply | vida toda | sim (mesma limitação) | filtro |
| `creatorTokensCreated24h` | nº de outros tokens do mesmo criador criados em [t−24h, t] | 24 h | não | filtro |
| `creatorInitialBuyPct` | % do supply comprado pelo criador no primeiro trade dele | instante único | não | snapshot/dataset (não é filtro duro) |
| `buySellVolumeRatio60s` | volume de compra / volume de venda | 60 s | não | gatilho de entrada |
| `uniqueBuyers60s` | compradores únicos | 60 s | não | gatilho |
| `volume60sSol` | volume de compra + venda | 60 s | não | filtro (mínimo) |
| `largestSingleSellPctSupply60s` | maior venda individual / supply | 60 s | não | gatilho |
| `priceAboveMean120s` | preço marginal atual > média do preço marginal | 120 s | não | gatilho (`requirePriceAboveMean120s`) |
| `priceVsMean120s` | preço atual / média − 1 (variante numérica da anterior) | 120 s | não | hipótese "não perseguir" (desligada) |
| `riskScore` | placeholder — modelo não existe ainda | — | sim, sempre `missing=1` | filtro (ignorado na prática) |
| `marginalPrice` | `virtualQuote / virtualToken` (preço instantâneo da curva) | instante | não | dataset ML, universo graduado |

### Features do ML v1 (adicionais, `apps/bot/src/ml/dataset.ts`)

Para cada uma das janelas **15 / 30 / 60 / 120 / 300 s**, 11 agregados: volume total, volume de compra,
volume de venda, fluxo líquido (compra − venda), compradores únicos, vendedores únicos, nº de trades, razão
compra/venda, maior venda (% do supply), preço atual vs média da janela, variação do preço desde o início da
janela. 5 × 11 = 55 features, mais `hourBrt` (hora do dia em BRT) e `tradesTotal` (histórico completo) — 71
features no total (13 base + marginalPrice + hourBrt + tradesTotal + 55 de janela). Nenhuma olha o futuro: só
eventos com `ts ≤ t` entram no cálculo em cada amostra.

**As 10 mais importantes segundo o modelo** (SHAP médio no teste, `data/reports/ml-v1.txt`):

| # | Feature | SHAP médio \|contribuição\| |
|---|---|---|
| 1 | `marginalPrice` | 0,2459 |
| 2 | `trades30s` | 0,1593 |
| 3 | `top10HolderPct` | 0,1457 |
| 4 | `creatorHoldingPct` | 0,1358 |
| 5 | `curveProgress` | 0,1152 |
| 6 | `uniqueHolders` | 0,1082 |
| 7 | `trades15s` | 0,1056 |
| 8 | `buyVol15s` | 0,0953 |
| 9 | `trades60s` | 0,0872 |
| 10 | `sameSlotBuyPct` | 0,0763 |

## 4. Estratégias e experimentos testados

| Nome | Período | Operações | PnL líquido ajuste | PnL líquido validação/teste | IC 95% (exp./op, validação\|teste) | Conclusão |
|---|---|---|---|---|---|---|
| v0.1 (paper ao vivo) | run único, 02/10 ~8h20 | 112 fechadas | — (run único, sem ajuste/validação) | −0,207 SOL | [−0,0053; +0,0018] SOL/op | Negativo; kill switch de perda diária disparou. `data/reports/paper-2026-10-02T03-36-33-931Z-2e4393.txt` |
| v0.1 (replay, rótulo "v0") | ajuste 00:16→07:14 \| validação 07:14→11:53 UTC | 95 \| 96 | −0,458 SOL | +0,212 SOL | [−0,008;−0,001] \| [−0,003;+0,007] | Inverte de sinal entre períodos — amostra não distingue; `data/reports/replay-sweep-v2-event.txt` |
| a-confirm-10/30/60s | mesmos períodos | 58/29/21 \| 72/49/34 | −0,075 a −0,072 SOL | +0,02 a +0,14 SOL | IC inclui 0 em todas | Nenhuma robusta |
| b-nochase-10/20/40 | mesmos períodos | 31/52/83 \| 34/53/86 | −0,24 a +0,14 SOL | −0,02 a +0,14 SOL | só b-nochase-20 ★ (positiva nos 2), IC inclui 0 | Melhor candidata do grupo, mas sem significância |
| c-pullback-15/25/35 | mesmos períodos | 48/27/17 \| 60/32/23 | −0,17 a −0,06 SOL | −0,12 a +0,20 SOL | IC inclui 0 (exceto c-pullback-35 validação, negativo) | Nenhuma robusta |
| d-confirm60s-tp40all | mesmos períodos | 25 \| 32 | −0,062 SOL | +0,128 SOL | [−0,009;+0,004] \| [−0,002;+0,010] | Escolhida como "melhor do ajuste" por critério definido a priori, mas IC inclui 0; `data/reports/replay-sweep-v2-event-d.txt` |
| Universo graduado g0 (1–10 min pós-graduação) | mesmos períodos | 103 \| 70 | −0,447 SOL | −0,114 SOL | — | Negativa nos dois |
| g0-tp40all | mesmos períodos | 119 \| 79 | −0,493 SOL | −0,081 SOL | — | Negativa nos dois |
| g1 (5–60 min pós-graduação) | mesmos períodos | 207 \| 87 | −1,167 SOL | −0,159 SOL | — | Negativa nos dois, pior do grupo |
| g1-tp40all | mesmos períodos | 269 \| 144 | −1,335 SOL | −0,401 SOL | — | Negativa nos dois |
| g2 (1–10 min + mcap US$100k–1M) | mesmos períodos | 31 \| 12 | −0,157 SOL | −0,014 SOL | — | Negativa nos dois, amostra pequena |
| g2-tp40all | mesmos períodos | 34 \| 12 | −0,172 SOL | +0,004 SOL | — | Quase neutra na validação, mas amostra de 12 operações; `data/reports/replay-graduated-2026-10-03.txt` |
| ml-v1 (XGBoost) | treino/val/teste por tempo e por token | 372 (val) / 481 (teste) | — (val: −0,0370/op) | −0,0466/op teste | [−0,0765;+0,0037] val \| [−0,0834;−0,0111] teste | AUC teste 0,768, precisão top 5% 0,32 (base 0,13) — ordena bem, mas retorno negativo mesmo acima do limiar; `data/reports/ml-v1.txt` |
| ml-v1 (logística, baseline) | idem | 102 (val) / 89 (teste) | — | −0,0682/op teste | [−0,1027;+0,0424] val \| [−0,1458;+0,0120] teste | Pior que o XGBoost; nenhum dos dois cumpre o critério |

Nenhuma estratégia testada (regras ou ML) cumpriu o critério de retorno líquido positivo com significância
nos dois períodos/conjuntos.

## 5. Custos

Medianas correntes (últimas 24 h, medido agora via `tx_costs`): **priority fee** mediana 50.000 lamports,
**tip Jito** mediana (amostras > 0) 100.000 lamports, de 1.168 amostras recentes. No run de paper analisado
(`2e4393`, 303 fills), 100% dos fills usaram `tx_costs_median` (nenhum fallback); custo médio por operação
fechada (tamanho médio 0,05 SOL):

| Categoria | SOL | % do tamanho |
|---|---|---|
| Taxa da curva (protocolo + criador) | 0,001231 | 2,5% |
| Priority fee | 0,000116 | 0,2% |
| Tip Jito | 0,000226 | 0,5% |
| Taxa base (assinatura) | 0,000013 | 0,0% |
| Rent líquido | 0,000000 | 0,0% |
| Slippage (já dentro do PnL) | −0,003028 | −6,1% |

Taxas da curva lidas on-chain da `protocol_config` (Global/FeeConfig), última leitura 2026-10-03 22:56:16
UTC. Taxas do PumpSwap: por trade, do evento (`lp`/`protocolo`/`criador`/`cashback` bps), nunca fixas no
código — ver `curve-math/pumpswap.ts`.

## 6. Configuração do simulador (paper/replay)

- **Latência:** `PAPER_LATENCY_MS` = 800 ms (`.env`).
- **Taxa de falha simulada:** `PAPER_FAIL_RATE` = 0,10 (`.env`).
- **Custos:** mediana de `tx_costs` × 1,5 com mínimo de 30 amostras por tipo (`PAPER_COST_MIN_SAMPLES`),
  senão p75 × 1,5, senão fallback (`PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS`/`..._JITO_TIP_...` = 500.000
  lamports cada); recarregado a cada `PAPER_COST_RELOAD_MS` (10 min), olhando `PAPER_COST_LOOKBACK_HOURS`
  (24 h) para trás.
- **Saídas** (`config/strategy.v0.yaml`): take profit 50% em +40%, 30% em +100%; trailing stop 25% (só
  depois do 1º TP); stop loss −20%; time stop 600 s (se nenhum TP); emergência: vende tudo se alguém vender
  > 5% do supply ou o criador vender.
- **Hard limits** (`packages/risk/src/hard-limits.ts`, constantes no código — config só reduz):
  posição máx. 0,05 SOL; 3 posições simultâneas; perda diária máx. 0,2 SOL (kill switch); exposição máx. na
  carteira quente 1 SOL; slippage máx. 15%; priority fee e tip máx. 2.000.000 lamports cada.
- **Kill switch** (`packages/risk/src/kill-switch.ts`): `stop_file` (arquivo `data/STOP`), `daily_loss`
  (perda diária ≥ 0,2 SOL), `consecutive_failures` (≥ 5 falhas de tx seguidas), `stream_stale` (≥ 30 s sem
  evento do stream), `balance_divergence` (só no live, > 1% entre saldo esperado e on-chain). Qualquer um
  bloqueia só NOVAS entradas; posições abertas continuam sendo geridas.

## 7. Conjuntos de dados (treino/validação/teste — não reutilizar)

- **Sweep de hipóteses de entrada e universo graduado** (`pnpm replay:sweep`): ajuste = 2026-10-01 21:16 →
  2026-10-02 04:14 BRT (00:16→07:14 UTC); validação = 2026-10-02 04:14 → 08:53 BRT (07:14→11:53 UTC). Usado
  para escolher a variante "d" e para testar g0/g1/g2. **Já consumido** — não usar de novo para escolher
  parâmetro sem risco de sobreajuste.
- **ml-v1** (`research/ml_v1/train.py`, split por tempo e por token, 60/20/20):
  - treino: tokens criados 2026-10-01T22:56:13Z → 2026-10-02T08:22:34Z (61.140 amostras).
  - validação: 2026-10-02T08:22:36Z → 2026-10-02T10:48:08Z (20.056 amostras). Usada para escolher o limiar
    de probabilidade e o early stopping.
  - **teste: 2026-10-02T10:48:12Z → 2026-10-03T20:50:46Z (19.734 amostras) — já usado uma vez.** Não deve
    ser reutilizado para decidir hiperparâmetro ou features de um ml-v2; precisa de um teste novo (dados
    daqui para frente) quando houver próxima rodada.
- Nenhum mint aparece em mais de um conjunto (treino/validação/teste), por construção.

## 8. Pendências e dúvidas abertas

- **Divergência original do PumpSwap:** resolvida em 2026-10-02/03 — causa era ignorar `virtual_quote_reserves`
  e, depois, a regra de pool sem criador (`coin_creator` = chave padrão não cobra taxa do criador).
  Verificação em massa: 11.463.859/11.463.859 trades reais exatos. Nada pendente aqui.
- **Smart money (Fase 5):** nada implementado ainda — não há `wallets/`, nem score de carteira, nem
  dataset de persistência. Falta: (a) decidir a janela de "boa carteira" (ex.: PnL positivo nos últimos N
  dias) e o limiar; (b) calcular isso sobre os trades já gravados (sem depender de dados futuros); (c) só
  depois, gerar as features de smart money para o dataset de ML sem olhar o futuro (score em t usa só
  trades com `ts < t`). Pedido pendente do usuário: gerar essas features (sem treinar modelo novo) **se
  houver persistência** — a análise de persistência em si ainda não foi feita.
- **`pnpm bot --mode=paper` 24 h sem travar:** nunca formalmente cumprido (ver §2, Fase 3).
- **Comparação paper × backtest com o relógio corrigido:** o relógio do `PaperClock` foi corrigido em
  2026-10-03 (usa tempo dos eventos, não mais parede); falta repetir a comparação com um paper novo.
- **Relógio do sistema:** sincronizado hoje (18:18 BRT); medido agora em +1,8 s (normal). Sem fonte NTP
  configurada no Windows (`w32tm` mostrava "Free-running System Clock" antes da sincronização manual) —
  pode voltar a desviar sem aviso até isso ser corrigido.
- **`memebot-paper` está parado** e `memebot-record` sozinho está gravando — por decisão do usuário (não
  mexi em nenhum dos dois nesta tarefa).

## 9. Próximos passos sugeridos (em ordem)

1. **Configurar NTP** no Windows (ou aceitar o desvio e confiar só no alerta de `clockSkew` > 5 s) — barato,
   evita o problema que já afetou um paper inteiro.
2. **Decidir se o smart money vale a pena** antes de implementar `wallets/`: medir, com os dados já
   gravados, se existe persistência de carteiras "boas" entre janelas de tempo (ex.: PnL da carteira nos
   primeiros 2 dias prevê PnL nos 2 dias seguintes). Isso responde ao "se houver persistência" do pedido em
   aberto sem comprometer a nenhuma feature ainda.
3. Se houver persistência: gerar as features de smart money no dataset (como pedido), sem treinar modelo
   novo ainda — depois rodar `ml-v2` com elas somadas às 71 atuais.
4. Rodar um **paper novo** (relógio já corrigido) por tempo suficiente para gerar um backtest comparável e
   reavaliar o critério da STRATEGY §7 — nenhuma decisão de v0.2/sinais deveria travar nisso indefinidamente
   sem mais dados ao vivo.
5. Só depois disso, se algum sinal (regras ou ML) mostrar retorno líquido positivo com IC acima de zero em
   dados nunca vistos, considerar VPS/live — nenhum dos dois pré-requisitos está cumprido hoje.
