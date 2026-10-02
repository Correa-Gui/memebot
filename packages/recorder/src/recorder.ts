import { createClient, type ClickHouseClient } from '@clickhouse/client';
import type { IngestGap, Logger, PumpEvent } from '@memebot/core';
import { BatchWriter, type WriterStats } from './batch-writer.ts';
import {
  FILLS_REQUIRED_COLUMNS,
  decisionToRow,
  fillToRow,
  parseProtocolConfigRow,
  parseTokenCreationRows,
  parseTxCostRows,
  type DecisionRecord,
  type FillRecord,
  type ProtocolConfigRecord,
  type TokenCreationRecord,
} from './paper-rows.ts';
import { chTime, eventToRow, gapToRow, pumpSwapTradeExtraRow } from './rows.ts';

export interface RecorderOptions {
  url: string;
  username: string;
  password: string;
  database: string;
  runId: string;
  logger: Logger;
  now?: () => number;
}

export interface PoolRow {
  pool: string;
  baseMint: string;
  quoteMint: string;
  /** Slot da CreatePoolEvent; 0 se a pool foi resolvida por leitura de conta (slot de criação desconhecido). */
  createdSlot: bigint;
}

/** Adaptador do ClickHouse: grava eventos em lote e oferece as leituras que o ingest precisa na partida. */
export class Recorder {
  private readonly client: ClickHouseClient;
  private readonly writer: BatchWriter;
  private readonly runId: string;
  private readonly now: () => number;
  private readonly logger: Logger;
  /** `pumpswap_trade_extra` existe (migração 011 aplicada)? Conferido em `start()`. */
  private pumpSwapExtraEnabled = false;

  constructor(o: RecorderOptions) {
    this.client = createClient({ url: o.url, username: o.username, password: o.password, database: o.database, request_timeout: 30_000 });
    this.writer = new BatchWriter({
      logger: o.logger,
      insert: async (table, rows) => {
        await this.client.insert({ table, values: rows, format: 'JSONEachRow' });
      },
    });
    this.runId = o.runId;
    this.now = o.now ?? Date.now;
    this.logger = o.logger;
  }

  get stats(): WriterStats {
    return this.writer.stats;
  }

  async start(): Promise<void> {
    const ping = await this.client.ping();
    if (!ping.success) throw new Error(`ClickHouse indisponível: ${String(ping.error)}`);
    const rs = await this.client.query({ query: 'EXISTS TABLE pumpswap_trade_extra', format: 'JSONEachRow' });
    const exists = (await rs.json<{ result: number }>())[0]?.result === 1;
    this.pumpSwapExtraEnabled = exists;
    if (!exists) {
      this.logger.warn('pumpswap_trade_extra não existe (migração 011 não aplicada): campos extras do PumpSwap não serão gravados');
    }
    this.writer.start();
  }

  async stop(): Promise<void> {
    await this.writer.stop();
    await this.client.close();
  }

  recordEvent(e: PumpEvent): void {
    const { table, row } = eventToRow(e, this.now());
    this.writer.add(table, row);
    if (e.kind === 'trade' && e.venue === 'pumpswap' && e.swapDetails && this.pumpSwapExtraEnabled) {
      this.writer.add(
        'pumpswap_trade_extra',
        pumpSwapTradeExtraRow({ sig: e.sig, eventIndex: e.eventIndex, slot: e.slot, tsMs: e.ts, pool: e.pool }, e.swapDetails, 'recorder', this.now()),
      );
    }
    if (e.kind === 'pool_created') {
      this.writer.add('pumpswap_pools', {
        pool: e.pool,
        base_mint: e.mint,
        quote_mint: e.quoteMint,
        created_slot: e.slot.toString(),
        source: 'create_pool_event',
        seen_at: chTime(e.ts),
      });
    }
  }

  /** Pool resolvida por leitura de conta (pool criada antes da gravação começar): slot de criação é desconhecido. */
  recordResolvedPool(p: Omit<PoolRow, 'createdSlot'>): void {
    this.writer.add('pumpswap_pools', { pool: p.pool, base_mint: p.baseMint, quote_mint: p.quoteMint, created_slot: '0', source: 'account', seen_at: chTime(this.now()) });
  }

  recordGap(g: IngestGap): void {
    this.writer.add('ingest_gaps', gapToRow(g, this.runId));
  }

  /**
   * Saúde do run (uma linha por minuto): base da qualidade MEDIDA (`v_run_quality`, migração 007).
   * Hosts sem path/query (provedores põem a API key ali) — o chamador passa só `URL.host`.
   */
  recordRunHealth(h: { uptimeMs: number; streamGapMs: number; rpcHost: string; wsHost: string }): void {
    this.writer.add('run_health', {
      run_id: this.runId,
      ts: chTime(this.now()),
      uptime_ms: Math.max(0, Math.round(h.uptimeMs)),
      stream_gap_ms: Math.max(0, Math.round(h.streamGapMs)),
      rpc_host: h.rpcHost,
      ws_host: h.wsHost,
    });
  }

