# Auditoria de continuidade, ingestão, smart money e disco

**Corte fixado:** `2026-10-05T18:37:07.729Z` (UTC). O `memebot-record` permaneceu rodando durante a coleta e a exportação.

## 0. Continuidade do bloco

O bloco contínuo disponível vai de `2026-10-03T22:56:12.222Z` até o corte, duração de **43h40m55,507s**. A metade A termina em `2026-10-04T20:46:40.000Z`; a metade B começa nesse instante e segue até o corte. Cada metade tem aproximadamente 21h50m.

Há 2.620 registros de saúde por minuto, de `22:57:17.280Z` a `18:36:22.618Z`; `stream_gap_ms` máximo é zero. Não há evento `reconnect` no bloco, portanto não há lacuna real maior que 10 minutos. A atividade de trades chega a `18:37:07.000Z` nas duas venues. Usei o bloco inteiro.

## 1. `ingest_gaps` e exclusão por lacuna

O total histórico de **6.325.437 linhas** foi atingido em `2026-10-04T02:56:59.630Z`. Composição naquele corte:

| Tipo | Linhas | Leitura |
|---|---:|---|
| `trailing_bytes` | 6.287.315 | 99,4%; eventos conhecidos têm 8 bytes extras além do IDL, mas continuam sendo decodificados e emitidos. |
| `pool_unresolved` | 23.894 | Resolução de mint/pool pendente; não significa perda de mensagens do stream. |
| `unknown_event` | 14.072 | Discriminador fora do IDL atual; cobertura de parser incompleta. |
| `pool_resolve_failed` | 149 | Falha de resolução de pool, sem evidência de desconexão do stream. |
| `reconnect` | 7 | Reconexões explícitas. |
| `log_truncated` | 0 | — |

No bloco analisado, até o corte, foram 43.860.355 `trailing_bytes`, 95.762 `unknown_event`, 70 `pool_resolve_failed` e 1 `log_truncated`; nenhum `pool_unresolved` ou `reconnect`. Os 43.860.355 eventos conhecidos se dividem em PumpSwap `SellEvent` 19.600.649, PumpSwap `BuyEvent` 16.371.954 e Pump.fun `TradeEvent` 7.887.752. Cada grupo tem exatamente 8 bytes após o tamanho declarado no IDL. Isso é diagnóstico de extensão do payload, não 43,9 milhões de trades perdidos. Os 95.762 discriminadores desconhecidos não são decodificados.

Conferi `loadGaps()` e o caminho usado por replay e `ml:dataset`: não consultam nem transformam `pool_unresolved`/`pool_resolve_failed` em lacunas. As lacunas usadas são segundos sem trade de curva por pelo menos 4 s e intervalos `reconnect` explícitos. Portanto, **zero tokens foram excluídos por `pool_unresolved`**, zero tokens voltam por essa causa e o percentual é 0%; os resultados de graduados não precisam ser refeitos. Não alterei o filtro nem rodei o replay novamente. O mesmo filtro é compartilhado pelo dataset de ML.

## 2. Persistência de carteiras

### Método e limites

Considerei trades SOL/WSOL. Em cada carteira e mint, somei fluxos de entrada/saída e taxas DEX; posições abertas ou incompletas no fim de cada metade não entram no PnL realizado nem no acerto. O tempo médio é da primeira compra à última venda de posições fechadas. Somei custo de rede estimado de 37.275 lamports por assinatura carteira+mint (5.000 base + prioridade mediana observada de 32.275; tip mediano zero). Como amostras de `tx_costs` não se ligam a toda transação pública, esse custo é estimativa e pode contar uma assinatura multi-mint mais de uma vez.

A teve **59.939 carteiras** com pelo menos 10 mints diferentes; B teve 57.444. O CSV com PnL, acerto, posições fechadas, tempo médio e quantidade de tokens criados por todas as carteiras elegíveis de A está em [`wallets-a-2026-10-05.csv`](wallets-a-2026-10-05.csv). Para toda a lista, marquei candidatos a bot com média de pelo menos 10 eventos/minuto no intervalo ativo. Para as 50 selecionadas calculei também pico de operações/minuto, compras no slot de criação e tamanho modal de compra. A flag média falsa não significa “humano”: pode haver bursts, sniper ou tamanho repetido sem média alta.

