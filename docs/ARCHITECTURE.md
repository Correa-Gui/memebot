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
`core` ← `curve-math` ← `state` ← `features` ← `strategy` ← `risk` ← `execution` ← `positions` ← `apps/*`.
(`positions` depende de `execution` só pelo tipo `Fill`: a carteira simulada fica no executor; a visão
da estratégia — custo, degraus de TP, máxima do trailing — fica em `positions`.)
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

// curve-math (Fase 2, 2026-10-01): funções puras, bigint exato, sem I/O. Taxas em bps vêm de
// `protocol_config` (lidas pelo chamador), nunca hardcoded aqui. Fórmula e arredondamento
// (ceiling em toda divisão) confirmados byte a byte contra 120+ trades reais da bonding curve —
// ver packages/curve-math/test/fixtures/golden/curve.json.
export interface CurveReserves { virtualQuote: bigint; virtualToken: TokenAmount }
export interface CurveFeeBps { protocolFeeBps: bigint; creatorFeeBps: bigint }
export function bondingCurveBuy(reservesBefore: CurveReserves, quoteAmountIn: Lamports, fees: CurveFeeBps):
  { tokenOut: TokenAmount; protocolFee: Lamports; creatorFee: Lamports; totalQuoteCost: Lamports; reservesAfter: CurveReserves };
export function bondingCurveSell(reservesBefore: CurveReserves, tokenAmountIn: TokenAmount, fees: CurveFeeBps):
  { quoteOutGross: Lamports; protocolFee: Lamports; creatorFee: Lamports; netQuoteOut: Lamports; reservesAfter: CurveReserves };
export function deriveRealReserves(virtual: CurveReserves, initial: { initialVirtualQuote: bigint; initialVirtualToken: TokenAmount; initialRealToken: TokenAmount }):
  { realQuote: bigint; realToken: TokenAmount };
// Parâmetros iniciais da curva a partir do `config_json` da conta `Global` (protocol_config):
// campos u64 `initial_virtual_token_reserves`, `initial_virtual_sol_reserves`,
// `initial_real_token_reserves` do tipo `Global` no IDL pump.json. Validado com zod.
export function parseCurveInitialParams(globalConfigJson: unknown): CurveInitialParams;
export interface FeeBps { lpFeeBps: bigint; protocolFeeBps: bigint; creatorFeeBps: bigint }
export function lookupFeeTier(tiers: readonly { marketCapLamportsThreshold: bigint; fees: FeeBps }[], marketCapLamports: bigint): FeeBps;

// LIMITAÇÃO CONHECIDA (documentada, não escondida): `pumpSwapBuy`/`pumpSwapSell` (mesma
// assinatura, em `packages/curve-math/src/pumpswap.ts`) têm o cálculo de taxas confirmado exato
// contra dados reais, mas o `baseOut`/reservas pós-swap usa constant product "de manual" sobre
// `pool_base_token_reserves`/`pool_quote_token_reserves` e NÃO reproduziu os valores reais
// gravados (erro ~10%, não é arredondamento) — provável uso de reservas virtuais do PumpSwap não
// expostas nesses dois campos do evento (análogo ao par virtual/real da bonding curve). Exigiria
// ler a conta `Pool` on-chain; ficou para quando isso entrar em pauta (Fase 3+). Os testes golden
// do PumpSwap por isso só exigem exatidão no bookkeeping de taxas (bruto = líquido + lp + protocol
// + creator), não no valor de saída do swap.

