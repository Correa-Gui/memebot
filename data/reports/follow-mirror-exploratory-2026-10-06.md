# Smart money: seguir a saída — exploratório — 06/10/2026

**B já foi usado na análise anterior. Este teste é exploratório, não validação fora da amostra.**
A confirmação exige dados novos **posteriores a 05/10/2026 18:37 UTC**, sem reutilizar B para declarar aprovação.
Nenhuma estratégia, configuração do bot ou estado do pm2 foi alterado nesta tarefa.

## Leitura dos resultados

- **1 s:** espelho -29.5828 [-35.4376; -23.0423] SOL; fixa recalculada -31.1187 SOL; delta +1.5359 [-4.0672; +7.4903] SOL.
- **5 s:** espelho -31.6801 [-37.6398; -25.1712] SOL; fixa recalculada -43.8478 SOL; delta +12.1676 [+6.3782; +18.8251] SOL.
- **30 s:** espelho -30.9734 [-36.4130; -24.9062] SOL; fixa recalculada -66.2235 SOL; delta +35.2502 [+29.4885; +41.8683] SOL.

Nesta amostra, espelhar a saída **não produziu lucro líquido agregado**: os três ICs conservadores estão abaixo
de zero. A melhora em relação à fixa é detectável a 5 e 30 s neste bootstrap, mas não a 1 s; melhora relativa
não significa lucro. Mesmo o PnL agregado somente das posições encerradas é negativo nos três cenários.
Humanos prováveis, bots e snipers têm PnL conservador negativo e IC abaixo de zero; o criador tem IC amplo,
incluindo zero, e apenas uma carteira. Não há base neste teste para alterar estratégia ou declarar vantagem validada.

## Objetivo e desenho congelado

Mesmo bloco de 43h40m55s: A começa em `2026-10-03T22:56:12.222Z`; B começa em `2026-10-04T20:46:40.000Z` e termina
em `2026-10-05T18:37:07.729Z`. Preservei os milissegundos do corte original, citado de forma abreviada no pedido.
Mesmas 50 tops por PnL de A; classes calculadas exclusivamente em A e prioridade exclusiva
**sniper → bot → criador → humano provável**: 20 / 21 / 1 / 8 carteiras.
Rótulos são heurísticos; “humano provável” não é identidade humana verificada.

- Uma compra hipotética por **primeira compra carteira+mint em B**, como antes; não aumentar nossa posição
  nas compras subsequentes da líder. Orçamento por entrada: **0,05 SOL incluindo taxas DEX**, mais rede.
- Três cenários: atraso de entrada/saída **1/1 s, 5/5 s e 30/30 s**. Não é um grid de nove combinações.
- Espelho: quantidade nossa vendida = saldo nosso restante × quantidade vendida pela líder / saldo observado
  da líder imediatamente antes da venda. Arredondamento para baixo; venda integral da líder zera nosso saldo.
  Compras adicionais da líder atualizam o denominador. Cada venda parcial nossa paga rede novamente.
- Saldo líder reconstruído de trades SOL/WSOL disponíveis anteriores à entrada, incluindo histórico anterior
  a A somente para inventário. Transferências, holdings anteriores ao início da gravação e outros mercados
  não são observados. Se houver venda acima do saldo observado, fração é limitada a 100% e a carteira+mint é
  marcada como inventário incerto. Essa flag também agrega inconsistências observadas mais tarde em B e é
  apenas um diagnóstico retrospectivo; não seleciona entradas ou decide os trades.
- **60 minutos desde nossa entrada** é limite total, inclusive após vendas parciais; o relógio não reinicia.
  Stop −50% usa valor líquido de liquidação do restante + caixa já realizado − rede paga e projetada.
  O stop é avaliado na observação atual, sem atraso adicional deliberado; após um salto de preço a perda pode
  ultrapassar 50%. Stop/timeout têm prioridade sobre ordens parciais ainda aguardando cotação.
- Referência fixa recalculada: +40% / −20% do valor líquido executável e horizonte de 10 minutos,
  **mesmas entradas, curve-math e custo de rede** do espelho. Também não aplica atraso adicional ao gatilho de stop/TP.

## Execução, preços e custos

Somente SELECTs no banco. Em cada mint, ordem `(ts, slot, received_at, recv_seq, sig, event_index)`;
duplicatas `(sig,event_index)` descartadas. Timestamps on-chain têm resolução limitada; dentro deles a ordem
observada pelo recorder é aproximação, não a posição exata da nossa transação em um bloco.

