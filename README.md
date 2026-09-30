# memebot

Bot de trading de memecoins na Solana (Pump.fun/PumpSwap), estratégia de momentum de segunda onda, com gravação de dados, backtest, paper trading e (depois) execução real com limites rígidos.

Leia nesta ordem: `CLAUDE.md` → `docs/ARCHITECTURE.md` → `docs/ROADMAP.md` → `docs/STRATEGY.md` → `docs/RISK_AND_SECURITY.md`.

## Antes de começar (fora do código)

1. **VPS:** Linux (Ubuntu 24.04), idealmente EUA leste ou Alemanha. Teste: `ping ny.mainnet.block-engine.jito.wtf`.
2. **Provedor de RPC com WebSocket** (ex.: Helius Developer, ou equivalente) na mesma região da VPS. Guarde a URL HTTP e a URL `wss://`. Yellowstone gRPC é **opcional** e só vale a pena se o WebSocket se mostrar insuficiente (ver `docs/ARCHITECTURE.md` §8).
3. **Instale na VPS:** Node.js 22, pnpm, Docker + compose, Python 3.12 + `uv`, git.
4. **Telegram:** crie um bot no @BotFather para os alertas.
5. Copie `.env.example` para `.env` e preencha. **Não** crie a keypair ainda (só na Fase 6).

## Rodar localmente com pm2 (enquanto não há VPS)

Por enquanto o bot roda na máquina local, gerenciado pelo [pm2](https://www.npmjs.com/package/pm2)
(gerenciador de processos Node, instalado globalmente — não é dependência do projeto). Na VPS o gerenciador
passa a ser o systemd (`infra/systemd/`, ver ROADMAP "Migração para VPS").

Pré-requisitos (uma vez):

```bash
npm install -g pm2@7              # gerenciador de processos
pnpm install
docker compose up -d              # ClickHouse
pnpm migrate                      # cria/atualiza as tabelas (idempotente)
# .env: preencha RPC_URL e RPC_WS_URL com o RPC pago (o RPC público limita requisições e conexões)
```

| Ação | Comando |
|---|---|
| Iniciar a gravação | `pm2 start ecosystem.config.cjs` |
| Status (online, reinícios, memória) | `pm2 status` · detalhes: `pm2 show memebot-record` |
| Logs ao vivo | `pm2 logs memebot-record` · arquivos: `data/logs/memebot-record.{out,err}.log` |
| Parar (grava o buffer antes de sair) | `pm2 stop memebot-record` |
| Reiniciar (ex.: depois de editar o `.env` ou atualizar o código) | `pm2 restart memebot-record` |
| Remover do pm2 | `pm2 delete memebot-record` |

A cada minuto o log traz `eventsPerMin`, `gapsPerMin` e `writer` (`written`, `failedFlushes`, `dropped`).
Sinal de problema: `eventsPerMin` perto de zero, `failedFlushes`/`dropped` subindo ou muitos reinícios em `pm2 status`.

Cuidados no Windows:
- **Suspensão/hibernação para o bot.** Para as 12 h do aceite da Fase 1, desative a suspensão enquanto grava.
- **Não volta sozinho depois de reiniciar o PC** (o `pm2 startup` não funciona no Windows): depois do boot,
  `docker compose up -d` e `pm2 start ecosystem.config.cjs` (ou `pm2 save` uma vez e `pm2 resurrect` a cada boot).
- **Variáveis do ambiente têm precedência sobre o `.env`.** Inicie o pm2 de um terminal sem `RPC_URL`/`RPC_WS_URL`
  definidos; se já estiverem no pm2, use `pm2 delete memebot-record` e `pm2 start ecosystem.config.cjs` de novo.
- Logs crescem sem limite; se ficar muito tempo rodando: `pm2 install pm2-logrotate`.

### Conferência e sanidade

```bash
# imprime os N primeiros eventos parseados com link do Solscan e sai (não grava nada).
# O valor é obrigatório: --debug-events sozinho dá erro.
pnpm bot --mode=record --debug-events=20

# relatório da gravação: eventos/min, maior silêncio, tokens/hora, reconexões, gaps, % parse falho, latência, custos
pnpm sanity --hours=12            # aceite local da Fase 1 (≥ 12 h, sem silêncio > 60 s)
pnpm sanity --hours=1             # checagem rápida
```

Com o RPC público, o modo debug pode não conectar enquanto o pm2 estiver gravando (o endpoint parece limitar
conexões WebSocket por IP): pare o pm2 antes (`pm2 stop memebot-record`) ou use o RPC pago.

## Prompts iniciais para o Claude Code

Abra o Claude Code na pasta do projeto e use um prompt por vez, esperando cada um terminar.

**1. Fase 0**
```
Leia CLAUDE.md e todos os arquivos em docs/. Depois execute a Fase 0 do docs/ROADMAP.md:
monorepo pnpm, TypeScript estrito, vitest, eslint, pnpm check, packages/core (tipos, Clock,
config zod, logger com redação e teste da redação), migrações do ClickHouse para as tabelas
de ARCHITECTURE.md §6 e config/protocol.ts. Antes de escrever config/protocol.ts, confirme os
program IDs do Pump.fun e PumpSwap na documentação/IDL oficial e cite a fonte. Ao final,
rode pnpm check e marque os itens no ROADMAP.
```

**2. Fase 1**
```
Execute a Fase 1 do ROADMAP (ingestão gRPC + recorder). Use o IDL oficial do Pump.fun e do
PumpSwap para o parser. Crie um modo de debug que imprime os primeiros 20 eventos parseados
para eu conferir no Solscan. Depois configure o systemd unit em infra/ para
pnpm bot --mode=record.
```

**3. Conferência (depois de 24 h gravando)**
```
Rode o script de sanidade da Fase 1 sobre as últimas 24 h e me mostre: eventos/minuto,
tokens criados por hora, maiores gaps, % de trades com parse falho. Compare com uma fonte
pública e diga se os números fazem sentido.
```

**4. Fase 2, 3, ...** → `Execute a Fase N do ROADMAP.` e revise os critérios de aceite.

## Regras de ouro

- Nunca pule o paper trading.
- Nunca aumente os limites de `hard-limits.ts` por impulso depois de uma sequência boa ou ruim.
- Toda mudança de estratégia vira nova versão em `config/` e passa pelo backtest antes.