// state (Fase 2, 2026-10-01): estado em memória por token, só a partir dos eventos observados
// (ver §8 "Holders e concentração são aproximações" — vale integralmente aqui). Função pura
// `(state, event) => newState`, sem Clock/IO; quem chama alimenta os eventos em ordem cronológica
// (ingest ao vivo ou replay ordenado) — windows.ts supõe isso para as janelas de tempo.
// `createdAtSlot` foi adicionado na Fase 3/parte A (packages/features): o filtro "% comprado no
// mesmo slot da criação" precisa do slot exato de `token_created`, não só `createdAtMs` (dois
// eventos podem compartilhar o mesmo ms e terem slots diferentes).
export interface TokenState {
  mint: string; quoteMint: string | null; creator: string | null; tokenTotalSupply: TokenAmount | null;
  createdAtMs: number | null; createdAtSlot: bigint | null; bondingCurve: string | null; venue: 'curve' | 'pumpswap' | 'unknown';
  curveCompleted: boolean;               // true após `curve_completed` (Fase 3/parte B): curva encerrada mesmo com venue 'curve'
  curveReserves: { virtualQuote: bigint; virtualToken: TokenAmount; realQuote: bigint; realToken: TokenAmount } | null;
  pumpSwapReserves: { pool: string; base: TokenAmount; quote: bigint } | null;
  /** Saldo por carteira inferido só de trades observados nos dois programas (nunca negativo). */
  holderBalances: ReadonlyMap<string, TokenAmount>;
  firstBuyers: readonly string[];        // carteiras únicas que compraram, na ordem de chegada
  creatorWallets: ReadonlySet<string>;    // pelo menos o `creator` de token_created
  trades: readonly { ts: number; slot: bigint; venue: 'curve' | 'pumpswap'; side: 'buy' | 'sell';
    trader: string; quoteAmount: Lamports; tokenAmount: TokenAmount;
    // reservas virtuais da curva logo após o trade, do próprio TradeEvent (null no PumpSwap);
    // preço marginal = virtualQuoteAfter / virtualTokenAfter
    virtualQuoteAfter: bigint | null; virtualTokenAfter: TokenAmount | null }[];
}
export interface MarketState { tokens: ReadonlyMap<string, TokenState>; poolToMint: ReadonlyMap<string, string> }
export function applyEvent(state: MarketState, event: PumpEvent): MarketState;
// seletores de janela (puros, recebem nowMs explícito — nunca Date.now()):
export interface WindowStats { buyVolumeQuote: Lamports; sellVolumeQuote: Lamports; buyCount: number; sellCount: number;
  uniqueBuyers: number; uniqueSellers: number; largestSellToken: TokenAmount }
export function computeWindowStats(token: TokenState, nowMs: number, windowMs: number): WindowStats;
export function buySellRatio(stats: WindowStats): number | null;
export function tokenAgeMs(token: TokenState, nowMs: number): number | null;
export function topHolderConcentration(token: TokenState, topN: number): number | null;

// features (Fase 3/parte A): funções puras sobre TokenState/MarketState + nowMs explícito.
// Cada uma documenta fórmula, janela e se é aproximação em packages/features/src/index.ts.
// `curveProgress` recebe os parâmetros da conta Global; `priceAboveMean120s` usa só preço marginal
// (virtualQuoteAfter / virtualTokenAfter de cada trade da janela), nunca preço médio de execução.
export function curveProgress(token: TokenState, curveParams: CurveInitialParams): number;  // [0, 1]
export function priceAboveMean120s(token: TokenState, nowMs: number): boolean | null;

// estratégia (packages/strategy): função pura, decide SÓ entrada/rejeição.
// Saídas NÃO são decididas aqui: vêm de packages/positions (TP escalonado, trailing, stop, time
// stop, emergência — docs/STRATEGY.md §6), que acompanha as posições abertas evento a evento.
// Sizing e aprovação de risco vêm de packages/risk, depois do `enter`.
export type Decision =
  | { outcome: 'enter'; mint: string; reason: 'momentum_trigger'; features: Record<string, number> }
  | { outcome: 'reject'; mint: string; reason: string };
// `reason` de um `reject` é sempre a chave do filtro de config/strategy.v0.yaml que reprovou
// (ex.: 'maxTop10PctSupply', 'minUniqueHolders') ou um motivo estrutural/universo
// ('mint_not_found', 'insufficient_data', 'venue_not_allowed', 'allowedQuoteMints') — nunca texto
// genérico; o relatório de paper trading conta quantos tokens cada filtro barrou.
// Ordem: universo (§2) → filtros duros (§3) → gatilho (§4); para na primeira falha.
// `features` do `enter` é o snapshot gravado em `decisions` junto com o decision_id.
export function evaluate(
  marketState: MarketState, mint: string, clock: Clock,
  config: StrategyV0Config,          // config/strategy.v0.yaml validado com zod (loadStrategyConfig)
  curveParams: CurveInitialParams,   // conta Global, via parseCurveInitialParams
): Decision[];
// `decisionId`, `sizeLamports`, `maxSlippageBps` e as ordens de saída NÃO fazem parte do
// Decision da strategy: são atribuídos por risk/positions/executor (Fase 3/parte B).

// risco (packages/risk, Fase 3/parte B). Tudo puro; o único I/O é o adaptador isStopFilePresent.
export const HARD_LIMITS = { maxPositionLamports: 50_000_000n, maxOpenPositions: 3, maxDailyLossLamports: 200_000_000n,
  maxHotWalletLamports: 1_000_000_000n, maxSlippageBps: 1500, maxPriorityFeeLamports: 2_000_000n, maxJitoTipLamports: 2_000_000n } as const;
