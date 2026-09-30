# Arquitetura

## 1. Visão geral

```
                 ┌──────────────── TEMPO REAL ────────────────┐
 WebSocket (logs)│                                             │
 ───────────────►│ ingest ──► state ──► features ──► strategy  │
                 │   │                     ▲   ▲        │      │
 X / social ────►│ social ─► narrative ────┘   │        ▼      │
                 │            (Jev)             │      risk     │
                 │ wallets (smart money) ───────┘        │      │
                 │                                       ▼      │
                 │                      execution: paper | live │
                 │                                       │      │
                 │                          positions / exits   │
                 └───────┬──────────────────────────────┬──────┘
                         │ todos os eventos             │ decisões, fills
                         ▼                              ▼
                   recorder ──────────► ClickHouse ◄──── ledger
                                          │
                 ┌──────── OFFLINE ───────┴────────────────────┐
                 │ backtest (replay na MESMA lógica)            │
                 │ research/ (Python): análise, treino, ONNX ───┼──► signals/model.onnx
                 └──────────────────────────────────────────────┘
```

Princípio central: **um único caminho de decisão** para replay, paper e live. Só trocam a fonte de eventos (`EventSource`), o relógio (`Clock`) e o executor (`Executor`).

## 2. Modos

| Modo | EventSource | Clock | Executor | Grava |
|---|---|---|---|---|
| `record` | WebSocket ao vivo | sistema | nenhum | eventos |
| `paper` | WebSocket ao vivo | sistema | `PaperExecutor` | eventos, decisões, fills simulados |
| `live` | WebSocket ao vivo | sistema | `LiveExecutor` | eventos, decisões, fills reais |
| `replay` | ClickHouse | simulado (tempo do evento) | `PaperExecutor` | decisões, fills simulados |

## 3. Estrutura do repositório

```
memebot/
├── CLAUDE.md
├── .env.example
├── docker-compose.yml
├── config/
│   ├── protocol.ts            # program IDs, endereços (com fonte e data)
│   └── strategy.v0.yaml       # parâmetros da estratégia (versionados)
├── packages/
│   ├── core/                  # tipos compartilhados, Clock, config (zod), logger com redação
│   ├── curve-math/            # matemática exata bonding curve + PumpSwap, taxas
│   ├── ingest/                # logsSubscribe (WebSocket) -> eventos normalizados; IDLs oficiais em src/idl/
│   ├── recorder/              # grava eventos no ClickHouse em lote (flush 1 s / 1.000 linhas)
│   ├── state/                 # estado em memória por token (curva, holders, fluxo)
│   ├── features/              # cálculo de features a partir do estado
│   ├── wallets/               # base de carteiras e scores de smart money
│   ├── social/                # fontes sociais (X etc.) -> eventos de narrativa
│   ├── signals/               # modelo ONNX de risco + NarrativeClassifier (Jev)
│   ├── strategy/              # regras de entrada/saída (funções puras)
│   ├── risk/                  # limites, sizing, kill switch, hard-limits.ts
│   ├── execution/             # Executor: paper.ts, live.ts (Jito + RPC), cleanup de contas
│   ├── positions/             # posições abertas, gatilhos de saída
│   └── monitor/               # alertas Telegram, métricas, health check
├── apps/
│   ├── bot/                   # entrypoint: --mode=record|paper|live
│   ├── backtest/              # replay de intervalos gravados
│   └── report/                # relatórios de execuções
├── research/                  # Python: notebooks, treino, export ONNX
├── infra/                     # systemd units, scripts de deploy, hardening
└── docs/
```

Dependências entre pacotes (só nesta direção):
`core` ← `curve-math` ← `state` ← `features` ← `strategy` ← `risk` ← `execution` ← `apps/*`.
`ingest`, `recorder`, `social`, `wallets`, `signals`, `monitor` dependem só de `core` (e `curve-math` quando preciso).

## 4. Interfaces principais (contratos)

