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
| `replay` | ClickHouse (`ClickHouseReplaySource`) | simulado (`SimulatedClock`, ts do evento + ticks de 1 s) | `PaperExecutor` (mesmo `PaperEngine` do paper) | decisões, fills simulados (opcional, `--write`) — ver §9 |

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
│   └── monitor/               # alertas Telegram (entrada/saída/resumo por hora)
├── apps/
│   ├── bot/                   # entrypoint: --mode=record|paper|live; src/paper/ (orquestrador), src/report.ts (pnpm report)
│   ├── backtest/              # (não criado: o replay da Fase 4 vive em apps/bot/src/replay/, ver §9)
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
      tokenAmount; quoteAmount; userQuoteAmount; poolBaseReserves; poolQuoteReserves; lpFee; protocolFee; creatorFee; ixName;
      swapDetails?: PumpSwapSwapDetails }
  | { kind: 'curve_completed'; mint; bondingCurve }
  | { kind: 'pool_created'; pool; mint; quoteMint; creator }
  | { kind: 'tx_cost'; slot; sig; feeLamports; priorityFee; jitoTip: Lamports | null; computeUnits; numSignatures };

// Mudanças em relação à v0 deste contrato (Fase 1, 2026-09-29), motivadas pelo IDL oficial e por dados reais:
// - `solAmount`/`virtualSolReserves` → `quoteAmount`/`virtualQuoteReserves` + `quoteMint`: a curva agora pode
//   ser cotada em outro mint. SOL = quote_mint `1111…1111` (curva) ou WSOL (PumpSwap); ver SOL_QUOTE_MINTS.
// - PumpSwap: `mint`/`quoteMint` são base/quote da pool como estão on-chain (há pools com base = WSOL).
//   Semântica exata dos valores (com/sem taxa) fica para a Fase 2, com fixtures golden; `rawB64` preserva tudo.
// - PumpSwap (2026-10-02): `poolBaseReserves`/`poolQuoteReserves` são o estado ANTES do swap (= saldos das
//   vaults antes da tx, confirmado via RPC). `swapDetails` traz o que a matemática exata exige
//   (packages/curve-math/src/pumpswap.ts): `{ instruction: 'buy' | 'buy_exact_quote_in' | 'sell';
//   virtualQuoteReserves (i128); lpFeeBps; protocolFeeBps; creatorFeeBps; cashbackFeeBps; cashbackFee;
//   buybackFeeBps; buybackFee; holderRewardsBps; holderRewards; baseSupply }`. O normalize SEMPRE preenche
//   (exceto `ix_name` desconhecido num BuyEvent: trade gravado sem detalhes, não chutamos a variante); é
//   opcional no tipo porque eventos reconstruídos de `events_trade` só o têm via `pumpswap_trade_extra`
//   (§6). Significado dos campos por instrução: em `buy` `quoteAmount` = líquido e `userQuoteAmount` = total
//   pago; em `buy_exact_quote_in` `quoteAmount` = gastável e `userQuoteAmount` = líquido; venda: bruto/líquido.
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

// PumpSwap (exato desde 2026-10-02, 0 de diferença em 99 fixtures reais + 3 tx conferidas via RPC;
// regras e fontes no cabeçalho de packages/curve-math/src/pumpswap.ts). O constant product usa o quote
// EFETIVO `quote + virtualQuote` (`Pool.virtual_quote_reserves`, i128, também presente em
// BuyEvent/SellEvent); `base`/`quote` = saldos das vaults = reservas do evento (estado ANTES do swap).
export interface PumpSwapReserves { base: TokenAmount; quote: bigint; virtualQuote: bigint }
export interface PumpSwapFeeBps { lpFeeBps: bigint; protocolFeeBps: bigint; creatorFeeBps: bigint; cashbackFeeBps: bigint }
// PumpSwapFees = { lpFee; protocolFee; creatorFee; cashbackFee } (ceil por componente)
export function pumpSwapBuyExactBaseOut(r: PumpSwapReserves, baseOut: TokenAmount, fees: PumpSwapFeeBps):   // instrução `buy`
  PumpSwapFees & { baseOut; netQuoteIn; totalQuoteCost; reservesAfter: PumpSwapReserves };