// Limites efetivos = YAML (+ overrides do código), cada um <= hard limit; acima → HardLimitExceededError
// (nunca clamp silencioso). sizeLamports = sizing.sizeSol (teto do SOL pago à curva COM as taxas da curva).
export function buildEffectiveRiskLimits(config: StrategyV0Config, overrides?: RiskOverrides): EffectiveRiskLimits;
// Sizing: tamanho fixo; impacto = preço médio de execução sem taxas / preço marginal antes − 1;
// se > maxOwnPriceImpactPct, busca binária do maior tamanho que cabe; abaixo de minSizeFraction (0,5) × tamanho → rejeita.
export function computeEntrySize(reserves: CurveReserves, limits: EffectiveRiskLimits, fees: CurveFeeBps): EntrySizeResult;
export interface RiskState { dayIndexUtc: number; dailyRealizedPnlLamports: Lamports; consecutiveTxFailures: number; decisionSeq: number }
// Kill switch (RISK §3): stop_file | daily_loss | consecutive_failures (5) | stream_stale (30 s; nenhum evento = parado)
// | balance_divergence (> 1%; só live — no paper `balance: null` desliga o gatilho). Bloqueia só NOVAS entradas.
export function evaluateKillSwitch(inputs: KillSwitchInputs, maxDailyLossLamports: Lamports, params?: KillSwitchParams): KillSwitchStatus;
// Aprovação: kill switch → posição já aberta → maxOpenPositions → curva disponível → sizing → maxHotWalletLamports.
// decisionId determinístico `<runId>:<mint>:<nowMs>:<seq>` (aprovado ou não).
export function approveEntry(input: ApproveEntryInput, clock: Clock): { result: ApprovalResult; riskState: RiskState };
export type ApprovalResult =
  | { approved: true; decisionId: string; mint: string; sizeLamports: Lamports; quoteAmountIn: Lamports;
      maxSlippageBps: number; priceImpactPct: number; sizeReduced: boolean }
  | { approved: false; decisionId: string; mint: string; reason: string }; // 'kill_switch:<gatilho>', 'maxOpenPositions', ...

// execução (packages/execution). Fill espelha a tabela `fills` + migração 006.
export interface Fill {
  runId: string; ts: number; decisionId: string; mint: string; side: 'buy' | 'sell';
  solIn: Lamports;        // compra: quoteAmountIn + taxas da curva
  solOut: Lamports;       // venda: líquido das taxas da curva
  tokenDelta: TokenAmount; protocolFee: Lamports; creatorFee: Lamports; priorityFee: Lamports; jitoTip: Lamports;
  rent: Lamports;         // cobrado na 1ª compra do mint
  rentRefund: Lamports;   // devolvido na venda que zera a posição
  expectedPriceSol: number; realizedPriceSol: number; // lamports por unidade mínima de token, líquidos das taxas da curva
  slippageBps: number; landedSlot: bigint | null /* null no paper */; status: 'filled' | 'failed' | 'expired'; error: string | null;
  venueUnverified: boolean;                            // fechado no último preço da curva por graduação
  costEstimateSource: 'tx_costs_median' | 'fallback'; costCappedByHardLimit: boolean;
}
// Custos: mediana de tx_costs × 1,5 (tip: só amostras com tip > 0); < PAPER_COST_MIN_SAMPLES → fallback configurável.
export function estimateTxCosts(samples: readonly TxCostSample[], params: TxCostEstimateParams): TxCostEstimate;
// Paper executor: máquina de estados pura (ver §5). Sem timers; o orquestrador chama:
export function submitOrder(s: PaperExecutorState, p: PaperExecutorParams, order: BuyOrder | SellOrder, market: MarketState, nowMs: number): PaperExecutorState;
export function settleBeforeEvent(s, p, marketBeforeEvent: MarketState, eventTs: number): { state; fills: Fill[] }; // vencimento < eventTs
export function settleOnTick(s, p, market: MarketState, nowMs: number): { state; fills: Fill[] };                    // vencimento <= nowMs
// Erros tipados: PumpSwapSimulationNotValidatedError (qualquer simulação de swap no PumpSwap — compra fora da
// curva, simulatePumpSwapSwap), HardLimitViolationError (defesa em profundidade), InvalidOrderError.
// O executor do live (Fase 6) produzirá o mesmo Fill; a interface assíncrona dele fica para quando ele existir.

// posições (packages/positions, STRATEGY §6). Puro.
export function openPosition(buyFill: Fill): Position;
export function evaluateExits(position: Position, token: TokenState, nowMs: number, exits: StrategyV0Config['exits'], ctx: ExitContext):
  { position: Position; orders: { mint: string; fraction: number /* da quantidade atual */; reason: ExitReason; takeProfitStep: number | null }[] };