  recordMetadata(mint: string, m: { ok: true; description: string | null; image: string | null; twitter: string | null; telegram: string | null; website: string | null; rawJson: string } | { ok: false; error: string }): void {
    const empty = { description: null, image: null, twitter: null, telegram: null, website: null, raw_json: null };
    this.writer.add('token_metadata', {
      mint,
      fetched_at: chTime(this.now()),
      ...(m.ok
        ? { ok: 1, description: m.description, image: m.image, twitter: m.twitter, telegram: m.telegram, website: m.website, raw_json: m.rawJson, error: null }
        : { ok: 0, ...empty, error: m.error }),
    });
  }

  recordProtocolConfig(s: { programId: string; account: string; accountType: string; configJson: string; configHash: string }): void {
    this.writer.add('protocol_config', {
      ts: chTime(this.now()),
      run_id: this.runId,
      program_id: s.programId,
      account: s.account,
      account_type: s.accountType,
      config_json: s.configJson,
      config_hash: s.configHash,
    });
  }

  async recordRun(r: {
    mode: 'record' | 'paper' | 'live' | 'replay';
    configHash: string;
    gitCommit: string;
    idlHash: string;
    /**
     * Valor inicial gravado na partida. A qualidade que vale é a MEDIDA (`v_run_quality`, a partir de
     * `run_health`); este campo fica para runs antigos sem `run_health`.
     */
    quality: 'provisional' | 'production';
  }): Promise<void> {
    await this.client.insert({
      table: 'runs',
      values: [{ run_id: this.runId, started_at: chTime(this.now()), mode: r.mode, config_hash: r.configHash, git_commit: r.gitCommit, idl_hash: r.idlHash, quality: r.quality }],
      format: 'JSONEachRow',
    });
  }

  /** Decisão do paper/live (entrar, sair, rejeitar) com o snapshot de features. Em lote, como os eventos. */
  recordDecision(d: DecisionRecord): void {
    this.writer.add('decisions', decisionToRow(d));
  }

  /** Fill simulado/real com custos por categoria (colunas da migração 006). */
  recordFill(f: FillRecord): void {
    this.writer.add('fills', fillToRow(f));
  }

  /** Colunas de `fills` exigidas pelo paper que ainda não existem (migração 006 não aplicada). */
  async missingFillsColumns(): Promise<string[]> {
    const rs = await this.client.query({
      query: "SELECT name FROM system.columns WHERE database = currentDatabase() AND table = 'fills'",
      format: 'JSONEachRow',
    });
    const present = new Set((await rs.json<{ name: string }>()).map((r) => r.name));
    return FILLS_REQUIRED_COLUMNS.filter((c) => !present.has(c));
  }

  /**
   * `token_created` gravados nas últimas `hours` horas (só criador/horário/slot), para o filtro
   * "criador criou ≥ N tokens em 24 h" valer desde a partida. Runs gravadas com RPC público podem ter
   * lacunas (reconexões, 429): a contagem por criador pode sair menor que a real.
   */
  async loadRecentTokenCreations(hours: number): Promise<TokenCreationRecord[]> {
    const rs = await this.client.query({
      query:
        'SELECT mint, creator, toUnixTimestamp64Milli(ts) AS ts_ms, slot, quote_mint, token_total_supply ' +
        'FROM events_token WHERE ts >= now64(3) - toIntervalHour({hours:UInt32}) ORDER BY ts',
      query_params: { hours },
      format: 'JSONEachRow',
    });
    return parseTokenCreationRows(await rs.json<unknown>());
  }

  /** Amostras de `tx_costs` das últimas `hours` horas (priority fee e tip), para `estimateTxCosts`. */
  async loadTxCostSamples(hours: number): Promise<{ priorityFee: bigint; jitoTip: bigint | null }[]> {
    const rs = await this.client.query({
      query: 'SELECT priority_fee, jito_tip FROM tx_costs WHERE sampled_at >= now64(3) - toIntervalHour({hours:UInt32})',
      query_params: { hours },
      format: 'JSONEachRow',
    });
    return parseTxCostRows(await rs.json<unknown>());
  }

  /** Linha mais recente de `protocol_config` para (programa, tipo de conta); `null` se não houver. */
  async loadLatestProtocolConfig(programId: string, accountType: string): Promise<ProtocolConfigRecord | null> {
    const rs = await this.client.query({
      query:
        'SELECT config_json, config_hash, toUnixTimestamp64Milli(ts) AS ts_ms FROM protocol_config ' +
        'WHERE program_id = {programId:String} AND account_type = {accountType:String} ORDER BY ts DESC LIMIT 1',
      query_params: { programId, accountType },
      format: 'JSONEachRow',
    });
    const rows = await rs.json<unknown>();
    return rows.length > 0 ? parseProtocolConfigRow(rows[0]) : null;
  }

  /** Força a gravação do que estiver no buffer (ex.: antes de um relatório no encerramento). */
  flush(): Promise<void> {
    return this.writer.flush();
  }

  /** Pools já conhecidas, para o ingest não precisar consultar o RPC de novo após reiniciar. */
  async loadPools(): Promise<PoolRow[]> {
    const rs = await this.client.query({ query: 'SELECT pool, base_mint, quote_mint, created_slot FROM pumpswap_pools FINAL', format: 'JSONEachRow' });
    const rows = await rs.json<{ pool: string; base_mint: string; quote_mint: string; created_slot: string }>();
    return rows.map((r) => ({ pool: r.pool, baseMint: r.base_mint, quoteMint: r.quote_mint, createdSlot: BigInt(r.created_slot) }));
  }
}
