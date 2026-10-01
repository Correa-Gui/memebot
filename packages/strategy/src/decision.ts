/**
 * Decisão produzida por `evaluate` (`packages/strategy`, Fase 3/parte A).
 *
 * Divergência deliberada do `Decision` completo descrito em `docs/ARCHITECTURE.md` §4: aquele
 * tipo tem variantes `enter`/`exit`/`reject` com `decisionId`, `sizeLamports`, `maxSlippageBps`
 * — campos de sizing/risco que pertencem a `packages/risk` e `packages/positions` ("parte B" da
 * Fase 3, fora do escopo desta tarefa). Aqui ficam só as duas variantes que `packages/features` +
 * os filtros/gatilho de `docs/STRATEGY.md` §3/§4 conseguem produzir sozinhos: `reject` (motivo =
 * exatamente o nome do filtro de `config/strategy.v0.yaml` que falhou, nunca um texto genérico —
 * pedido explícito, para o relatório de paper trading poder contar quantos tokens cada filtro
 * barrou) e `enter` (com o snapshot de features usado na decisão, igual ao campo `features` do
 * `Decision` de `ARCHITECTURE.md`). Quando `packages/risk`/`packages/positions` existirem, dará
 * para unificar ou mapear este tipo para o completo sem quebrar os testes daqui.
 */
export interface RejectDecision {
  outcome: 'reject';
  mint: string;
  /** Nome do filtro/condição que reprovou (chave de `config/strategy.v0.yaml`), ex.: 'maxTop10PctSupply'. */
  reason: string;
}

export interface EnterDecision {
  outcome: 'enter';
  mint: string;
  /** Sempre 'momentum_trigger' na v0: passou em todos os filtros duros e no gatilho de §4. */
  reason: string;
  /** Snapshot das features usadas na decisão (CLAUDE.md §6: toda decisão é logada com suas features). */
  features: Record<string, number>;
}

export type Decision = RejectDecision | EnterDecision;