export function pumpSwapBuyExactQuoteIn(r: PumpSwapReserves, spendableQuoteIn: Lamports, fees: PumpSwapFeeBps): // `buy_exact_quote_in`
  PumpSwapFees & { baseOut; netQuoteIn; totalQuoteCost; reservesAfter: PumpSwapReserves };
export function pumpSwapSell(r: PumpSwapReserves, baseIn: TokenAmount, fees: PumpSwapFeeBps):
  PumpSwapFees & { quoteOutGross; netQuoteOut; reservesAfter: PumpSwapReserves };
export function marketCapLamports(r: PumpSwapReserves, tokenTotalSupply: TokenAmount): bigint; // Qe·supply/B, para o tier
// Dados ligados (2026-10-02): normalize → `swapDetails`; estado → `pumpSwapReserves` (DEPOIS do trade, com
// `virtualQuote`/`feeBps`/`baseSupply`); persistência → `pumpswap_trade_extra` (§6). O paper executor segue
// recusando simular PumpSwap (PumpSwapSimulationNotValidatedError) enquanto o universo for só curva.

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
  // PumpSwap: estado DEPOIS do último trade (o evento traz o ANTES; aplica-se o delta do próprio trade:
  // venda base+in / quote−(bruto−lp); compra base−out / quote+(líquido+lp), líquido = min(quoteAmount,
  // userQuoteAmount)). virtualQuote/feeBps/baseSupply = null se o trade veio sem swapDetails → não precificar.
  // `pumpSwapReservesAfter(event)` exportada; validada nas 99 fixtures golden (= reservas do próximo evento).
  pumpSwapReserves: { pool: string; base: TokenAmount; quote: bigint; virtualQuote: bigint | null;
    feeBps: { lpFeeBps; protocolFeeBps; creatorFeeBps; cashbackFeeBps } | null; baseSupply: TokenAmount | null; lastSlot: bigint } | null;
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

// execução (packages/execution). Fill espelha a tabela `fills` + migração 006 (006_fills_paper_columns.sql).
export interface Fill {
  runId: string; ts: number; decisionId: string; mint: string; side: 'buy' | 'sell';
  solIn: Lamports;        // compra: quoteAmountIn + taxas da curva
  solOut: Lamports;       // venda: líquido das taxas da curva
  tokenDelta: TokenAmount; protocolFee: Lamports; creatorFee: Lamports; priorityFee: Lamports; jitoTip: Lamports;
  rent: Lamports;         // cobrado na 1ª compra do mint
  rentRefund: Lamports;   // devolvido na venda que zera a posição
  baseFee: Lamports;      // taxa base por assinatura × 1 assinatura; cobrada em filled, failed E expired
  // lamports por unidade mínima de token (mesma unidade de marginalPrice), líquidos das taxas da curva.
  // Antes chamados expectedPriceSol/realizedPriceSol (renomeados em 2026-10-01: nunca foram SOL).
  expectedPriceLamportsPerUnit: number; realizedPriceLamportsPerUnit: number;
  slippageBps: number; landedSlot: bigint | null /* null no paper */; status: 'filled' | 'failed' | 'expired'; error: string | null;
  venueUnverified: boolean;                            // fechado no último preço da curva por graduação
  costEstimateSource: 'tx_costs_median' | 'fallback'; costCappedByHardLimit: boolean; // legado (006): 'tx_costs_median' só se os 2 tipos forem mediana
  priorityFeeSource: TxCostSource; jitoTipSource: TxCostSource; // 007: 'tx_costs_median' | 'tx_costs_p75' | 'fallback'
  virtualQuoteBefore: bigint | null; virtualTokenBefore: TokenAmount | null; // reservas usadas no preenchimento
}
// fluxo de caixa do fill: solOut + rentRefund − solIn − priorityFee − jitoTip − baseFee − rent
export function fillCashFlow(fill: Fill): Lamports;
// Custos, POR TIPO (priority: todas as amostras; tip: só tip > 0): ≥ PAPER_COST_MIN_SAMPLES → mediana × 1,5 (tx_costs_median);
// 1..mínimo−1 → p75 nearest-rank × 1,5 (tx_costs_p75); 0 amostras → fallback configurável (fallback). estimateOneCost/estimateTxCosts.
export function estimateTxCosts(samples: readonly TxCostSample[], params: TxCostEstimateParams): TxCostEstimate;
// Paper executor: máquina de estados pura (ver §5). Sem timers. `PaperExecutorParams` inclui
// `baseFeeLamportsPerSignature` (o orquestrador passa LAMPORTS_PER_SIGNATURE de packages/ingest — o
// número não é duplicado em execution) e `tokenAccountRentLamports` (lido por RPC na partida). O orquestrador chama:
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
//   custoEntrada = solIn + priority + tip + taxa base + rent da compra;
//   L = netQuoteOut(bondingCurveSell(reservas atuais, quantidade)) − priority − tip − taxa base estimados da saída
//       + rent (volta ao fechar). ExitContext = { fees, exitPriorityFeeLamports, exitJitoTipLamports, exitBaseFeeLamports }.
// Precedência: graduated > emergency_creator_sell > emergency_large_sell > stop_loss > trailing_stop > time_stop > take_profit_N.
// Trailing só depois do TP1, sobre L do restante (a máxima recomeça a cada venda parcial). sellFraction do TP = fração da quantidade INICIAL.
export function applyExitFill(position: Position, sellFill: Fill): { position: Position | null; realizedPnlDelta: Lamports };