Usa a primeira observação executável **em ou após** o horário devido, com reservas **após** o trade observado.
Na curva, reservas pós-trade vêm do evento. No PumpSwap, reservas pré-trade + resultado de curve-math
reconstroem o estado pós-trade (incluindo reserva virtual e taxa de LP que fica na pool).
Não usa preço médio `quote/token` como fill. As compras/vendas próprias usam bigint e
`bondingCurveBuy/Sell`, `pumpSwapBuyExactQuoteIn/Sell`, respeitando reservas reais e arredondamento.

As taxas DEX vêm dos bps do evento bruto decodificado pelo IDL local; PumpSwap trata pool sem criador.
Eventos de curva com cashback não suportado são descartados e contados. Taxas já estão no desembolso/recebimento;
**não são subtraídas duas vezes**. Offset virtual e impacto do tamanho de 0,05 SOL entram no cálculo.
Ordens parciais na mesma observação atualizam as reservas entre si. Na próxima observação, volta-se à trajetória
histórica: não há simulação contrafactual da reação de terceiros nem propagação permanente do nosso impacto.
Múltiplas carteiras/mints são operações independentes, sem limite global de capital ou concorrência de carteira.
Quando há mais de uma pool/venue, utiliza-se a da observação corrente; não há roteamento ótimo.

**Rede é estimada com amostras reais, não é um custo realizado de operações hipotéticas:** mediana de
`fee + jito_tip` de transações com uma assinatura, nas 24h **anteriores ao início da hora** da execução.
Mínimo de 30 amostras; neste run houve dados suficientes em todas as horas. Tip ausente é tratado como zero.
Custo por execução variou de **43,528 a 61,387 lamports**, cobrado na entrada e em toda saída parcial.
Não usa amostras futuras. Sem falhas simuladas de transação, custos de tentativa, rent não recuperável ou
slippage estocástico adicional. Conta de token suposta reutilizada ou com rent recuperável; saldo/rent preso e
competição por inclusão são riscos não cobertos. Portanto não é promessa de fill executável ao vivo.

## Amostra, censura e posições sem saída

Dos **10,124** sinais anteriores, **494** foram excluídos pelo
critério temporal pré-fixado `sinal + 60min30s < fim de B`; restaram **9,630**.
Se a entrada efetiva atrasar tanto que entrada + 60min alcance o corte, os dois métodos a excluem igualmente.
Isso evita dar à referência de 10 minutos uma amostra final privilegiada. Não usa dados depois de B para fechar posições.

| Atraso s | Sinais após corte temporal | Sem entrada | Entrada censurada | Entradas |
|---:|---:|---:|---:|---:|
| 1 | 9630 | 17 | 2 | 9611 |
| 5 | 9630 | 35 | 4 | 9591 |
| 30 | 9630 | 82 | 13 | 9535 |

Se não houver trade/cotação válida no momento previsto, a ordem espera a próxima observação até B terminar.
**O fill não é retrodatado** à última cotação anterior. Por isso a execução efetiva pode superar 60 minutos;
o vencimento é do sinal de saída, não garantia de liquidez. Se nenhuma saída executável aparecer até o fim,
a posição fica `unfilled`, sem preço de saída inventado.

O agregado principal abaixo é **PnL líquido conservador com residual dessas posições marcado a zero**:
recebimentos líquidos − desembolso − rede. É um limite inferior contábil condicionado às premissas, **não PnL
realizado de todas as posições**. Mostro também as posições efetivamente encerradas e a sensibilidade de inventário.

## Comparação pareada — SOL [IC 95%]

IC percentil com **2.000 reamostragens de clusters de mint**, seed determinístico 51934: todas as carteiras que
seguem o mesmo mint ficam juntas. Delta = espelho − fixa, calculado por carteira+mint pareados antes do bootstrap.
IC é de PnL total em uma amostra do mesmo tamanho; não é retorno previsto. Dependência entre mints, carteiras e
regimes não é totalmente capturada. Não há correção por múltiplas comparações; os quatro tipos são descritivos.

