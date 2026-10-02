import type { Lamports, TokenAmount } from './types.ts';

/**
 * Campos comuns a todo evento on-chain normalizado.
 * `ts` vem do campo `timestamp` do próprio evento (relógio do cluster, em ms): determinístico no replay.
 * `receivedAtMs`/`recvSeq` registram a ordem de chegada ao ingest; com WebSocket é a única
 * aproximação da ordem dentro do slot (o logsSubscribe não informa o índice da transação no bloco).
 */
export interface OnchainEventBase {
  slot: bigint;
  ts: number;
  sig: string;
  /** Posição do evento entre os eventos Pump/PumpSwap da transação (0, 1, ...). */
  eventIndex: number;
  receivedAtMs: number;
  recvSeq: number;
  /** Bytes brutos do evento (discriminador + borsh) em base64: permite re-decodificar com IDL futuro. */
  rawB64: string;
}

export interface TokenCreatedEvent extends OnchainEventBase {
  kind: 'token_created';
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  bondingCurve: string;
  quoteMint: string;
  tokenTotalSupply: TokenAmount;
}

/** Trade na bonding curve do Pump.fun (TradeEvent). Valores como emitidos pelo programa. */
export interface CurveTradeEvent extends OnchainEventBase {
  kind: 'trade';
  venue: 'curve';
  mint: string;
  trader: string;
  side: 'buy' | 'sell';
  quoteMint: string;
  /** `quote_amount` do evento (igual a `sol_amount` quando a curva é cotada em SOL). */
  quoteAmount: bigint;
  tokenAmount: TokenAmount;
  virtualQuoteReserves: bigint;
  virtualTokenReserves: TokenAmount;
  realQuoteReserves: bigint;
  realTokenReserves: TokenAmount;
  protocolFee: bigint;
  creatorFee: bigint;
  ixName: string;
}

/**
 * Trade no PumpSwap (BuyEvent/SellEvent). `mint`/`quoteMint` são o base/quote da pool como estão
 * on-chain (não assumimos que o base é o token). `side` = compra/venda do base.
 */
export interface PumpSwapTradeEvent extends OnchainEventBase {
  kind: 'trade';
  venue: 'pumpswap';
  pool: string;
  /** Base mint da pool; string vazia se a pool não pôde ser resolvida ainda (ver poolUnresolved). */
  mint: string;
  quoteMint: string;
  /** true = mint/quoteMint vazios porque a pool ainda não foi resolvida; `v_trades` preenche depois. */
  poolUnresolved: boolean;
  trader: string;
  side: 'buy' | 'sell';
  /** base_amount_out (buy) ou base_amount_in (sell). */
  tokenAmount: TokenAmount;
  /** quote_amount_in (buy) ou quote_amount_out (sell), como emitido. */
  quoteAmount: bigint;
  /** user_quote_amount_in (buy) ou user_quote_amount_out (sell), como emitido. */
  userQuoteAmount: bigint;
  poolBaseReserves: TokenAmount;
  poolQuoteReserves: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** Só presente no BuyEvent. */
  ixName: string | null;
  /**
   * Campos do evento necessários para reproduzir o swap exato (`packages/curve-math/src/pumpswap.ts`).
   * O `normalize` do ingest SEMPRE preenche. Ausente só quando o evento foi reconstruído de uma
   * fonte que não os tem (ex.: linha de `events_trade` sem a tabela lateral `pumpswap_trade_extra`).
   */
  swapDetails?: PumpSwapSwapDetails;
}

/**
 * Campos extras do `BuyEvent`/`SellEvent` do PumpSwap (IDL `pump_amm.json`), gravados na tabela
 * lateral `pumpswap_trade_extra` (migração 011).
 */
export interface PumpSwapSwapDetails {
  /** `buy` (base exata), `buy_exact_quote_in` (quote gastável) ou `sell`. Vem de `ix_name` no BuyEvent. */
  instruction: 'buy' | 'buy_exact_quote_in' | 'sell';
  /** `virtual_quote_reserves` (i128): somado ao quote no constant product. 0 em pools sem offset. */
  virtualQuoteReserves: bigint;
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  /** `coin_creator_fee_basis_points`. */
  creatorFeeBps: bigint;
  cashbackFeeBps: bigint;
  /** `cashback` (quote): componente de taxa que vai para o usuário/acumulador, fora da pool. */
  cashbackFee: bigint;
  /** Repartições internas da taxa de protocolo/criador; não afetam usuário nem pool. */
  buybackFeeBps: bigint;
  buybackFee: bigint;
  holderRewardsBps: bigint;
  holderRewards: bigint;
  /** `base_supply`: supply do token base no momento (market cap para o tier de taxa). */
  baseSupply: bigint;
}

export interface CurveCompletedEvent extends OnchainEventBase {
  kind: 'curve_completed';
  mint: string;
  bondingCurve: string;
}

export interface PoolCreatedEvent extends OnchainEventBase {
  kind: 'pool_created';
  pool: string;
  mint: string;
  quoteMint: string;
  creator: string;
}

/** Custo de uma transação (amostrado via getTransaction), para calibrar o paper executor. */
export interface TxCostEvent {
  kind: 'tx_cost';
  slot: bigint;
  sig: string;
  feeLamports: Lamports;
  /** fee total menos a taxa base por assinatura. */
  priorityFee: Lamports;
  /** soma das transferências para contas de tip do Jito; null se as contas de tip não estavam disponíveis. */
  jitoTip: Lamports | null;
  computeUnits: number | null;
  numSignatures: number;
}

export type PumpEvent =
  | TokenCreatedEvent
  | CurveTradeEvent
  | PumpSwapTradeEvent
  | CurveCompletedEvent
  | PoolCreatedEvent
  | TxCostEvent;

export interface SocialEvent {
  kind: 'social_post';
  ts: number;
  source: 'x' | 'telegram' | 'other';
  author: string;
  text: string;
  mediaUrls: string[];
  url: string;
}

/**
 * Problemas de ingestão gravados em `ingest_gaps` (o backtest ignora os tokens afetados).
 * Pool não resolvida NÃO é um `IngestGap`: é esperado sob carga e contado à parte em
 * `IngestStats.unresolvedPools` (ver ingest/service.ts), para não confundir com problemas reais.
 */
export interface IngestGap {
  kind: 'reconnect' | 'log_truncated' | 'parse_error' | 'unknown_event' | 'trailing_bytes' | 'pool_resolve_failed';
  detectedAtMs: number;
  /** Para reconnect: último slot visto antes da queda e primeiro depois. */
  fromSlot: bigint | null;
  toSlot: bigint | null;
  sig: string | null;
  program: string | null;
  /** Só em `reconnect`: tempo sem stream (última mensagem antes do silêncio → primeira depois). */
  durationMs: number | null;
  detail: string;
}

export interface EventSource {
  start(onEvent: (e: PumpEvent | SocialEvent) => void): Promise<void>;
  stop(): Promise<void>;
}