```ts
// core
export type Lamports = bigint;          // 1 SOL = 1_000_000_000n
export type TokenAmount = bigint;       // unidades mínimas do token
export interface Clock { nowMs(): number; slot(): bigint }

// eventos normalizados (ingest -> todo o resto). Definição completa: packages/core/src/events.ts
// Base de todo evento on-chain: slot, ts (timestamp do próprio evento, ms), sig, eventIndex,
// receivedAtMs + recvSeq (ordem de chegada), rawB64 (bytes do evento, re-decodificáveis).
export type PumpEvent =
  | { kind: 'token_created'; mint; creator; name; symbol; uri; bondingCurve; quoteMint; tokenTotalSupply }
  | { kind: 'trade'; venue: 'curve'; mint; trader; side; quoteMint; quoteAmount; tokenAmount;
      virtualQuoteReserves; virtualTokenReserves; realQuoteReserves; realTokenReserves; protocolFee; creatorFee; ixName }
  | { kind: 'trade'; venue: 'pumpswap'; pool; mint /* base da pool */; quoteMint; trader; side /* do base */;
      tokenAmount; quoteAmount; userQuoteAmount; poolBaseReserves; poolQuoteReserves; lpFee; protocolFee; creatorFee; ixName }
  | { kind: 'curve_completed'; mint; bondingCurve }
  | { kind: 'pool_created'; pool; mint; quoteMint; creator }
  | { kind: 'tx_cost'; slot; sig; feeLamports; priorityFee; jitoTip: Lamports | null; computeUnits; numSignatures };

// Mudanças em relação à v0 deste contrato (Fase 1, 2026-09-29), motivadas pelo IDL oficial e por dados reais:
// - `solAmount`/`virtualSolReserves` → `quoteAmount`/`virtualQuoteReserves` + `quoteMint`: a curva agora pode
//   ser cotada em outro mint. SOL = quote_mint `1111…1111` (curva) ou WSOL (PumpSwap); ver SOL_QUOTE_MINTS.
// - PumpSwap: `mint`/`quoteMint` são base/quote da pool como estão on-chain (há pools com base = WSOL).
//   Semântica exata dos valores (com/sem taxa) fica para a Fase 2, com fixtures golden; `rawB64` preserva tudo.
// - `txIndexInSlot`, `priorityFee`, `jitoTip` saíram do trade: o logsSubscribe não os fornece (ver §8).
//   Custos viram eventos `tx_cost` amostrados; ordem dentro do slot = ordem de chegada.

export type SocialEvent =
  { kind: 'social_post'; ts: number; source: 'x' | 'telegram' | 'other'; author: string;
    text: string; mediaUrls: string[]; url: string };

export interface EventSource {
  start(onEvent: (e: PumpEvent | SocialEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

// estratégia: função pura
export type Decision =
  | { type: 'enter'; decisionId: string; mint: string; sizeLamports: Lamports; maxSlippageBps: number;
      reason: string; features: Record<string, number> }
  | { type: 'exit'; decisionId: string; mint: string; fraction: number; reason: string }
  | { type: 'reject'; decisionId: string; mint: string; reason: string };

export interface Strategy {
  onEvent(state: MarketState, portfolio: Portfolio, ev: PumpEvent | SocialEvent, clock: Clock): Decision[];
}

// risco
export interface RiskManager {
  approve(d: Decision, portfolio: Portfolio): { ok: true } | { ok: false; reason: string };
}

// execução
export interface Fill {
  decisionId: string; mint: string; side: 'buy' | 'sell';
  solIn: Lamports; solOut: Lamports; tokenDelta: TokenAmount;
  protocolFee: Lamports; creatorFee: Lamports; priorityFee: Lamports; jitoTip: Lamports; rent: Lamports;
  expectedPriceSol: number; realizedPriceSol: number; slippageBps: number;
  landedSlot?: bigint; status: 'filled' | 'failed' | 'expired'; error?: string;
}
export interface Executor {
  buy(d: Extract<Decision, { type: 'enter' }>): Promise<Fill>;
  sell(mint: string, fraction: number, decisionId: string): Promise<Fill>;
}

// sinais
export interface RiskModel { score(features: Record<string, number>): number } // 0..1, prob. de rug
export interface NarrativeClassifier {
  classify(input: { post: SocialEvent; token: { name: string; symbol: string; description?: string; imageUrl?: string } })
    : Promise<{ matchesNarrative: number; isLikelyOriginal: number; looksScam: number; confidence: number; latencyMs: number }>;
}
```

## 5. Paper executor (a peça que decide se a simulação vale algo)

Deve ser **pessimista por padrão**:
1. **Latência simulada:** a ordem é preenchida no estado da curva `N` ms depois da decisão (config `paper.latencyMs`, padrão 800 ms) — usa-se o estado após todos os trades gravados até esse instante.
2. **Preço exato** via `curve-math` sobre as reservas daquele instante, incluindo taxas lidas da configuração on-chain.
3. **Custos:** priority fee e tip de Jito com valores configurados (padrão: mediana observada nos últimos N slots × 1,5), rent da conta de token (recuperado só se a posição for fechada e a conta limpa).
4. **Falhas:** taxa configurável de transações que não entram (padrão 10%) e expiração se o slippage passar do limite.
5. Registrar `expectedPrice` × `realizedPrice` em todo fill para depois calibrar contra o live.

## 6. Modelo de dados (ClickHouse)

Migrações em `infra/clickhouse/migrations/` (`pnpm migrate`; cada arquivo roda uma vez, com checksum —
nunca edite uma migração aplicada, crie outra). Toda linha de evento tem `raw_b64`, `received_at`, `recv_seq`.