| Tipo | Atraso s | Entradas / fechadas espelho | Espelho conservador | Fixa recalculada conservadora | Delta pareado |
|---|---:|---:|---:|---:|---:|
| Humano provável | 1 | 1831 / 1811 | -3.8920 [-6.0150; -1.7028] | -3.1365 [-4.3309; -1.9030] | -0.7555 [-2.6634; +1.3731] |
| Humano provável | 5 | 1831 / 1808 | -4.4055 [-6.5792; -2.1461] | -3.9127 [-5.1405; -2.6319] | -0.4928 [-2.4112; +1.5816] |
| Humano provável | 30 | 1830 / 1809 | -4.6923 [-6.8737; -2.3715] | -4.7567 [-5.9849; -3.5141] | +0.0644 [-1.9529; +2.2191] |
| Bot provável | 1 | 6347 / 6204 | -17.3408 [-22.3623; -11.7785] | -17.3275 [-20.2427; -14.4875] | -0.0133 [-4.4108; +5.0767] |
| Bot provável | 5 | 6342 / 6192 | -19.2912 [-23.8552; -14.0894] | -23.7801 [-26.7716; -20.8075] | +4.4889 [+0.1549; +9.4940] |
| Bot provável | 30 | 6318 / 6154 | -19.0101 [-23.1451; -14.4410] | -34.7366 [-38.1838; -31.4780] | +15.7265 [+11.5193; +20.6452] |
| Sniper | 1 | 1376 / 1314 | -8.1302 [-9.9849; -6.0039] | -10.4958 [-12.2091; -8.7842] | +2.3656 [+0.1766; +4.7053] |
| Sniper | 5 | 1361 / 1312 | -7.8852 [-9.5822; -5.9512] | -16.0515 [-17.9360; -14.1651] | +8.1663 [+5.7678; +10.6279] |
| Sniper | 30 | 1330 / 1272 | -7.1906 [-8.9933; -5.3277] | -26.4715 [-28.3388; -24.5253] | +19.2809 [+16.7756; +21.7813] |
| Criador | 1 | 57 / 57 | -0.2198 [-0.8147; +0.8092] | -0.1589 [-0.3541; +0.0495] | -0.0609 [-0.7051; +0.9877] |
| Criador | 5 | 57 / 57 | -0.0983 [-0.7657; +1.0843] | -0.1034 [-0.3163; +0.1273] | +0.0051 [-0.7128; +1.2166] |
| Criador | 30 | 57 / 57 | -0.0804 [-0.7227; +0.9869] | -0.2587 [-0.4777; -0.0409] | +0.1783 [-0.4428; +1.1797] |
| **Total** | 1 | 9611 / 9386 | -29.5828 [-35.4376; -23.0423] | -31.1187 [-34.8589; -27.6428] | +1.5359 [-4.0672; +7.4903] |
| **Total** | 5 | 9591 / 9369 | -31.6801 [-37.6398; -25.1712] | -43.8478 [-47.7063; -39.8701] | +12.1676 [+6.3782; +18.8251] |
| **Total** | 30 | 9535 / 9292 | -30.9734 [-36.4130; -24.9062] | -66.2235 [-70.4379; -61.8942] | +35.2502 [+29.4885; +41.8683] |

## Sensibilidades — SOL [IC 95%]

“Só fechadas” exclui posições sem saída e tem **viés de sobrevivência**, não substitui o agregado principal.
“Inventário sem inconsistência detectada” também é seleção retrospectiva e não prova ausência de transferências.
Em especial, há apenas **uma carteira** no grupo exclusivo criador.

| Tipo | Atraso s | Sem saída | Inventário incerto | Espelho só fechadas | Espelho sem inconsistência detectada |
|---|---:|---:|---:|---:|---:|
| Humano provável | 1 | 20 | 66 | -2.8909 [-4.9636; -0.7375] | -3.8536 [-5.9349; -1.7515] |
| Humano provável | 5 | 23 | 66 | -3.2647 [-5.3569; -1.0536] | -4.4455 [-6.6091; -2.3620] |
| Humano provável | 30 | 21 | 66 | -3.6494 [-5.8637; -1.4940] | -4.7178 [-6.8937; -2.5275] |
| Bot provável | 1 | 143 | 30 | -10.2703 [-15.1049; -4.9318] | -17.1769 [-22.0345; -11.7924] |
| Bot provável | 5 | 150 | 30 | -11.8924 [-16.2223; -6.6740] | -19.1241 [-23.5395; -14.1633] |
| Bot provável | 30 | 164 | 30 | -10.9760 [-14.9506; -6.3152] | -18.8315 [-23.0528; -14.3161] |
| Sniper | 1 | 62 | 4 | -5.5945 [-7.2945; -3.6198] | -8.3257 [-10.1582; -6.2044] |
| Sniper | 5 | 49 | 4 | -5.8573 [-7.4642; -4.0320] | -8.0637 [-9.8034; -6.3114] |
| Sniper | 30 | 58 | 4 | -4.8155 [-6.4557; -2.9102] | -7.4102 [-9.1586; -5.4858] |
| Criador | 1 | 0 | 0 | -0.2198 [-0.8147; +0.8092] | -0.2198 [-0.8147; +0.8092] |
| Criador | 5 | 0 | 0 | -0.0983 [-0.7657; +1.0843] | -0.0983 [-0.7657; +1.0843] |
| Criador | 30 | 0 | 0 | -0.0804 [-0.7227; +0.9869] | -0.0804 [-0.7227; +0.9869] |
| **Total** | 1 | 225 | 100 | -18.9754 [-25.0862; -12.4638] | -29.5760 [-35.8806; -22.7834] |
| **Total** | 5 | 222 | 100 | -21.1126 [-26.8821; -14.5942] | -31.7315 [-37.5202; -25.3095] |
| **Total** | 30 | 243 | 100 | -19.5213 [-24.9474; -13.6680] | -31.0400 [-36.6652; -24.9161] |

