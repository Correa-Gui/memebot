# ML v2 — protocolo pré-registrado

Data: 06/10/2026. Estado: **SOMENTE PRÉ-REGISTRO; EXECUÇÃO NÃO AUTORIZADA**.
Código de referência: `ceac2df336051e1ae33d561dc46141129ae4c1fe`.
Este documento congela o experimento antes de consultar o período de teste nesta tarefa.
Não foram consultados dados posteriores ao corte, gerados datasets ou treinados modelos para este pré-registro.

## 1. Autorização e fronteiras

- Corte fixo **C = `2026-10-05T18:37:07.000Z` (UTC)**.
- Desenvolvimento: somente histórico anterior a C. Para não compartilhar o evento de fronteira,
  treino/validação usam `ts < C`; teste usa `ts >= C`.
- Teste: intervalo **[C, T)**; **T será informado pelo usuário**, em UTC, junto da autorização explícita.
  Aproximadamente três dias novos é uma intenção de coleta, não autorização automática nem motivo para espiar resultados.
- **Parte 2 não deve ser executada agora**: não extrair, inspecionar distribuição de features/rótulos,
  selecionar tokens, calcular métricas, treinar ou inferir sobre o teste. Nenhum agendamento automático.
- Autorizar a Parte 2 significa uma execução confirmatória conjunta de v2 e controle v1, com T registrado
  antes de acessar o teste. Não reiniciar recorder, alterar pm2, promover modelo ou modificar estratégia implicitamente.

**Sobreposição histórica conhecida:** os relatórios exploratórios anteriores usaram o corte
`2026-10-05T18:37:07.729Z`. Portanto [C, C+729 ms] já pode ter sido examinado. Manter C como origem formal,
mas colocar esse trecho em quarentena e excluir do teste tokens criados até C+729 ms, bem como qualquer
token usado no desenvolvimento. Não consultar esse trecho agora para decidir a exclusão: ela é fixa e temporal.
Não apresentar os testes antigos A/B, ML v1 ou follow como evidência confirmatória independente.

## 2. Universo, amostragem e features

Mesmo universo do dataset ml-v1: **tokens da bonding curve Pump.fun, cotados em SOL/WSOL**, com criação
observada e dados elegíveis segundo as regras de lacunas do gerador. PumpSwap pode alimentar o histórico
causal das carteiras; não amplia o universo de operações rotuladas para graduados nesta experiência.
Amostragem de 15 em 15 segundos, entre 30 segundos e 15 minutos de idade, com trade recente e curva ainda
ativa, conforme `apps/bot/src/ml/dataset.ts`. Mesmas linhas, rótulos e filtros para os dois modelos.

**ML v2 = exatamente 77 features: as 71 do ml-v1 + seis de smart money.**
Fixar nomes, ordem e tipos em manifesto antes do teste; conferir contagem e rejeitar colunas extras.

As 71 originais, definidas pelo código de referência, são:

- 16 campos: `ageSec`, `curveProgress`, `uniqueHolders`, `top10HolderPct`, `sameSlotBuyPct`,
  `buySellVolumeRatio60s`, `uniqueBuyers60s`, `volume60sSol`, `largestSingleSellPctSupply60s`,
  `priceAboveMean120s`, `creatorHoldingPct`, `creatorTokensCreated24h`, `creatorInitialBuyPct`,
  `hourBrt`, `tradesTotal`, `marginalPrice`.
- Para cada W em **15, 30, 60, 120, 300** segundos, 11 campos (55 no total): `vol{W}s`, `buyVol{W}s`,
  `sellVol{W}s`, `netFlow{W}s`, `buyers{W}s`, `sellers{W}s`, `trades{W}s`, `buySellRatio{W}s`,
  `largestSellPct{W}s`, `priceVsMean{W}s`, `priceChange{W}s`.

As seis adicionais são exatamente:

| Feature | Definição |
|---|---|
| `smartMoneyBuyerCount60s` | Número de compradores únicos qualificados nos últimos 60 s |
| `smartMoneyBuyerShare60s` | Fração dos compradores únicos que são qualificados |
| `smartMoneyScore60s` | Soma dos scores dos qualificados |
| `smartMoneyMaxScore60s` | Maior score dos qualificados |
| `smartMoneyMeanWinRate24h60s` | Média do acerto histórico dos qualificados |
| `smartMoneyPriorClosedPositions24h60s` | Soma das posições históricas fechadas dos qualificados |