// PnL líquido = (realizadoLíquido + L − custoEntrada) / custoEntrada, com
//   custoEntrada = solIn + priority + tip + rent da compra;
//   L = netQuoteOut(bondingCurveSell(reservas atuais, quantidade)) − priority − tip estimados da saída + rent (volta ao fechar).
// Precedência: graduated > emergency_creator_sell > emergency_large_sell > stop_loss > trailing_stop > time_stop > take_profit_N.
// Trailing só depois do TP1, sobre L do restante (a máxima recomeça a cada venda parcial). sellFraction do TP = fração da quantidade INICIAL.
export function applyExitFill(position: Position, sellFill: Fill): { position: Position | null; realizedPnlDelta: Lamports };

// sinais
export interface RiskModel { score(features: Record<string, number>): number } // 0..1, prob. de rug
export interface NarrativeClassifier {
  classify(input: { post: SocialEvent; token: { name: string; symbol: string; description?: string; imageUrl?: string } })
    : Promise<{ matchesNarrative: number; isLikelyOriginal: number; looksScam: number; confidence: number; latencyMs: number }>;
}
```

## 5. Paper executor (a peça que decide se a simulação vale algo)

Deve ser **pessimista por padrão** (implementado em `packages/execution/src/paper.ts`, Fase 3/parte B):
1. **Latência simulada:** a ordem é preenchida no estado da curva `N` ms depois da decisão (`PAPER_LATENCY_MS`, padrão 800 ms) — usa-se o estado após todos os eventos com `ts ≤ decisão + N` (o orquestrador chama `settleBeforeEvent` antes de aplicar cada evento e `settleOnTick` em ticks sem evento). A nossa própria ordem **não** é injetada no `MarketState` (pessimista: a venda posterior não se beneficia do preço que a nossa compra empurrou).
2. **Preço exato** via `curve-math` sobre as reservas daquele instante, incluindo taxas lidas da configuração on-chain (passadas como parâmetro).
3. **Custos:** priority fee e tip de Jito = mediana de `tx_costs` × 1,5 (tip só sobre amostras com tip > 0, porque o live vai usar Jito). Com menos de `PAPER_COST_MIN_SAMPLES` (30) amostras usa `PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS` / `PAPER_FALLBACK_JITO_TIP_LAMPORTS` (500 000 cada) e o fill sai com `cost_estimate_source = 'fallback'`. Nunca acima de `maxPriorityFeeLamports`/`maxJitoTipLamports`: se passar, usa o limite e marca `cost_capped`. Rent da conta de token é injetado (o adaptador lê `getMinimumBalanceForRentExemption`), cobrado na 1ª compra do mint e devolvido (`rent_refund`) só na venda que zera a posição. A taxa base por assinatura (fee não-priority) ainda **não** é cobrada (ver relatório da parte B).
4. **Falhas:** taxa configurável (`PAPER_FAIL_RATE`, 10%) sorteada com PRNG semeado (mulberry32; seed derivada do run) — um sorteio por ordem, sempre, para o replay ser estável. `failed` e `expired` (slippage acima do `maxSlippageBps` aprovado) pagam a priority fee e **não** pagam tip (o tip do Jito reverte com o bundle); posição intacta. Compra pendente cuja curva completou durante a latência → `failed` (`curve_unavailable_at_fill`).
5. Registrar `expectedPrice` × `realizedPrice` em todo fill para depois calibrar contra o live.
6. **PumpSwap:** nunca simulado (`PumpSwapSimulationNotValidatedError`). Graduação com posição aberta → vende tudo no último preço da curva, `venue_unverified = 1`, sem sorteio de falha/slippage.
7. **Hard limits** conferidos de novo no executor (tamanho, slippage, nº de posições, custos): violação = erro, nunca fill.

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
| `fills` | fills simulados/reais com custos detalhados (+ `venue_unverified`, `cost_estimate_source`, `cost_capped`, `rent_refund` — migração 006, ainda não aplicada) | `(run_id, ts)` |
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
- **Holders e concentração são aproximações.** `logsSubscribe` só entrega eventos dos programas monitorados
  (Pump.fun/PumpSwap); saldos por carteira em `packages/state` são **inferidos só pelos trades observados**
  (compra/venda via esses programas). Transferências diretas de token (`spl-token transfer`, outra DEX, outro
  programa) não aparecem no stream e não atualizam o saldo inferido. Isso significa que `% do supply no top 10`,
  `% comprado no mesmo slot` e holders únicos (`docs/STRATEGY.md` §3) podem divergir do saldo real on-chain,
  especialmente para tokens com transferências fora da curva/pool. Ficar ciente disso ao calibrar os filtros
  no backtest; corrigir via indexador de contas de token é um item do backlog, não da v0.
