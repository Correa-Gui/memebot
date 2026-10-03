# Estratégia v0 — momentum de segunda onda

Tudo aqui são **hipóteses iniciais** a serem testadas. Valores ficam em `config/strategy.v0.yaml`, nunca no código.
Mudou uma regra? Crie uma nova versão (`v1`, `v2`...) e registre abaixo o motivo e o resultado do backtest.

## 1. Tese

Os primeiros segundos pertencem a snipers profissionais e insiders. A estratégia não disputa esse momento: espera o token **sobreviver** aos primeiros minutos, descarta os que mostram sinais de manipulação e entra só quando há compra aparentemente orgânica. O ganho vem de **evitar lixo** e **sair rápido**, não de acertar o 100x.

## 2. Universo

- **Por enquanto, só tokens ainda na bonding curve** (`filters.allowedVenues: [curve]`). Tokens recém-graduados
  no PumpSwap ficam de fora do universo de entrada. O pré-requisito técnico — a matemática do swap do PumpSwap
  bater exato — foi cumprido em 2026-10-02 (ver `docs/ROADMAP.md` Fase 2, tarefa "Resolver swap exato do
  PumpSwap"); incluir graduados continua sendo **decisão do usuário**. Os dados necessários
  (`virtual_quote_reserves`, bps por trade) já são lidos pelo ingest/estado; a persistência depende da
  migração 011 e do backfill (ROADMAP Fase 2). Custo de ida e volta medido no PumpSwap (0,1 SOL,
  quote WSOL): ~2,2–2,5% (≈ 218–247 bps conforme o tier de taxa), contra ~2,5% na curva (2 × 125 bps).
  - Se uma posição aberta na curva **graduar para o PumpSwap enquanto está aberta**, o paper executor fecha a
    posição no último preço conhecido da bonding curve (não simula venda no PumpSwap) e marca o fill com
    `venue_unverified: true`. Enquanto o universo for só curva, qualquer tentativa de simular um swap no
    PumpSwap deve lançar erro explícito (`PumpSwapSimulationNotValidatedError`), nunca aproximar silenciosamente.
- Idade entre `entry.minAgeSec` (60) e `entry.maxAgeSec` (600).
- Quote mint permitido: só SOL (`filters.allowedQuoteMints`) — placeholder nativo da curva (`11111111111111111111111111111111`) e WSOL (`So11111111111111111111111111111111111111112`). Outros quote mints são rejeitados.

## 3. Filtros duros (qualquer um falha → `reject`)

| Filtro | Valor inicial |
|---|---|
| % do supply no top 10 holders (excluindo curva/pool) | ≤ 30% |
| % do supply comprado no slot de criação por carteiras **diferentes do criador** (proxy de bundle; v0.1) | ≤ 10% |
| Criador ainda segura (inclui a compra inicial, medida à parte como `creatorInitialBuyPct` no snapshot) | ≤ 5% |
| Criador criou ≥ 3 tokens nas últimas 24h | rejeita |
| Holders únicos | ≥ 40 |
| Volume últimos 60 s | ≥ 5 SOL |
| Score do modelo de risco (quando existir) | ≤ 0,3 |

## 4. Gatilho de entrada (todos verdadeiros)

- Razão buy/sell em volume nos últimos 60 s ≥ 1,5.
- Compradores únicos nos últimos 60 s ≥ 15.
- Preço acima da média dos últimos 120 s.
- Nenhuma venda individual > 3% do supply nos últimos 60 s.
- (Fase 5) Opcional: narrativa com `matchesNarrative ≥ 0,7` **ou** ≥ 2 smart wallets comprando reduz o requisito de compradores únicos.

## 5. Tamanho

- Valor fixo por operação: `sizing.sizeSol` = **0,05 SOL** (paper e live inicial), total pago à curva já com as
  taxas da curva (priority fee, tip e rent são custos à parte). Era 0,1 SOL fictício no paper; reduzido em
  2026-10-01 (Fase 3/parte B) porque o hard limit `maxPositionLamports` (0,05 SOL, `packages/risk/src/hard-limits.ts`)
  vale também no paper — assim o paper mede o que o live faria. A config só pode reduzir esse valor; acima dele
  o bot não sobe (erro explícito).
- Impacto de preço estimado da própria compra ≤ 2% (`sizing.maxOwnPriceImpactPct`), medido como preço médio de
  execução (sem taxas) ÷ preço marginal antes da compra − 1. Se maior, reduz o tamanho (busca binária) até caber;
  se o tamanho que cabe ficar abaixo de 50% do valor fixo, rejeita (os custos fixos por transação não encolhem).

## 6. Saídas (a primeira que acontecer)

| Regra | Valor inicial |
|---|---|
| Take profit 1 | +40% → vende 50% |
| Take profit 2 | +100% → vende mais 30% |
| Trailing stop no restante | −25% a partir da máxima |
| Stop loss | −20% |
| Time stop | 10 min sem atingir TP1 → vende tudo |
| Saída de emergência | venda individual > 5% do supply ou criador vendendo → vende tudo |

Todos os percentuais são **líquidos de taxas estimadas de saída**:
`pnl = (realizadoLíquido + L − custoEntrada) / custoEntrada`, com `custoEntrada` = SOL pago à curva (com taxas) +
priority fee + tip + rent da compra, e `L` = líquido de vender o restante agora (`bondingCurveSell`, já sem as taxas
da curva) − priority fee − tip estimados da saída + rent devolvido ao fechar a conta.

Detalhes de implementação (`packages/positions`): `sellFraction` dos take profits é fração da quantidade
**inicial** (50% + 30% → sobram 20%); o trailing só vale depois do TP1 e mede o valor líquido do restante (a
máxima recomeça após cada venda parcial); emergência considera só trades com `ts` posterior à entrada. Se várias
regras disparam no mesmo instante, vale a primeira em: graduação > criador vendendo > venda > 5% do supply >
stop loss > trailing > time stop > take profit. Graduação (curva completou / migrou) fecha tudo no último preço da
curva (§2).

## 7. Métrica de sucesso

Para a v0, o critério de sucesso é avaliado **em paper trading** (o backtest fora da amostra passa a valer
critério quando a Fase 4 do `docs/ROADMAP.md` existir):
- ≥ 200 operações.
- PnL líquido > 0 depois de **todas** as taxas, tips, rent e slippage simulados.
- Continua positivo mesmo removendo as 3 melhores operações.
- Drawdown máximo ≤ 30% do capital alocado.

## 8. Registro de versões

| Versão | Data | Mudança | Resultado (backtest fora da amostra) |
|---|---|---|---|
| v0 | — | versão inicial | — |
| v0.1 | 2026-10-01 | `maxSameSlotAsCreatePct` passa a ignorar as compras do criador no slot de criação (proxy de bundle = só outras carteiras); a compra inicial do criador vira a feature informativa `creatorInitialBuyPct` e continua coberta por `maxCreatorHoldingPct`. Motivo: no paper de 01/10, o criador comprou na mesma tx do create em 693 de 956 tokens (72%; mediana 0,5% do supply, p90 6,7%). Limites inalterados. Efeito medido: dos 331 tokens acima de 10% no slot, 286 continuam acima só com outras carteiras (o filtro muda para 45 tokens). | ainda sem backtest (Fase 4 condicional) — avaliar no paper |

### Experimentos de entrada offline — 2026-10-02 (Fase 4, `pnpm replay:sweep`; a v0.1 do paper NÃO mudou)

Motivo: paper v0.1 de 02/10 (`paper-2026-10-02T03-36-33-931Z-2e4393`) com PnL líquido −0,207 SOL, 69% das saídas por
stop em mediana 29 s e entrada em topo local. Hipóteses implementadas como opções DESLIGADAS por padrão (config
`entry.*`, `docs/ARCHITECTURE.md` §4) e testadas só em replay, com arquivos próprios em `config/variants/`:
(a) confirmação 10/30/60 s (`a-confirm-*`, queda máx. 10% na janela, fechar ≥ preço do sinal, filtros duros
reavaliados); (b) não perseguir 10/20/40% acima da média de 120 s (`b-nochase-*`); (c) recuo 15/25/35% do máximo desde
o sinal, em até 180 s, com `uniqueBuyers60s ≥ 15` (`c-pullback-*`); (d) melhor de (a)–(c) pelo AJUSTE + vender tudo
em +40% (`d-confirm60s-tp40all` = a-confirm-60s). Condições: relógio `paper_wall`, kill switch desligado, tokens com
lacuna excluídos, latência 800 ms, falha 10%, seed 1; ajuste = entradas 02/10 00:16 → 07:14 UTC (aquecimento só de
estado desde 22:16), validação = 07:14 → 11:53 UTC; pré-carga de 2 h de criadores nos dois.

| Variante | Ajuste: ops / líquido (SOL) | Validação: ops / líquido (SOL) | Positiva nos dois? |
|---|---|---|---|
| v0.1 (baseline) | 116 / −0,3873 | 115 / +0,0025 | não |
| a-confirm-10s | 61 / −0,0827 | 70 / +0,1080 | não |
| a-confirm-30s | 40 / −0,2194 | 59 / +0,0898 | não |
| a-confirm-60s | 26 / +0,0469 | 43 / −0,0147 | não |
| b-nochase-10 | 46 / −0,0037 | 42 / −0,0581 | não |
| b-nochase-20 | 78 / −0,1147 | 75 / −0,0584 | não |
| b-nochase-40 | 107 / −0,2348 | 107 / +0,0829 | não |
| c-pullback-15 | 60 / −0,2069 | 69 / +0,2399 | não |
| c-pullback-25 | 38 / −0,0289 | 42 / −0,0306 | não |
| c-pullback-35 | 21 / +0,0291 | 27 / −0,1611 | não |
| d-confirm60s-tp40all | 29 / +0,0612 | 45 / −0,0394 | não |

Resultado: **nenhuma variante foi positiva nos dois períodos**; todos os IC 95% da expectativa por operação incluem 0
(exceto c-pullback-35 na validação, negativo). Com 11 variantes e 20–115 operações por célula, a melhor do ajuste
(a-confirm-60s) inverteu o sinal na validação — padrão típico de sobreajuste/ruído. No relógio `event` (apêndice em
`data/reports/replay-sweep-v2-event.txt`) só b-nochase-20 fica positiva nos dois (+0,075 / +0,143), também com IC
incluindo 0 — o ranking muda com o relógio, outro sinal de que a amostra não distingue as hipóteses. Nada promovido a
v0.2; próxima decisão depende de um paper com o relógio corrigido e de mais dias de dados.

**2026-10-03 — universo GRADUADO (só replay, `pnpm replay:sweep --pumpswap --clock=event`; nada promovido).**
Pré-requisito: swap do PumpSwap exato em 11.463.859/11.463.859 trades reais (regra nova: pool sem criador não cobra a
taxa do criador). Variantes `config/variants/g*.yaml` (mesmos filtros/gatilho/saídas da v0.1, universo = tokens com
`curve_completed` visto no run, holders/janelas só pós-graduação): g0 = 1–10 min desde a graduação; g1 = 5–60 min;
g2 = g0 + market cap US$100k–1M (SOL/US$ = abertura da hora, Binance); cada uma também com "vende tudo em +40%"
(`-tp40all`). Mesmos períodos de ajuste/validação do sweep anterior. PnL líquido (SOL) ajuste | validação:
g0 −0,447 | −0,114; g0-tp40 −0,493 | −0,081; g1 −1,167 | −0,159; g1-tp40 −1,335 | −0,401; g2 −0,157 | −0,014;
g2-tp40 −0,172 | +0,004 (12 ops). Referência v0.1 (curva) na mesma passada: −0,458 | +0,212. Nenhuma positiva nos dois
períodos; todos os IC 95% da média por operação incluem 0 ou são negativos; stop loss domina as saídas (~50–60%).
Tabela completa: `data/reports/replay-graduated-2026-10-03.txt`.

**2026-10-03 — ml-v1 (Fase 5 adiantada; nada promovido).** Dataset de 100.930 pontos (13.970 tokens da curva, a cada
15 s entre 30 s e 15 min de vida), rótulo "bateu +40% antes de −20%" com compra simulada em t + 800 ms e custos
medianos reais. Divisão por tempo/token 60/20/20. XGBoost: AUC teste 0,768 (logística 0,669); precisão no top 5%
0,32 contra base 0,13 — o modelo ORDENA, mas o retorno líquido operando acima do limiar da validação (1 operação por
token) é −4,7% por operação no teste, IC 95% [−8,3%; −1,1%] (sem modelo: −6,0%). Sinais mais usados (SHAP): preço
marginal, nº de trades em 15–60 s, concentração (top 10, criador), progresso da curva, holders, compra no mesmo slot.
Detalhes: `data/reports/ml-v1.txt`.