Regras congeladas de `apps/bot/src/ml/smart-money.ts`:

- Janela de compradores **[t−60 s, t)**, comprador único, sinal da compra mais recente na janela.
- Para cada compra em s, score congelado usando somente posições fechadas em **[s−24 h, s)**.
  Qualificação: pelo menos cinco posições totalmente fechadas, PnL DEX positivo e acerto estritamente > 50%.
- Score = `min(10, log1p(max(0, pnlSol)) * winRate)` quando qualificado; zero caso contrário.
- Fluxos de carteira incluem taxas DEX; não inventar custo de rede por transação pública sem amostra vinculada.
  Omitir rede do score não significa omiti-la do rótulo da nossa operação.
- Preservar zeros/NaN do código: ausência de compradores ou de qualificados não é informação futura.
  Não usar uma lista global de tops de A/B, classificação de humanos/bots/snipers ou PnL futuro como feature.
- As 71 features originais usam somente informações disponíveis até t, como no ml-v1; as seis novas
  impõem a exclusão estrita de eventos em t e de fechamentos no instante da compra.
- Aquecimento cronológico de 24 h, sem retroalimentação de dados posteriores ao instante avaliado.
  Durante o teste, atualizar o estado das carteiras com eventos de mercado anteriores a t é permitido:
  isso é cálculo causal de feature, **não treinamento/ajuste do modelo**. Não usar rótulos futuros do teste.

## 3. Rótulo e retorno — iguais ao ml-v1

Referência normativa: `DatasetBuilder` em `apps/bot/src/ml/dataset.ts`, adaptador
`apps/bot/src/ml-dataset.ts` e matemática/custos do commit de referência. Não usar o motor follow-mirror
nem substituir o rótulo por saídas espelhadas ou preço médio de trades.

- Compra simulada em **t+800 ms**, orçamento de **0,05 SOL** para swap incluindo taxas DEX, custos de rede/rent
  conforme o gerador. Valores financeiros e quantidades calculados em bigint.
- **Take profit +40%, stop −20%, horizonte 10 minutos desde a entrada**; gatilhos pelo retorno líquido de
  liquidação. Venda após a latência de 800 ms, inclusive timeout, como no ml-v1. Sem falhas aleatórias de transação.
- Preservar o tratamento de graduação do ml-v1: fechamento no último estado da curva. Documentar sua limitação;
  não mudar para simular venda PumpSwap apenas no v2.
- Alvo binário `hit_tp`: 1 quando a saída for `take_profit`, 0 nas demais saídas válidas.
  Avaliação econômica usa `net_return` do mesmo rótulo, não probabilidade, AUC ou acurácia como substitutos.
- `net_return = (valor líquido final − entryCost) / entryCost`, conforme o gerador; inclui custos da entrada,
  saída e tratamento de rent. Não confundir retorno médio por operação com PnL total ou média por amostra.
- Taxas/parametrização da curva vêm dos snapshots `protocol_config` vigentes causalmente; não usar o snapshot
  mais recente se ele for posterior ao evento. Preservar a regra de taxas do gerador ml-v1 para ambos os modelos.
- Rede: medianas históricas de prioridade e de tips positivos disponíveis no instante da entrada, lookback
  **24 h**, taxa base **5.000 lamports**; fallback **500.000 lamports por componente** sem amostra, como os
  defaults do ml-v1. Rent observado **1.513.840 lamports**, com devolução conforme o gerador. Fixar esses valores
  explicitamente na futura execução; não herdar silenciosamente overrides de `.env`.
- Custos de saída são fixados na entrada pelo gerador ml-v1. São estimativas fundamentadas em amostras reais,
  não taxas realizadas de uma transação hipotética. Contabilizar e publicar frequência dos fallbacks.
- Usar somente estados de mercado disponíveis até o horário simulado; nenhum evento depois da fronteira
  de uma partição pode completar seu rótulo. Não tratar rótulo incompleto como perda, ganho ou classe zero.

## 4. Divisão temporal e por token, com purga

Todo o histórico elegível anterior a C pode ser usado para desenvolvimento, inclusive A/B já explorado e
os dados consumidos pelo ml-v1; essa reutilização não lhe confere status de teste novo.

