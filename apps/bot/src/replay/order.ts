import type { PumpEvent } from '@memebot/core';

/** Eventos on-chain que o replay entrega ao `PaperEngine` (o `tx_cost` não entra: custos vêm de `tx_costs`). */
export type ReplayEvent = Exclude<PumpEvent, { kind: 'tx_cost' }>;

/** Desempate estável entre tabelas no mesmo (slot, chegada, recv_seq, event_index) — não deveria ocorrer. */
const KIND_RANK: Record<ReplayEvent['kind'], number> = { token_created: 0, trade: 1, curve_completed: 2, pool_created: 3 };

/**
 * Ordem TOTAL do replay (Fase 4), documentada em docs/ARCHITECTURE.md (seção replay):
 *
 *   (slot, received_at, recv_seq, event_index, tipo, sig)
 *
 * - `slot` primeiro: ordem do cluster (o `ts` on-chain é por bloco, resolução de 1 s, e não decresce com o slot);
 * - dentro do slot, a ordem de CHEGADA ao ingest (`received_at`, depois `recv_seq` — contador por mensagem do
 *   processo) é a única aproximação da posição da transação no bloco (o `logsSubscribe` não informa o índice);
 * - `event_index` ordena os eventos de uma mesma transação (ex.: create + compra inicial);
 * - tipo e `sig` só desempatam o impossível, para a ordem nunca depender da ordem de leitura do banco.
 * Diferença deliberada do paper ao vivo, que processa na ordem de chegada pura (sem reordenar por slot).
 */
export function compareReplayEvents(a: ReplayEvent, b: ReplayEvent): number {
  if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
  if (a.receivedAtMs !== b.receivedAtMs) return a.receivedAtMs - b.receivedAtMs;
  if (a.recvSeq !== b.recvSeq) return a.recvSeq - b.recvSeq;
  if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
  const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (k !== 0) return k;
  return a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0;
}

/** Chave de duplicata (mesma linha gravada duas vezes): tipo + assinatura + índice do evento. */
export function eventKey(e: ReplayEvent): string {
  return `${e.kind}|${e.sig}|${String(e.eventIndex)}`;
}

/** Ordena e remove duplicatas exatas (mesma chave). Puro; não altera a entrada. */
export function sortAndDedupe(events: readonly ReplayEvent[]): { events: ReplayEvent[]; duplicates: number } {
  const seen = new Set<string>();
  const out: ReplayEvent[] = [];
  let duplicates = 0;
  for (const e of [...events].sort(compareReplayEvents)) {
    const k = eventKey(e);
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    out.push(e);
  }
  return { events: out, duplicates };
}