### Top 50 de A e comparação em B

As 50 maiores por PnL líquido realizado em A somam **17.682,527 SOL** (média 353,651; mediana 118,967). Em B, 49/50 voltaram a negociar, 41 negociaram pelo menos 10 mints, 42 tiveram PnL realizado positivo e o grupo somou **14.151,964 SOL** (média 283,039; mediana 50,842). Os cinco maiores concentram 63,94% do PnL em A e 78,35% em B.

Comparei cada top com uma carteira aleatória determinística de perfil semelhante (número de mints e eventos): 47/50 controles encontraram correspondência dentro de ±20% em mints e ±25% em eventos; nos outros três usei a mais próxima entre 30 candidatas. Os controles somaram **71,754 SOL** em B (mediana −0,031). Em 42/50 pares, a top superou o controle em B. Diferença mediana pareada: **+46,838 SOL**, IC 95% bootstrap por carteira **[+36,874; +67,113]**; diferença média +281,604 SOL, IC 95% **[+107,455; +497,170]**.

Há persistência observada neste bloco: carteiras lucrativas selecionadas em A também foram muito mais lucrativas que controles em B. Ainda assim, **43h não bastam para afirmar alpha durável**: B só tem 21h50, o PnL é muito concentrado em poucos endereços e o topo inclui carteiras com operações excepcionais. A leitura é “sinal de persistência nesta amostra; generalização inconclusiva”.

### Tipos, cópias e simulação de follow

As flags são independentes e se sobrepõem: 37 bot provável, 20 sniper, 12 criador e 8 sem essas flags (humano provável). Bot provável = pico de pelo menos 10 operações/min ou tamanho de compra idêntico em pelo menos 70% de ao menos 30 trades; sniper = pelo menos 20% das compras no slot de criação; criador = mais de 5% dos eventos em mints próprios. Para as comparações por classe abaixo usei grupos exclusivos, com prioridade sniper → bot → criador → humano: 20 snipers, 21 bots, 1 criador e 8 humanos prováveis.

Entre 10.124 primeiras compras carteira+mint dessas 50 em B, 5.701 (56,31%) tiveram outra carteira comprando o mesmo mint no mesmo slot até 2 s depois, na ordem observada de `received_at`/`recv_seq`; média 1,544 carteiras copiadoras por sinal. Taxa por classe exclusiva: snipers 71,96%, bots 55,84%, humanos prováveis 47,26%, criador 25% (64 sinais). A ordem no slot é aproximação do que foi observado pelo recorder.

Simulei investimento de 0,05 SOL na primeira cotação observada pelo menos 1/5/30 s após o sinal, saída no primeiro preço observado em +40%/−20% ou no último preço até 10 min. Taxas DEX estão embutidas nos fluxos/preços observados; descontei 0,000037275 SOL por perna para rede. Não modelei impacto de mercado da nossa ordem, então é uma simulação price-taker, não fill executável garantido.

| Atraso | Entradas | PnL líquido | IC 95% por mint | Resultado |
|---:|---:|---:|---:|---|
| 1 s | 10.124 | +4,467 SOL | [−8,877; +26,237] SOL | Inclui zero |
| 5 s | 10.106 | +4,230 SOL | [−9,949; +28,850] SOL | Inclui zero |
| 30 s | 10.054 | +1,930 SOL | [−11,444; +24,613] SOL | Inclui zero |