1. Somente após autorização, ordenar tokens elegíveis do desenvolvimento por `(created_at_ms, mint)`.
   N = número de tokens. Definir V como a criação do token na posição `floor(0,80*N)` (indexação a partir de zero).
   Treino: tokens criados **antes de V**. Validação: tokens criados **em ou após V e antes de C**.
   Empates no timestamp ficam integralmente na validação; proporção nominal **80%/20%**. Sem divisão aleatória.
2. Purga temporal: a janela inteira de features/entrada/desfecho de cada rótulo de treino deve terminar antes
   de V; a de validação antes de C. Para evitar seleção pelo desfecho, exigir a priori espaço para o horizonte
   máximo: **t + 10 min + 1.600 ms < fronteira**. Aplicar também os filtros fixos de criação/lacunas do ml-v1,
   inclusive margem de criação de 15min + 10min + 120s antes do fim de cada bloco; nunca relaxar para aumentar N.
3. Teste: tokens novos criados em [C,T), respeitando a quarentena da seção 1; nenhuma amostra de token
   presente no treino/validação. Exigir criação observada e horizonte inteiro antes de T com a mesma purga.
   Tokens antigos que continuam negociando depois de C servem apenas ao estado causal das carteiras.
4. Assertivas obrigatórias: interseções de mints vazias; fronteiras de todas as consultas de mercado, custos,
   protocolo, rótulos e warm-up verificadas; nenhuma observação de treino/validação em `ts >= C`.
   Registrar V, T, manifestos de mints, blocos, contagens e exclusões, sem escolher fronteiras por retorno.
5. Transformações/imputação, pesos de classe e qualquer estatística aprendida são ajustados **somente no treino**.
   Missing values seguem a semântica nativa do XGBoost; não selecionar features pela validação ou pelo teste.

Se faltar histórico, configuração causal, classe para treino/AUC ou integridade das partições, interromper
antes de abrir os resultados do teste e registrar falha técnica. Não contornar mudando cortes ou features.

## 5. Modelo, busca e limiar — somente validação

Modelo confirmatório: **XGBoost `binary:logistic`**, seed **7**, `tree_method=hist`.
Não há seleção posterior entre famílias de modelos. Regressão logística e outros modelos ficam fora deste teste.

Busca fechada e idêntica para v1/v2, definida agora sem consultar o teste:

- Grade de **nove candidatos**: `max_depth ∈ {3,4,5}` × `min_child_weight ∈ {10,20,40}`.
- Fixos: `n_estimators=2000`, `learning_rate=0.03`, `subsample=0.8`, `colsample_bytree=0.8`,
  `reg_lambda=5.0`, `eval_metric=auc`, `early_stopping_rounds=100`, `random_state=7`.
- `scale_pos_weight = (1−p)/max(p,1e−9)`, p = fração positiva **do treino**.
- Escolher maior AUC na validação; empate: menor profundidade, depois maior `min_child_weight`.
  Usar a melhor iteração por early stopping. Não aumentar grade, sementes ou orçamento após ver resultados.
- Para o candidato escolhido, buscar o limiar nos quantis de probabilidade da validação:
  **0,50; 0,60; 0,70; 0,80; 0,85; 0,90; 0,93; 0,95; 0,97; 0,98; 0,99; 0,995**.
  Quantil com interpolação linear, como `numpy.quantile` padrão no ml-v1.
- Para cada limiar, operar a **primeira amostra cronológica por mint com p ≥ limiar**, no máximo uma operação
  por mint. Selecionar maior retorno líquido médio na validação, entre limiares com **≥30 operações**.
  Empate: primeiro quantil da lista acima. Não exigir validação positiva para escolher; publicar seu resultado.
- Sem limiar elegível: registrar ausência de modelo operacional; não reduzir o mínimo nem procurar limiar no teste.
- O mínimo de 30 é exclusivo da seleção na validação. **No teste o mínimo obrigatório é 300.**
- Cada modelo escolhe seus hiperparâmetros/limiar na mesma validação e com igual orçamento. Não retreinar em
  treino+validação depois: conservar os modelos treinados no treino, com iterações selecionadas na validação.
- Antes do acesso ao teste, salvar modelos, ordem de features, versões de bibliotecas, configuração explícita,
  hiperparâmetros, melhor iteração e limiares num manifesto com SHA-256. Congelar também o código executor.

## 6. Teste único e critério de aprovação