| Tabela | Conteúdo | Chave de ordenação |
|---|---|---|
| `events_trade` | todos os trades (curva e PumpSwap) | `(mint, slot, sig, event_index)` |
| `v_trades` (view) | `events_trade` com `mint` preenchido via `pools` quando a pool não estava resolvida na gravação — **ler desta** | — |
| `events_token` | criações de token | `(mint)` |
| `token_metadata` | JSON da `uri` (descrição, imagem, links sociais) ou erro da busca | `(mint, fetched_at)` |
| `events_lifecycle` | curve_completed, pool_created | `(mint, slot)` |
| `pools` | pool → base/quote (de CreatePoolEvent ou da conta Pool) | `(pool)` |
| `tx_costs` | priority fee / tip Jito amostrados | `(slot, sig)` |
| `ingest_gaps` | reconexões, logs truncados, erros de parse, pools não resolvidas | `(detected_at)` |
| `events_social` | posts monitorados | `(ts, author)` |
| `protocol_config` | snapshots de Global, GlobalConfig e FeeConfig (taxas por faixa) lidos on-chain | `(ts)` |
| `runs` | cada execução (modo, config hash, commit git) | `(run_id)` |
| `decisions` | decisões com snapshot de features | `(run_id, ts)` |
| `fills` | fills simulados/reais com custos detalhados | `(run_id, ts)` |
| `signals_log` | respostas do modelo de risco e do Jev | `(run_id, ts)` |
| `wallet_stats` | métricas por carteira (recalculadas offline) | `(wallet)` |

Retenção: eventos brutos sem TTL (são o ativo do projeto). Faça backup semanal em Parquet para fora da VPS.

## 7. Orçamento de latência (estratégia B)

| Etapa | Alvo |
|---|---|
| WebSocket → evento normalizado | < 50 ms (fora o atraso do RPC até `confirmed`) |
| evento → features → decisão | < 20 ms (sem Jev) |
| Jev (quando usado) | 70–500 ms, assíncrono; decisão pode aguardar até `jev.timeoutMs` |
| decisão → transação enviada (live) | < 100 ms |

Nada disso é competitivo para slot zero, e não precisa ser.

## 8. Deploy

- VPS Linux, idealmente em data center próximo aos validadores (EUA leste ou Alemanha). Testar latência para `ny.mainnet.block-engine.jito.wtf` / `frankfurt.mainnet.block-engine.jito.wtf`.
- ClickHouse via `docker compose`. Bot via `systemd` com `Restart=always`, usuário sem privilégios.
- **Fonte de dados padrão: WebSocket** (`logsSubscribe`) de um RPC pago de entrada na mesma região da VPS. Suficiente para a estratégia B (atraso típico de 150–300 ms a mais que gRPC, irrelevante para entrada após 60 s).
- **Migrar para Yellowstone gRPC só se** as métricas mostrarem: lacunas frequentes (`ingest_gaps`), mensagens perdidas em picos, ou atraso médio > 1 s. Como tudo passa por `EventSource`, a troca não afeta o resto do código.

### O que o WebSocket (`logsSubscribe`) entrega e o que não entrega (medido em 2026-09-29)
- Entrega: assinatura, erro e linhas de log; os eventos Anchor saem das linhas `Program data:` (confirmado em
  transações reais dos dois programas, que também emitem os mesmos eventos por self-CPI).
- **Não entrega** índice da transação no bloco, fee nem tip. Buscar isso por bloco custa ~90 KB (`getBlock`
  só assinaturas) ou ~1,9 MB (`getBlock` com contas) por slot — até ~400 GB/dia. Decisão: custos por
  **amostragem** (`getTransaction`, `INGEST_COST_SAMPLES_PER_SEC`, padrão 2/s) em `tx_costs`; ordem dentro do
  slot = ordem de chegada (`received_at`, `recv_seq`). A ordem exata é um motivo concreto para o gRPC depois.
- A mainnet tem transações **versão 1**: toda chamada que busca transação usa `maxSupportedTransactionVersion: 1`.
- Cuidados implementados no parser: `Program data:` só conta se o topo da pilha de invocação for Pump/PumpSwap
  (outro programa pode logar bytes que imitam um evento); transação com erro é descartada inteira (~65% das
  notificações observadas); `Log truncated` vira gap; tx que menciona os dois programas chega duas vezes e é
  deduplicada por assinatura.
- Pools do PumpSwap criadas antes da gravação são resolvidas lendo a conta `Pool` (dono conferido), com cache
  negativo e backoff exponencial em falha; enquanto não resolve, o trade é gravado com `mint = ''` e a view
  `v_trades` completa depois.
- Metadados (`uri`) são entrada hostil (quem cria o token escolhe a URL): só https, IP checado contra faixas
  privadas no próprio lookup do socket (bloqueia SSRF para o ClickHouse local e DNS rebinding), sem redirect,
  máx. 256 KB, timeout.
- Healthcheck: se nenhum evento chegar em 30 s, alerta no Telegram e reconecta.