// estado ao vivo (packages/state, Fase 3): MarketStore = mesmo núcleo puro de applyEvent (tokenUpdateFor),
// mapas mutáveis (sem copiar o Map de todos os tokens a cada evento); equivalência testada.
export class MarketStore { readonly state: MarketState; apply(e: PumpEvent): string | null; seedSkeleton(s: TokenSkeleton): boolean;
  compact(nowMs: number, policy: CompactionPolicy, isProtected: (mint: string) => boolean): { compacted: number; dropped: number } }
// Compactação: posição/ordem pendente → mantém; sem createdAtMs → remove; idade > skeletonRetentionMs (24 h) → remove;
// idade > fullStateMaxAgeMs (maxAgeSec + 60 s) ou graduado → esqueleto (sem trades/holderBalances/firstBuyers,
// mantém creator/createdAtMs/slot/reservas, necessários para creatorTokensCreated24h).

// orquestrador do paper (apps/bot/src/paper/engine.ts, Fase 3). Sem I/O; efeitos por callbacks.
export class PaperEngine {
  constructor(o: { runId; config: StrategyV0Config; limits: EffectiveRiskLimits; curveParams; fees: CurveFeeBps; costs: TxCostEstimate;
    latencyMs; failRate; tokenAccountRentLamports; baseFeeLamportsPerSignature; seed; startMs;
    sinks: { decision(d: DecisionRecord): void; fill(f: Fill): void; notify(text: string): void; log: Logger };
    tradeAlerts?: boolean; killSwitchEnabled?: boolean /* padrão true; false só no replay de pesquisa (§9) */ });
  onEvent(e: PumpEvent, nowMs: number): void; // settleBeforeEvent → MarketStore.apply → saídas do mint → sinal pendente → avaliação de entrada
  onTick(nowMs: number): void;                // settleOnTick → saídas de todas as posições → sinais pendentes → compactação (1×/min)
  setCosts / setFees / setCurveParams / setStopFile; stopEntries(); seedSkeletons(); takeMinuteStats(); takeHourlySummary(nowMs);
  readonly pendingSignalCount: number;        // sinais pendentes (hipóteses a/c); sempre 0 com a v0.1
}
// Hipóteses de entrada do experimento de 2026-10-02 (STRATEGY §8), todas DESLIGADAS por padrão (v0.1 = entrada imediata):
//  - entry.maxPriceAboveMean120sPct (b): último passo de evaluate → reject 'maxPriceAboveMean120sPct' (feature priceVsMean120s).
//  - entry.confirmation {windowSec, maxDipPct} (a) / entry.pullback {retracePct, windowSec, minUniqueBuyers60s} (c), exclusivas:
//    o enter de evaluate vira PendingSignal (packages/strategy/src/pending.ts, puro: createPendingSignal, observePendingPrice,
//    decidePendingSignal → wait | fire | cancel(motivo), confirmPendingEntry → reavalia universo + filtros duros §3 no disparo,
//    rejeição '<modo>:<filtro>', enter 'momentum_confirmed'|'momentum_pullback' com features do disparo + signal_* + espera).
//    O engine guarda um sinal por mint (não reavalia o mint enquanto pendente; protegido da compactação) e no disparo segue o
//    caminho normal (approveEntry → executor). Equivalência "opções ausentes = v0.1" testada em engine.test.ts.
// risco: ApproveEntryInput.killSwitchEnabled?: boolean — false ignora o kill switch (só pesquisa offline); demais limites valem.
// Volume (~15–20 mil eventos/min): avalia só `trade` de curva de mint cuja criação foi vista AO VIVO no run
// (pré-carregados do banco não têm histórico), sem posição/ordem pendente, idade em [minAgeSec, maxAgeSec],
// no máximo 1×/s por mint. `decisions` grava uma linha só quando o resultado do mint muda (primeiro reject,
// mudança de motivo, enter, cada exit) — o report conta tokens (mints distintos) por motivo.
// Relógio: PaperClock.nowMs = max(maior ts de evento, parede − 2 s, último valor) — monotônico; ticks de 1 s.
// Adaptador: apps/bot/src/paper/run-paper.ts (ClickHouse, RPC, Telegram, data/STOP, sinais/IPC de parada). Na partida
// envia "paper iniciado" (run, versão + sha256 do YAML, tamanho, custos por tipo, hora de Brasília com UTC);
// o log por minuto `paper` inclui telegram { enabled, sent, failed, dropped }.
// report (apps/bot/src/report/): origem dos custos por tipo; se algum fill não usou mediana, recalcula com a mediana
// real × 1,5 de tx_costs (sampled_at ≤ fim do run, com teto) e mostra "como rodou" × "com mediana real"; marca
// operações abertas durante lacunas `reconnect` ([detected_at − duration_ms, detected_at]; linhas sem duration_ms:
// "desconectado por N ms" + 30 s de heartbeat) com PnL com/sem elas; qualidade medida (v_run_quality ou o mesmo
// fallback sobre [started_at, último ts de decisions/fills], provisional acima de 1% sem stream).
// Análise "por que perde" (report/analysis.ts, report/exit-sim.ts; puro, testado com fixtures). Preço depois de t = preço
// marginal (virtualQuote/virtualToken) do último trade de curva do mint com ts ≤ t (v_trades); "sem dados" se t passa do fim
// dos dados ou algum minuto no caminho não tem trade gravado de nenhum mint; "graduou" após trade PumpSwap/curve_completed.
//  - stops: tempo até o stop; MFE líquido (netPnlRatio de positions em cada trade entre entrada e stop) e de preço; preço
//    5/15/60 min depois em % do preço marginal na saída; - toda saída: máx/mín nas janelas de 15 min/1 h/4 h, upside no máximo
//    e resultado de segurar até o fim (bondingCurveSell nas reservas do momento, custos de tx iguais);
//  - regras alternativas sobre as mesmas entradas e o mesmo caminho de preço (latência 800 ms, custos de tx reais, sem falha
//    sorteada/limite de slippage/emergências; graduação e falta de dados fecham no último preço da curva): +40%, +100%, só
//    trailing 25% desde a entrada, regra atual, trailing 40%, moonbag 20/40/60% até 4 h — PnL, expectativa, acerto, drawdown;
//  - token vivo 1 h depois (trade em [+55, +65] min e preço em +60 min ≥ 10% do de entrada); retorno por faixa de ageSec e
//    volume60sSol (snapshot do enter); IC 95% da expectativa por bootstrap (10 000 réplicas, mulberry32 semeado);
//    slippage por lado (positivo = pior que o esperado). Run com runs.discarded = 1 (009) → aviso no topo.