## Comparação com os números publicados em 05/10

O histórico usava preço médio de trades, custo de rede constante de 37.275 lamports por perna e saída no
último preço até 10min. Portanto comparar diretamente totais históricos com este run mistura mudança de saída,
modelo de execução e amostra. O teste pareado principal acima isola a política com o novo motor comum.
“Histórico nos sinais comuns” apenas filtra o resultado antigo pelas entradas atuais; não recalcula seus fills.

| Tipo | Atraso s | Entradas antigas | Fixa publicada: SOL [IC95%] | Entradas históricas comuns | Fixa antiga nos sinais comuns: SOL [IC95%] |
|---|---:|---:|---:|---:|---:|
| Humano provável | 1 | 1915 | +10.2767 [-0.5036; +30.5593] | 1831 | +10.2867 [-0.5079; +30.9077] |
| Humano provável | 5 | 1915 | +8.9606 [-1.7750; +29.5878] | 1831 | +8.9532 [-1.7497; +29.7010] |
| Humano provável | 30 | 1915 | +9.1839 [-1.5822; +29.6230] | 1830 | +9.3195 [-1.5105; +30.1338] |
| Bot provável | 1 | 6708 | -3.2169 [-6.7065; +0.6415] | 6347 | -2.6000 [-6.1990; +1.3821] |
| Bot provável | 5 | 6705 | -2.9763 [-7.8679; +4.5667] | 6342 | -2.2797 [-7.0418; +4.8729] |
| Bot provável | 30 | 6687 | -5.5326 [-9.0799; -1.7855] | 6318 | -4.3056 [-7.8182; -0.3399] |
| Sniper | 1 | 1437 | -2.5232 [-3.7944; -1.1128] | 1376 | -2.3375 [-3.6943; -1.0908] |
| Sniper | 5 | 1422 | -1.6616 [-2.9264; -0.3560] | 1361 | -1.4110 [-2.6562; -0.1484] |
| Sniper | 30 | 1388 | -1.4637 [-2.6019; -0.3617] | 1330 | -1.2703 [-2.3237; -0.2144] |
| Criador | 1 | 64 | -0.0697 [-0.3265; +0.2498] | 57 | -0.0337 [-0.2958; +0.2563] |
| Criador | 5 | 64 | -0.0931 [-0.3659; +0.2225] | 57 | -0.0442 [-0.2925; +0.2732] |
| Criador | 30 | 64 | -0.2577 [-0.4742; -0.0304] | 57 | -0.1940 [-0.3941; +0.0168] |
| **Total** | 1 | 10124 | +4.4670 [-8.8769; +26.2371] | 9611 | +5.3155 [-7.7965; +27.3507] |
| **Total** | 5 | 10106 | +4.2296 [-9.9486; +28.8498] | 9591 | +5.2184 [-9.1363; +28.6968] |
| **Total** | 30 | 10054 | +1.9298 [-11.4445; +24.6133] | 9535 | +3.5496 [-9.4144; +26.9723] |

## Latências efetivas e sensibilidade de rede

Vetores abaixo são **p50 / p95 / máximo**. O custo constante antigo é apenas uma sensibilidade; o resultado
principal usa as amostras causais por hora. Latência grande reflete ausência de observação executável, não o
atraso de configuração. Ela limita a interpretação de “saída a mercado em 60 min”.

