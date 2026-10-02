/**
 * Parte pura do backfill de `pumpswap_trade_extra` (sem I/O; testada em
 * `packages/ingest/test/pumpswap-extra-backfill.test.ts`). O script com I/O é
 * `backfill-pumpswap-trade-extra.ts`.
 */
import { pumpSwapTradeExtraRow, type Row } from '../../recorder/src/rows.ts';
import { decodePumpSwapSwapDetails, type DecodeSwapDetailsResult } from '../src/pumpswap-extra.ts';

/** Linha lida de `events_trade` (JSONEachRow; UInt64 chegam como string). */
export interface RawTradeRow {
  sig: string;
  event_index: number;
  slot: string;
  ts_ms: string | number;
  pool: string;
  raw_b64: string;
}

export type SkipReason = Extract<DecodeSwapDetailsResult, { ok: false }>['reason'];

export type BackfillOutcome = { ok: true; row: Row } | { ok: false; reason: SkipReason; detail: string };

export function backfillRow(r: RawTradeRow, insertedAtMs: number): BackfillOutcome {
  const res = decodePumpSwapSwapDetails(r.raw_b64);
  if (!res.ok) return res;
  return {
    ok: true,
    row: pumpSwapTradeExtraRow(
      { sig: r.sig, eventIndex: r.event_index, slot: BigInt(r.slot), tsMs: Number(r.ts_ms), pool: r.pool },
      res.details,
      'backfill',
      insertedAtMs,
    ),
  };
}

export class BackfillStats {
  read = 0;
  written = 0;
  readonly skipped = new Map<SkipReason, number>();
  /** Primeiros exemplos de cada motivo de descarte, para o relatório (no máximo 3 por motivo). */
  readonly samples = new Map<SkipReason, string[]>();

  add(o: BackfillOutcome, sig: string): void {
    this.read++;
    if (o.ok) return;
    this.skipped.set(o.reason, (this.skipped.get(o.reason) ?? 0) + 1);
    const list = this.samples.get(o.reason) ?? [];
    if (list.length < 3) list.push(`${sig}: ${o.detail}`);
    this.samples.set(o.reason, list);
  }

  summary(): string {
    const skipped = [...this.skipped.entries()].map(([k, v]) => `${k}=${String(v)}`).join(' ');
    return `lidas=${String(this.read)} gravadas=${String(this.written)} descartadas: ${skipped || 'nenhuma'}`;
  }
}

/**
 * Fatias por faixa de `mint` (1ª coluna do ORDER BY de `events_trade`): cada fatia lê só os
 * granules daquela faixa, o que permite retomar (`--from-chunk`) sem reler a tabela inteira.
 * Fatia 0 = `mint = ''` (pool não resolvida na gravação); depois uma por 1º caractere base58.
 */
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export interface MintChunk {
  index: number;
  label: string;
  /** Condição SQL sobre `mint` (só literais fixos daqui, sem entrada externa). */
  where: string;
}

export function mintChunks(): MintChunk[] {
  const chunks: MintChunk[] = [{ index: 0, label: "mint=''", where: "mint = ''" }];
  for (let i = 0; i < BASE58.length; i++) {
    const c = BASE58.charAt(i);
    const next = i + 1 < BASE58.length ? BASE58.charAt(i + 1) : null;
    // limites lexicográficos: [c, próximo) — base58 em ordem ASCII; a 1ª fatia não tem piso (só
    // exclui '') e a última não tem teto, para a união cobrir qualquer mint não vazio
    const lower = i === 0 ? "mint != ''" : `mint >= '${c}'`;
    const where = next ? `${lower} AND mint < '${next}'` : lower;
    chunks.push({ index: i + 1, label: `mint ${c}*`, where });
  }
  return chunks;
}
