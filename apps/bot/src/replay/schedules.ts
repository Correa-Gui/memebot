import { parseCurveInitialParams, parseFeeConfigAccount, worstCaseCurveFees } from '@memebot/curve-math';
import type { CurveFeeBps, CurveInitialParams } from '@memebot/curve-math';
import { estimateTxCosts } from '@memebot/execution';
import type { TxCostEstimate, TxCostEstimateParams } from '@memebot/execution';

/**
 * Parâmetros externos "como eram na hora" para o replay (Fase 4). Puro: recebe as linhas já lidas do
 * banco (o I/O fica em `clickhouse.ts`).
 */

export interface TimedCostSample {
  sampledAtMs: number;
  priorityFee: bigint;
  jitoTip: bigint | null;
}

/**
 * Custos como o paper ao vivo os via: o paper estima na partida com as amostras de `tx_costs` das últimas
 * `lookbackMs` (PAPER_COST_LOOKBACK_HOURS) e recarrega a cada `reloadMs` (PAPER_COST_RELOAD_MS). Aqui,
 * a estimativa no instante `t` usa só as amostras com `t − lookbackMs ≤ sampled_at ≤ t` — nada do futuro.
 */
export class CostSchedule {
  private readonly samples: TimedCostSample[];
  private nextReloadMs: number;
  private readonly params: TxCostEstimateParams;
  private readonly lookbackMs: number;
  private readonly reloadMs: number;

  constructor(samples: readonly TimedCostSample[], params: TxCostEstimateParams, lookbackMs: number, reloadMs: number, startMs: number) {
    this.params = params;
    this.lookbackMs = lookbackMs;
    this.reloadMs = reloadMs;
    this.samples = [...samples].sort((a, b) => a.sampledAtMs - b.sampledAtMs);
    this.nextReloadMs = startMs;
  }

  estimateAt(t: number): TxCostEstimate {
    const lo = lowerBound(this.samples, t - this.lookbackMs);
    const hi = upperBound(this.samples, t);
    return estimateTxCosts(this.samples.slice(lo, hi), this.params);
  }

  /** Recargas devidas até `t` (inclusive): a última estimativa devida, ou `null` se nenhuma. */
  due(t: number): TxCostEstimate | null {
    let out: TxCostEstimate | null = null;
    while (this.nextReloadMs <= t) {
      out = this.estimateAt(this.nextReloadMs);
      this.nextReloadMs += this.reloadMs;
    }
    return out;
  }
}

function lowerBound(xs: readonly TimedCostSample[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid]?.sampledAtMs ?? 0) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(xs: readonly TimedCostSample[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid]?.sampledAtMs ?? 0) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Linha de `protocol_config` do Pump.fun (Global ou FeeConfig). */
export interface ProtocolRow {
  tsMs: number;
  accountType: 'Global' | 'FeeConfig';
  configJson: string;
}

export interface ProtocolUpdate {
  curveParams?: CurveInitialParams;
  fees?: CurveFeeBps;
}

/**
 * `protocol_config` vigente: na partida, a linha mais recente com `ts ≤ início` de cada tipo (o paper lê
 * on-chain na partida — o mesmo conteúdo que grava ali); depois, cada linha nova é aplicada quando o
 * relógio do replay passa pelo `ts` dela (o paper aplica as leituras periódicas do mesmo jeito).
 */
export class ProtocolSchedule {
  private readonly rows: ProtocolRow[];
  private index = 0;

  constructor(rows: readonly ProtocolRow[]) {
    this.rows = [...rows].sort((a, b) => a.tsMs - b.tsMs);
  }

  /** Estado inicial em `startMs`. Erro se faltar Global ou FeeConfig até lá (não há como simular a curva). */
  initial(startMs: number): { curveParams: CurveInitialParams; fees: CurveFeeBps; globalTsMs: number; feeTsMs: number } {
    let global: ProtocolRow | null = null;
    let fee: ProtocolRow | null = null;
    while (this.index < this.rows.length && (this.rows[this.index]?.tsMs ?? Infinity) <= startMs) {
      const r = this.rows[this.index];
      if (r?.accountType === 'Global') global = r;
      if (r?.accountType === 'FeeConfig') fee = r;
      this.index++;
    }
    if (!global || !fee) throw new Error(`protocol_config sem Global/FeeConfig do Pump.fun até ${new Date(startMs).toISOString()}: não há como simular a curva`);
    return {
      curveParams: parseCurveInitialParams(JSON.parse(global.configJson)),
      fees: worstCaseCurveFees(parseFeeConfigAccount(JSON.parse(fee.configJson))),
      globalTsMs: global.tsMs,
      feeTsMs: fee.tsMs,
    };
  }

  /** Linhas com `ts ≤ t` ainda não aplicadas (a última de cada tipo vence). */
  due(t: number): ProtocolUpdate | null {
    let out: ProtocolUpdate | null = null;
    while (this.index < this.rows.length && (this.rows[this.index]?.tsMs ?? Infinity) <= t) {
      const r = this.rows[this.index];
      this.index++;
      if (!r) continue;
      out ??= {};
      if (r.accountType === 'Global') out.curveParams = parseCurveInitialParams(JSON.parse(r.configJson));
      else out.fees = worstCaseCurveFees(parseFeeConfigAccount(JSON.parse(r.configJson)));
    }
    return out;
  }
}

/** Vela horária de SOL/US$ (referência pública gravada em `config/reference/`, ver `loadSolUsdCandles`). */
export interface SolUsdCandle {
  openTimeMs: number;
  open: number;
}

/**
 * Preço SOL/US$ "como era" no instante `t` (universo graduado: filtro de market cap em US$): o preço de
 * ABERTURA da vela horária vigente (`openTimeMs ≤ t < openTimeMs + 1 h`) — nada do futuro dentro da hora.
 * `null` fora da série.
 */
export class SolUsdSchedule {
  private readonly candles: SolUsdCandle[];

  constructor(candles: readonly SolUsdCandle[]) {
    this.candles = [...candles].sort((a, b) => a.openTimeMs - b.openTimeMs);
  }

  at(t: number): number | null {
    let lo = 0;
    let hi = this.candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.candles[mid]?.openTimeMs ?? 0) <= t) lo = mid + 1;
      else hi = mid;
    }
    const c = this.candles[lo - 1];
    return c && t < c.openTimeMs + 3_600_000 ? c.open : null;
  }
}