// monitor (packages/monitor, Fase 3): depende só de core.
export class TelegramNotifier { // sendMessage via fetch; timeout 5 s; 3 retries com backoff; 429 → retry_after (≤ 30 s);
  constructor(o: { botToken; chatId; logger; fetchFn?; maxQueue? /* 100, descarta a mais antiga */ });
  readonly enabled: boolean; // false (com aviso) se token/chat vazios
  send(text: string): void;  // nunca lança nem bloqueia; erros só no log, com o token removido (redactToken)
  close(timeoutMs?: number): Promise<void>;
}
export function formatEntryAlert(a: EntryAlert): string; formatExitAlert(a: ExitAlert): string; formatHourlySummary(s: HourlySummary): string;

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
3. **Custos:** priority fee e tip de Jito estimados de `tx_costs` (tip só sobre amostras com tip > 0, porque o live vai usar Jito), com o mínimo de amostras `PAPER_COST_MIN_SAMPLES` (30) valendo **por tipo**: com ≥ mínimo, mediana × 1,5 (`tx_costs_median`); com 1 a mínimo−1 amostras, percentil 75 (nearest-rank) das disponíveis × 1,5 (`tx_costs_p75` — o × 1,5 é mantido por pessimismo e para o p75 ficar sempre ≥ a estimativa da mediana); sem amostras, `PAPER_FALLBACK_PRIORITY_FEE_LAMPORTS` / `PAPER_FALLBACK_JITO_TIP_LAMPORTS` (500 000 cada, `fallback`). A origem de cada tipo vai para `fills.priority_fee_source`/`jito_tip_source` (migração 007); `cost_estimate_source` (006) fica como valor combinado legado (`tx_costs_median` só quando os dois tipos vieram da mediana). Nunca acima de `maxPriorityFeeLamports`/`maxJitoTipLamports`: se passar, usa o limite e marca `cost_capped`. Rent da conta de token é injetado e cobrado na 1ª compra do mint e devolvido (`rent_refund`) só na venda que zera a posição. A conta é a ATA **Token-2022** do mint (o mint do Pump.fun é do programa `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`): tamanho **170 bytes** — `GetAccountDataSize` devolve 170 (`qgAAAAAAAAA=`) no `CreateIdempotent` da tx real `packages/ingest/test/fixtures/curve-create.json`, cujas ATAs criadas ficaram com 1 513 840 lamports, o mesmo valor de `getMinimumBalanceForRentExemption(170)` na mainnet em 2026-10-01. O orquestrador lê o rent por RPC na partida (`fetchTokenAccountRent`, `packages/ingest/src/onchain.ts`); se o RPC falhar, usa o valor observado nessa transação e registra no log. A **taxa base** por assinatura (`LAMPORTS_PER_SIGNATURE` = 5000, https://solana.com/docs/core/fees; 1 assinatura por tx) é cobrada em toda transação que entra no bloco — `filled`, `failed` e `expired` — e entra no custo de entrada e no valor de liquidação de `packages/positions`.
4. **Falhas:** taxa configurável (`PAPER_FAIL_RATE`, 10%) sorteada com PRNG semeado (mulberry32; seed derivada do run) — um sorteio por ordem, sempre, para o replay ser estável. `failed` e `expired` (slippage acima do `maxSlippageBps` aprovado) pagam a priority fee e a taxa base e **não** pagam tip (o tip do Jito reverte com o bundle); posição intacta. Compra pendente cuja curva completou durante a latência → `failed` (`curve_unavailable_at_fill`).
5. Registrar `expectedPriceLamportsPerUnit` × `realizedPriceLamportsPerUnit` em todo fill para depois calibrar contra o live, e as reservas virtuais usadas no preenchimento (`virtualQuoteBefore`/`virtualTokenBefore`, para a tabela de sensibilidade do `pnpm report`).
6. **PumpSwap:** nunca simulado (`PumpSwapSimulationNotValidatedError`). Graduação com posição aberta → vende tudo no último preço da curva, `venue_unverified = 1`, sem sorteio de falha/slippage.
7. **Hard limits** conferidos de novo no executor (tamanho, slippage, nº de posições, custos): violação = erro, nunca fill.

## 6. Modelo de dados (ClickHouse)

Migrações em `infra/clickhouse/migrations/` (`pnpm migrate`; cada arquivo roda uma vez, com checksum —
nunca edite uma migração aplicada, crie outra). Toda linha de evento tem `raw_b64`, `received_at`, `recv_seq`.

| Tabela | Conteúdo | Chave de ordenação |
|---|---|---|
| `events_trade` | todos os trades (curva e PumpSwap) | `(mint, slot, sig, event_index)` |
| `v_trades` (view) | `events_trade` com `mint` preenchido via `pools` quando a pool não estava resolvida na gravação — **ler desta** | — |
| `pumpswap_trade_extra` | (migração 011, **não aplicada até o usuário aplicar**) tabela LATERAL de `events_trade` para trades do PumpSwap: `instruction`, `virtual_quote_reserves` (Int128), bps de lp/protocolo/criador/cashback, `cashback_fee`, buyback e holder rewards, `base_supply`, `source` (`recorder`/`backfill`). ReplacingMergeTree(`inserted_at`) — ler com `FINAL`. Gravada pelo recorder ao vivo (só se a tabela existir: conferido em `Recorder.start()`, senão avisa e segue) e preenchida para o passado por `packages/ingest/scripts/backfill-pumpswap-trade-extra.ts` a partir de `raw_b64` (TTL 30 dias, migração 008 — rodar logo). Não altera `events_trade` (11M+ linhas, sem mutação) | `(sig, event_index)` |
| `v_pumpswap_trades(from_slot, to_slot)` (view parametrizada) | `v_trades` do PumpSwap no intervalo `[from_slot, to_slot)` + campos de `pumpswap_trade_extra` (`has_extra = 0` → sem linha lateral; campos extras com 0 e **não confiáveis**). Parametrizada para o JOIN montar só o intervalo (ClickHouse ~1,8 GiB) | — |
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
| `fills` | fills simulados/reais com custos detalhados. Migração 006 (`006_fills_paper_columns.sql`, **ainda não aplicada** — aplicar com `pnpm migrate` é decisão do usuário): `venue_unverified`, `cost_estimate_source`, `cost_capped`, `rent_refund`, `base_fee`, `virtual_quote_before`, `virtual_token_before` (0 = sem reservas) e `expected/realized_price_sol` renomeados para `expected/realized_price_lamports_per_unit` (sempre foram lamports por unidade mínima) | `(run_id, ts)` |
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
  **amostragem** (`getTransaction`, `INGEST_COST_SAMPLES_PER_SEC`, padrão 0,2/s desde 2026-10-01) em `tx_costs`; ordem dentro do
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

### Tamanho do stream e orçamento de RPC (medido em 2026-10-01, `pnpm status`)
Configuração local atual: **stream (`RPC_WS_URL`) = RPC público da Solana**; **consultas HTTP (`RPC_URL`) =
Helius free** (1 crédito por requisição, 1M/mês). Todas as chamadas HTTP (pools, `protocol_config`, rent,
`getTransaction` das amostras) vão para `RPC_URL`; a única exceção é a lista de contas de tip, buscada no block
engine da Jito. O log por minuto (`ingest`) traz `ws.{mbPerMin,messagesPerMin,reconnectsPerMin}` e
`http.{requestsPerMin,rateLimitedPerMin}` (cada tentativa conta: é o que o provedor cobra); `pnpm status`
resume a janela e projeta por dia/mês.

| Medida (3 min, ~22 mil eventos/min) | Valor |
|---|---|
| WebSocket (payload decodificado) | ~200 MB/min ≈ **280 GB/dia ≈ 8,4 TB/mês**; ~115 mil mensagens/min; 0 reconexões |
| HTTP com limite de pools | 18 req/min, 0 × 429 → ~26 mil/dia ≈ **78% do Helius free** |
| HTTP antes do limite | ~255 req/min, ~205 × 429 (resolvedor de pools com 3 retries imediatos) |

- O volume do WS é o argumento central na escolha de provedor pago: cobrança por GB entregue ficaria cara;
  ~65% das notificações são de transações com erro e são descartadas depois de baixadas (o filtro
  `logsSubscribe` não permite excluí-las). gRPC com filtro de falhas ou plano sem cobrança por volume são as
  alternativas a avaliar.
- Pools do PumpSwap: `POOL_RESOLVE_PER_SEC` (padrão 0,1/s) com cliente sem retry imediato; falha cai no backoff
  por pool. A fila de pools pendentes cresce (~100/min) porque surgem mais pools do que o orçamento resolve —
  aceitável na v0 (só curva); trades do PumpSwap ficam com `mint = ''` até a pool ser resolvida ou o
  `pool_created` aparecer.
- Runs com qualquer endpoint público (HTTP **ou** WS) são marcadas `provisional`.

## 9. Replay determinístico (Fase 4)

Código em `apps/bot/src/replay/` (não há `apps/backtest`: o replay reusa diretamente o `PaperEngine` de
`apps/bot/src/paper/engine.ts` e as funções puras do `pnpm report`). Comandos: `pnpm replay` (um período, uma ou
mais configs; `--write` grava, `--compare-run` compara com um paper) e `pnpm replay:sweep` (hipóteses × ajuste/validação).

```ts
// EventSource (packages/core) de replay: lê events_trade (curva + PumpSwap filtrado), events_token e events_lifecycle
// (curve_completed, pool_created) em BLOCOS DE SLOTS (1.500 ≈ 10 min, com pré-carga do próximo bloco), zod em toda
// linha, ordena cada bloco e remove duplicatas exatas (kind|sig|event_index). Blocos por slot ⇒ ordem global exata.
export class ClickHouseReplaySource implements EventSource { constructor(query: QueryFn, o: { fromMs; toMs; liveCreatedFromMs; liveCreatedToMs; chunkSlots? }) }
// Ordem total: (slot, received_at, recv_seq, event_index, tipo, sig). Dentro do slot, a chegada ao ingest é a única
// aproximação da posição da tx no bloco (logsSubscribe não informa o índice). O paper ao vivo usa a chegada pura.
export function compareReplayEvents(a: ReplayEvent, b: ReplayEvent): number;
// Laço: o MESMO PaperEngine (um por variante, todos na mesma passada de eventos), SimulatedClock, sem I/O.
export class ReplayDriver { onEvent(e: ReplayEvent): void; advanceTo(t: number): void; readonly idle: boolean }
export function executeReplay(inputs: ReplayInputs, variants: ReplayVariant[], params: ReplayParams): Promise<ReplayResult>;
```

- **Relógio:** `agora = max(agora, ts do evento)` (ts on-chain, resolução de 1 s ⇒ decisões em segundos cheios). Ticks
  sintéticos a cada segundo cheio T ≤ agora, emitidos ANTES dos eventos com ts = T (saídas por tempo e ordens que vencem
  sem evento do mint). Modo `--clock=paper-wall` (só para reproduzir um paper já rodado): `agora = max(agora, ts,
  received_at − 2 s)`, emulando o `PaperClock` com o `received_at` gravado como parede (toda linha de evento tem
  `received_at`; nenhum trecho do bloco de 01–02/10 ficou sem). **Os dois modos dão resultados bem diferentes nos dados
  de 01–02/10** porque o relógio do Windows que gravou estava ~23 s adiantado (medido em 02/10: relógio local 17:13:32 ×
  `Date` HTTP 17:13:09; `received_at − ts` de 19 a 23 s, crescendo ~0,27 s/h): no paper ao vivo `parede − 2 s` venceu o
  `ts` e o "agora" ficou ~18–21 s à frente dos eventos. Com `ts` de resolução de 1 s, as janelas de 60 s/120 s das
  features (buy/sell, compradores únicos, volume, média de preço) passaram a enxergar só os ~40 s mais antigos e a idade
  do token ficou ~20 s inflada — outro conjunto de tokens passa no gatilho. `paper_wall` reproduz o paper que rodou;
  `event` é o que um paper com relógio certo faria. Corrigir o relógio/`PaperClock` é pré-requisito para o próximo paper.
- **Sweep (`pnpm replay:sweep`):** padrão `--clock=paper-wall`; o ajuste começa no início dos dados, então tem
  aquecimento SÓ DE ESTADO (`eligibleFromMs`, `--warmup-min=120`: tokens criados nele nunca são elegíveis) e os dois
  períodos usam a mesma pré-carga de criadores (`creatorPreloadMs`, `--creator-preload-h=2`) — cada período começa
  com 2 h de histórico de criadores. Corte em 60% do tempo elegível (00:16:24 → 11:53:08 UTC ⇒ 07:14 UTC).
- **Parâmetros "como eram na hora":** `protocol_config` (Global/FeeConfig do Pump.fun) vigente no início e aplicado
  quando o relógio passa por cada linha nova; custos = `estimateTxCosts` sobre as amostras de `tx_costs` com
  `t − PAPER_COST_LOOKBACK_HOURS ≤ sampled_at ≤ t`, recalculados no início e a cada `PAPER_COST_RELOAD_MS` (como o
  paper); rent = `OBSERVED_TOKEN_ACCOUNT_RENT_LAMPORTS` (1.513.840, o mesmo valor que o RPC devolveu ao paper de 02/10);
  latência/falha de `.env` (`PAPER_LATENCY_MS`, `PAPER_FAIL_RATE`) ou `--latency-ms/--fail-rate`; seed fixa (`--seed`,
  padrão 1) ou `--seed-from-run=<run id>` (a mesma derivação do paper).
- **Início limpo:** pré-carga de `token_created` das 24 h anteriores como esqueleto (igual ao paper); só tokens CRIADOS
  dentro do período são elegíveis (o engine só avalia criações "vistas ao vivo"). Por isso não há aquecimento de estado:
  as features de um token elegível começam na criação dele, e o único estado entre tokens (filtro de criador) vem da
  pré-carga. Entradas até `to` (exclusivo); depois, drenagem de até 30 min de eventos reais só para as saídas (para antes
  se não sobrar posição) — posições abertas no corte contam no período em que abriram e nunca atravessam para o seguinte.
- **PumpSwap:** só os trades dos mints criados no período (filtro na consulta). Os demais (~80% do volume gravado) não
  mudam nenhuma decisão: só trades de curva entram nas features, só tokens criados no run são avaliados e tokens sem
  criação conhecida são descartados na compactação. O executor continua recusando swap no PumpSwap (graduação fecha no
  último preço da curva).
- **Lacunas de gravação** (`gaps.ts`): ≥ 4 s seguidos sem nenhum trade de curva (o normal é 30–60/s) ∪ `ingest_gaps`
  `reconnect`. Com `--exclude-gaps=on` (padrão do sweep), token cuja janela [criação, criação + maxAgeSec] cruza uma lacuna
  vira só esqueleto (nunca avaliado). Operações que cruzam lacuna são marcadas no resumo (PnL com/sem elas).
- **Kill switch:** ligado por padrão (como no paper). `--kill-switch=off` (padrão do sweep) passa `killSwitchEnabled:
  false` ao engine, só para a amostra das hipóteses não ser cortada pelo limite de perda diária.
- **Gravação (`--write`):** `runs` (mode `replay`, `config_hash` = sha256 do YAML + parâmetros, `git_commit`, `started_at`
  = início do período), `decisions` e `fills` com run id determinístico `replay-<rótulo>-<início>-<hash8>` (não regrava um
  run id existente). `pnpm report --run=<id>` funciona igual ao paper. Nenhuma migração nova foi necessária.
- **Memória:** blocos de ~10 min (ClickHouse e Node), estado por engine compactado como no paper; 10 variantes numa
  passada ficaram em ~0,5–0,6 GB no Node (`--max-old-space-size=1792` nos scripts).
- **Testes** (`replay.test.ts`, sem rede): mesmo intervalo 2× → decisões e fills idênticos (deep equal); várias variantes na
  mesma passada = cada uma sozinha; decisões em segundos cheios e fills com +800 ms; fim das entradas; exclusão por
  lacuna; kill switch ligado/desligado; agendas de custos/protocolo sem olhar o futuro; `ClickHouseReplaySource` com
  `QueryFn` falso (blocos, conversão, ordem, duplicatas, `stop()`); comparação replay × paper.