Após autorização e T informado, executar **uma única avaliação confirmatória**, com v2 e v1 congelados,
no mesmo conjunto elegível. Não usar early stopping, calibrar probabilidades, mudar limiar, selecionar subgrupo,
alterar custo, filtrar perdedores ou ajustar parâmetros usando qualquer resultado do teste.

Para cada modelo, uma operação por mint: primeira amostra que cruza seu limiar fixo. Avaliar todas as operações
assim selecionadas. Sem cruzamento = nenhuma operação, não retorno artificial zero na média por operação.

IC95% da **média aritmética dos retornos líquidos por operação**: bootstrap percentil,
**5.000 reamostragens com reposição de operações/mints**, quantis 2,5% e 97,5%, seed **7** reinicializado
por modelo. Ordenar operações por `(created_at_ms, mint, t_ms)` antes de reamostrar.
Como há uma operação por mint, não reamostrar as múltiplas linhas de features como observações independentes.
É o estimador do ml-v1; dependências entre tokens/regimes continuam sendo limitação e devem ser declaradas.

**ML v2 APROVADO se, e somente se, simultaneamente:**

1. **N de operações no teste ≥ 300**;
2. **retorno líquido médio por operação > 0**;
3. **IC95% inteiro estritamente acima de zero** (limite inferior > 0; limites finitos).

**Caso contrário: REPROVADO.** N < 300, inclusive zero operações, não permite prolongar T após ver o resultado
nem reduzir a exigência. Métrica indefinida não aprova. Erro técnico sem avaliação válida não deve ser descrito
como resultado econômico: a execução é inválida e fica sem aprovação, com logs e exposição ao teste registrados.

Depois da divulgação, nenhum ajuste nesta experiência. Correção técnica após exposição a previsões/rótulos/
métricas deve preservar a tentativa original e ser reportada como diagnóstico, nunca substituir a confirmação.
Nova hipótese, novo período ou nova tentativa requer outro pré-registro e dados ainda não consumidos.

## 7. Controle obrigatório: ml-v1 retreinado sem smart money

Treinar **ml-v1 de controle com as mesmas 71 features originais**, mesmos rótulos, linhas, partições, custos,
busca, seed, early stopping e regra de limiar. ML v2 usa as mesmas linhas com as seis colunas adicionais.
Não comparar apenas com o modelo antigo treinado em outra amostra. A diferença de entrada entre braços
é exclusivamente a presença das seis features; parâmetros e limiares podem divergir por seleção na validação.

Relatório único obrigatório: para ambos, N, retorno médio, IC95%, PnL líquido total calculado pelo ledger real
da simulação, acerto, parâmetros, limiar, AUC descritiva e exclusões; depois **Δ de retorno médio (v2−v1)**,
Δ de PnL e número de mints operados em comum/exclusivos. Não confundir operações diferentes com pares idênticos
nem afirmar ganho significativo apenas pela diferença pontual. Mostrar resultados mesmo se v2 perder do controle.

A comparação mede o ganho observado das features novas; **não acrescenta um quarto critério de aprovação**.
V2 pode cumprir o critério absoluto e não demonstrar benefício sobre v1: registrar as duas conclusões separadamente.
Nenhuma análise descritiva do teste pode mudar o veredito, a regra de operação ou originar nova seleção neste teste.

## 8. Registro imutável e execução futura

O commit que **introduz este arquivo** é o commit do protocolo. Seu hash completo e o SHA-256 do arquivo
serão registrados em **`docs/ML_V2_PROTOCOL_COMMIT.json`**, em commit administrativo posterior, sem modificar
o protocolo: evita tentar inserir dentro de um commit o próprio hash, que mudaria com essa inserção.

O recibo não autoriza execução. Na Parte 2, registrar: autorização do usuário, T, hash deste protocolo,
hash do executor congelado, manifestos/hash dos datasets e modelos, início/fim da execução e relatório dos
dois braços. Artefatos em `data/reports/`; não sobrescrever a tentativa original.

Antes de abrir o teste, a implementação deve passar testes sintéticos de causalidade, warm-up, inexistência
de mints comuns, purga dos rótulos, custos/latência e invariância: acrescentar dados futuros não pode mudar
features/rótulos anteriores ao seu horizonte. Esses testes não exigem consultar o período reservado.

**Pendências deliberadas: autorização da Parte 2 e T. Nada será executado só porque passaram três dias.**
