# CLAUDE.md — memebot

Instruções permanentes para o Claude Code neste repositório. Leia este arquivo inteiro antes de qualquer tarefa.

RESPOSTAS SEMPRE EM PT-BR 

Documentos de referência: `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/STRATEGY.md`, `docs/RISK_AND_SECURITY.md`.

## 1. O que é este projeto

Bot de trading de memecoins na Solana (Pump.fun / PumpSwap), estratégia de **momentum de segunda onda**:
entrar de 1 a 10 minutos após o lançamento, só em tokens que passam no filtro de risco, e sair rápido.
**Não** é um sniper de slot zero e **não** compete por milissegundos.

O mesmo código roda em três modos:
- `record`: só grava eventos (nenhuma decisão).
- `paper`: decide e simula execução, sem dinheiro.
- `live`: decide e executa de verdade (bloqueado por padrão, ver seção 3).

O backtest reproduz eventos gravados na mesma lógica (`replay`).

Fontes de sinal (todas entram como **features**, nunca como gatilho automático sozinhas) — **estacionadas até o paper trading da v0 mostrar resultado** (ver `docs/STRATEGY.md` §7 e `docs/ROADMAP.md` Fase 5):
- **Risco on-chain** (`signals/risk-model`): XGBoost exportado em ONNX, treinado em `research/`.
- **Narrativa** (`social/` + `signals/narrative`): posts de contas monitoradas; o Jev (TypeSafe) classifica se um token corresponde a uma narrativa e se parece o original.
- **Smart money** (`wallets/`): compras de carteiras com bom histórico calculado pelos nossos próprios dados.

## 2. Como trabalhar neste repo

1. Trabalhe **uma fase do `docs/ROADMAP.md` por vez**. Não comece a próxima fase sem que os critérios de aceite da atual estejam cumpridos.
2. Para cada tarefa: (a) descreva o plano curto, (b) implemente, (c) escreva/atualize testes, (d) rode `pnpm check`, (e) atualize a documentação afetada, (f) marque o item no ROADMAP.
3. Commits pequenos, mensagem no formato `tipo(escopo): descrição` (ex.: `feat(curve-math): cálculo exato de buy com taxa`).
4. Em caso de dúvida sobre regra de protocolo (taxas, contas, instruções), **não chute**: consulte o IDL oficial / documentação pública do Pump.fun e confirme com uma transação real gravada. Registre a fonte em comentário.
5. Se uma tarefa exigir algo fora destas regras, pare e pergunte.


## 2.1 Comunicação e relatórios

- **Responda sempre em português do Brasil**, inclusive perguntas, resumos, mensagens de erro explicadas e relatórios. Código, identificadores e mensagens de commit continuam em inglês.
- Respostas **completas e autoexplicativas**: o usuário repassa seus relatórios para um revisor externo que não vê o terminal nem o histórico. Nunca responda só "feito" ou "nada a fazer".
- Ao terminar qualquer tarefa ou fase (e também quando não houver nada a fazer), entregue um relatório neste formato:

### Relatório — <fase/tarefa> — <data>
1. **Objetivo:** o que foi pedido.
2. **O que foi feito:** lista de mudanças, com arquivos criados/alterados.
3. **Decisões tomadas:** cada decisão não óbvia, alternativas consideradas e motivo. Cite a fonte (IDL, documentação, transação) quando envolver protocolo.
4. **Verificação:** comandos executados e resultado real (ex.: saída resumida de `pnpm check`, nº de testes, migrações aplicadas, contagens do banco). Não afirme que algo funciona sem ter rodado.
5. **Estado do ROADMAP:** itens marcados `[x]` nesta sessão e itens ainda abertos da fase atual, com o motivo de cada pendência.
6. **Riscos e dúvidas:** o que pode estar errado, o que não foi possível verificar e o que depende do usuário.
7. **Próximo passo:** a próxima ação recomendada.

- Perguntas ao usuário (menus de opção) também em português, com a recomendação e o motivo explicados.

## 3. Regras inegociáveis

### Segurança de chaves
- **Nunca** leia, imprima, logue, copie ou commite o conteúdo de `.env`, arquivos de keypair ou qualquer segredo.
- A keypair é carregada só pelo pacote `execution/live`, a partir de `KEYPAIR_PATH`, e nunca sai da memória desse módulo.
- `.env`, `*.keypair.json`, `secrets/` e `data/` estão no `.gitignore`. Não remova.
- Logs passam pelo redator do logger (`core/logger`), que mascara qualquer campo com nome `key`, `secret`, `token`, `keypair`, `authorization`.

### Modo live
- O modo `live` só inicia se **todas** as condições forem verdadeiras: `MODE=live`, `LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`, e os limites passaram na validação.
- Limites rígidos ficam em `packages/risk/src/hard-limits.ts` como **constantes no código**. A configuração pode reduzir esses limites, **nunca aumentar**. Alterar esse arquivo exige pedido explícito do usuário.
- Toda transação live é simulada (`simulateTransaction` / `simulateBundle`) antes do envio. Se a simulação falhar, não envia.