| Atraso s | Método | Execuções | Entrada após sinal (s) | Holding fechado (min) | PnL com rede fixa antiga (SOL) |
|---:|---|---:|---|---|---:|
| 1 | mirror | 31580 | [1.0, 10.0, 14856.0] | [0.4166666666666667, 60.8, 989.1333333333333] | -29.0756 |
| 1 | fixed | 18939 | [1.0, 10.0, 14856.0] | [0.5, 12.166666666666666, 869.45] | -30.8105 |
| 5 | mirror | 31433 | [5.0, 33.0, 14856.0] | [0.4166666666666667, 60.9, 988.85] | -31.1752 |
| 5 | fixed | 18662 | [5.0, 33.0, 14856.0] | [0.5833333333333334, 12.816666666666666, 869.45] | -43.5439 |
| 30 | mirror | 31189 | [30.0, 146.0, 18961.0] | [0.43333333333333335, 61.0, 979.1166666666667] | -30.4723 |
| 30 | fixed | 18098 | [30.0, 146.0, 18961.0] | [0.8, 15.05, 869.45] | -65.9282 |

Diagnóstico da leitura/decodificação: `{"swap_reconstruction_exact": 2652459, "market_observations": 3567658, "duplicates": 7, "unsupported_curve_cashback": 497}`.
O contador `swap_reconstruction_exact` confere baseOut nas compras e netQuoteOut nas vendas; em compra de base
exata o baseOut é o próprio input e essa checagem não valida sozinha os valores de quote. A matemática usada
tem os testes golden do repositório, mas não foi feita nova auditoria byte a byte de todos os campos de cada swap.

## Artefatos e reprodução

- `follow-mirror-2026-10-06/summary.json`: números, exclusões, custos horários e SHA-256 das entradas anteriores.
- `follow-mirror-2026-10-06/comparison.csv`: tabela principal em formato tabular.
- `follow-mirror-2026-10-06/trades.csv`: ledger compacto, com status, custo, saldo e flags por operação.
- `follow-mirror-2026-10-06/trades.csv.gz`: cópia comprimida do mesmo ledger para versionamento.
- `follow-mirror-2026-10-06/parts/outcomes-k*.json`: todas as execuções parciais; hashes em `manifest.json`.
- `follow-mirror-2026-10-06/inputs.json`: sinais e classes usados, congelados.
- `follow-mirror-2026-10-06/execution-diagnostics.json`: latência, quantidade de fills e sensibilidade de rede.

Na raiz, com os relatórios anteriores e o ClickHouse histórico disponíveis:

```powershell
node --experimental-strip-types --disable-warning=ExperimentalWarning --max-old-space-size=1536 apps/bot/src/research/follow-mirror.ts
python research/follow_mirror/report.py
```

Os scripts não alteram estratégia/pm2 nem gravam tabelas. A reprodução exige que raw_b64 ainda exista no banco;
se o TTL expirar, restaurar o snapshot em ambiente de pesquisa separado (este script não restaura automaticamente).
Não rerodar contra histórico incompleto sem conferir contadores de raw ausente. O manifesto identifica os
artefatos desta execução, não promete igualdade com um banco alterado no futuro.

## Verificação e estado do trabalho

- Typecheck passou; lint dos três arquivos TypeScript novos passou.
- `pnpm check` foi executado: typecheck passou, lint geral parou em 47 erros preexistentes (14 no exportador
  anterior e 33 em scripts de análise de `data/reports`). Nenhum erro de lint novo foi acrescentado.
- Suíte completa executada separadamente: 50 arquivos, **2.357 testes aprovados**, incluindo dez desta análise.
- `pnpm audit --prod`: nenhuma vulnerabilidade conhecida. Logs em `data/reports/follow-mirror-*-2026-10-06.log`.
- Conferência do ledger: 6 resultados por sinal elegível, sem duplicatas; contagens e PnL reproduzem o resumo
  para todos os tipos, atrasos e métodos. Uma colisão inicial A/a nos nomes de lote do Windows foi corrigida
  usando códigos ASCII e recompondo os lotes ausentes; o teste cobre os 58 prefixos base58. Os arquivos antigos
  `outcomes-X.json` diretamente na pasta raiz são intermediários incompletos e **não são a fonte final**;
  usar exclusivamente `parts/outcomes-kNNN.json` e o manifesto.
- ROADMAP: teste exploratório concluído, confirmação em dados novos permanece pendente; nenhum parâmetro da
  estratégia alterado, nenhum comando pm2 executado e nenhum dado do banco escrito por este script.

Próximo passo científico: definir o protocolo de confirmação antes de olhar os dados posteriores ao corte.
O resultado atual não autoriza otimizar saídas repetidamente em B nem promover o teste a estratégia.