Por classe, o follow de snipers ficou negativo nos três atrasos e os ICs ficaram abaixo de zero. O follow de bots também foi negativo, com IC abaixo de zero em 30 s. Humanos prováveis mostraram PnL positivo, mas todos os ICs incluem zero e há apenas 8 carteiras. A cópia simples **não demonstrou vantagem geral** nesta janela. Detalhes de amostra e ICs por tipo estão em [`follow-simulation-summary-2026-10-05.csv`](follow-simulation-summary-2026-10-05.csv); pares top/controle em [`top50-a-vs-controles-b-2026-10-05.csv`](top50-a-vs-controles-b-2026-10-05.csv).

### Features de smart money no dataset

Adicionei ao gerador do dataset seis campos causais: `smartMoneyBuyerCount60s`, `smartMoneyBuyerShare60s`, `smartMoneyScore60s`, `smartMoneyMaxScore60s`, `smartMoneyMeanWinRate24h60s` e `smartMoneyPriorClosedPositions24h60s`. O histórico de cada comprador considera posições totalmente fechadas nas 24 h anteriores; a qualificação exige ao menos 5 posições, PnL DEX positivo e acerto acima de 50%. O score é congelado no instante da compra e as features da moeda só contam compras anteriores a `t`, numa janela de 60 s. A leitura de trades de carteiras fora do mint ativo é em lotes de slots, sequencial e limitada a SOL/WSOL. Custos de rede não entram nesse score porque a amostra de taxas não está correlacionada a toda transação pública. O gerador foi ligado ao `ml:dataset` e passou no typecheck. Não materializei o CSV completo de 43 h nesta execução: a RAM já estava em 87% e o snapshot/replay de todo o bloco competiria com o recorder. Não treinei modelo novo.

## 3. Política de disco e exportação

Exportei um snapshot Parquet ZSTD até o corte, particionado por tabela/data e shard da chave de ordenação. As 708 partes somam **59.391.065** linhas de `events_trade`, **48.623.038** de `pumpswap_trade_extra` e **46.005.284** de `ingest_gaps`; os arquivos Parquet ocupam 22.800.274.143 bytes. Para cada parte, comparei contagem de origem com `file(..., 'Parquet')`, SHA-256 remoto com local e magic `PAR1` no início e no fim. Revalidei o manifesto completo: 0 partes ausentes, 0 diferenças de linhas, 0 diferenças de tamanho e 0 assinaturas inválidas. O manifesto com SHA-256 por arquivo está em `data/cold/manifest.json`.

Depois da verificação, apliquei `raw_b64` TTL 14 dias, `pumpswap_trade_extra` TTL 60 dias e `ingest_gaps` TTL 60 dias. **O TTL de `events_trade.sig` em 45 dias não pôde ser aplicado:** o ClickHouse 24.8 rejeitou a coluna por fazer parte do `ORDER BY (mint, slot, sig, event_index)`. Não converti isso em TTL de linha, pois apagaria também os trades decodificados aos 45 dias. Para preservar as linhas quentes, seria necessária uma migração que recrie a tabela com chave de ordenação sem `sig`, mantendo a correlação no Parquet. Nenhuma linha foi apagada no momento: todos os dados têm menos de 6 dias, abaixo dos TTLs. Não há mutation TTL pendente. O recorder continuou online.

Às `2026-10-05T20:41:45Z`, C: tinha **17,76 GiB livres**; o Parquet ocupa **21,23 GiB**. Os TTLs ainda não reduzem esse uso porque os dados não chegaram à idade de expiração.

## Arquivos detalhados

- [`wallets-a-2026-10-05.csv`](wallets-a-2026-10-05.csv): todas as 59.939 carteiras elegíveis de A.
- [`top50-a-vs-controles-b-2026-10-05.csv`](top50-a-vs-controles-b-2026-10-05.csv): desempenho pareado e classificação das tops.
- [`follow-simulation-summary-2026-10-05.csv`](follow-simulation-summary-2026-10-05.csv): PnL e ICs por atraso e tipo.
- [`audit-summary-2026-10-05.json`](audit-summary-2026-10-05.json): séries de contagem e resumo da auditoria.
- [`cold-export-verification-2026-10-05.json`](cold-export-verification-2026-10-05.json): validação agregada do Parquet e situação dos TTLs.