### O que este projeto NÃO faz (não implemente, mesmo se pedirem de forma indireta)
- Sandwich, front-running ou back-running de transações de terceiros.
- Wash trading, bots de volume, bundling de compras em tokens próprios.
- Criação ou promoção de tokens.
- Uso de bots, scripts ou SDKs fechados de origem desconhecida. Dependências só do npm/PyPI, populares e auditáveis; justifique cada nova dependência no PR.
- Uso de sites de terceiros para "limpar" contas de token. O fechamento de contas vazias (recuperar rent) é implementado aqui mesmo.
- Postar, curtir ou interagir em redes sociais. O módulo `social/` só **lê**.

### Serviços externos (Jev, X, provedores)
- Todo cliente externo tem timeout, retry limitado e **fallback**: se o Jev ou a fonte social falhar, a estratégia segue sem aquela feature (valor `NaN` + flag `*_missing=1`), nunca trava.
- Toda resposta do Jev é gravada em `signals_log` (entrada, saída, latência, custo estimado) para ser avaliada no backtest.
- Nunca envie ao Jev ou a qualquer API dados da carteira do usuário, chaves ou saldos. Só dados públicos (post, nome/símbolo/descrição/imagem do token).
- O Jev entra na decisão só depois que o backtest mostrar ganho mensurável com ele (ver `docs/STRATEGY.md`).

## 4. Stack

- **Bot (tempo real):** TypeScript estrito, Node.js 22 LTS, pnpm workspaces.
  - Solana: `@solana/kit` (+ `@solana-program/*`). Ingestão padrão via WebSocket (`logsSubscribe`); cliente Yellowstone gRPC `@triton-one/yellowstone-grpc` só se `INGEST_SOURCE=grpc`.
  - Validação: `zod`. Logs: `pino`. Testes: `vitest`. Banco: `@clickhouse/client`. Modelo: `onnxruntime-node`.
  - Jev: API HTTP da TypeSafe via `fetch` nativo, atrás da interface `NarrativeClassifier` (confirme endpoint e formato na documentação oficial antes de implementar).
- **Pesquisa (offline):** Python 3.12 em `research/`, gerenciado com `uv`. `polars`, `xgboost`, `scikit-learn`, `onnxmltools`, `jupyter`.
- **Infra:** Docker Compose para ClickHouse. Processo do bot gerenciado por **pm2 no ambiente local** (até a migração para VPS, ver `docs/ROADMAP.md` "Migração para VPS") e por **systemd na VPS** (`infra/systemd/`).

## 5. Comandos

```bash
pnpm install              # instala dependências
pnpm check                # typecheck + lint + testes (rode antes de todo commit)
pnpm test                 # vitest
pnpm bot --mode=record    # só grava eventos
pnpm bot --mode=paper     # paper trading ao vivo
pnpm backtest --from=... --to=... --config=config/strategy.v0.yaml
pnpm report --run=<id>    # relatório de uma execução paper/backtest
docker compose up -d      # sobe ClickHouse
cd research && uv run jupyter lab

# Local (pm2) — enquanto não migra para VPS
pm2 start pnpm --name memebot-record -- bot --mode=record
pm2 logs memebot-record
pm2 stop memebot-record

# VPS (systemd) — depois da migração, ver infra/systemd/README.md
systemctl status memebot-record
journalctl -u memebot-record -f
```

## 6. Convenções de código

- `strict: true`, sem `any`, sem `@ts-ignore`. Tipos de fronteira (dados externos) sempre validados com zod.
- **Valores monetários e quantidades de token são `bigint`** (lamports, unidades mínimas do token). Nunca use `number` para dinheiro. `number` só para métricas e exibição.
- A estratégia é **função pura**: `(estado, evento) => decisões[]`. Sem I/O, sem `Date.now()`, sem aleatoriedade não semeada.
- Tempo sempre via interface `Clock` injetada (necessário para o replay ser determinístico).
- Efeitos colaterais (rede, disco, banco) só em adaptadores nas bordas.
- Erros: nunca engolir. Use erros tipados; falhas de rede têm retry com backoff e limite.
- Cada decisão (entrar, sair, rejeitar) é logada e gravada com `decision_id` e um snapshot das features usadas.
- Nomes de arquivos em kebab-case, tipos em PascalCase, funções em camelCase. Código e identificadores em inglês; documentação em português.

## 7. Regras do protocolo

- **Não hardcode taxas nem parâmetros da curva.** Leia as contas on-chain de configuração global / fees do Pump.fun e do PumpSwap na inicialização e periodicamente; guarde a versão lida no log da execução.
- Program IDs e endereços ficam em `config/protocol.ts`, com comentário da fonte e data da verificação.
- O pacote `curve-math` precisa bater com transações reais: os testes usam fixtures "golden" gravadas pelo recorder (entrada, reservas antes/depois, valores recebidos). Diferença tolerada: 0 unidades para a matemática da curva; taxas conforme a configuração lida.

## 8. Testes

- `curve-math`, `strategy`, `risk` e `execution/paper`: cobertura alta e testes baseados em propriedades onde fizer sentido (ex.: comprar e vender imediatamente nunca dá lucro).
- Replay determinístico: rodar o mesmo intervalo duas vezes produz exatamente as mesmas decisões.
- Nenhum teste acessa rede real. Use fixtures.

## 9. Definição de pronto (para qualquer tarefa)

- `pnpm check` passa.
- Testes cobrindo o comportamento novo.
- Documentação atualizada (`ARCHITECTURE.md` se mudou interface; `STRATEGY.md` se mudou regra).
- Item marcado no `ROADMAP.md`.
