/**
 * Extrai fixtures "golden" do PumpSwap a partir de trades REAIS gravados em
 * `memebot.events_trade` (ClickHouse). Roda manualmente — não faz parte de `pnpm check`.
 *
 * Uso:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     packages/curve-math/scripts/extract-pumpswap-fixtures.ts
 *
 * Requer o container `memebot-clickhouse` rodando. Credenciais nunca passam por este processo:
 * a query roda via `docker exec`, com as env vars já definidas DENTRO do container.
 *
 * Fonte da verdade de cada fixture: o evento `BuyEvent`/`SellEvent` original (`raw_b64`, a linha
 * `Program data:` do log), decodificado com o IDL oficial `packages/ingest/src/idl/pump_amm.json`.
 * Usamos o evento bruto (e não as colunas normalizadas) porque ele traz campos que o normalize
 * ainda não grava: `virtual_quote_reserves`, `cashback*`, os bps de cada taxa e `ix_name`.
 *
 * "Reservas depois" = reservas reportadas pelo PRÓXIMO evento do mesmo pool. Para não confundir
 * ordem dentro do slot, o par só é aceito se a base fechar exatamente
 * (`base_depois = base_antes ∓ base do trade`) — critério que não usa a fórmula sob teste.
 *
 * Curadoria: pools de três categorias — quote WSOL (`wsol`), base WSOL (`base-wsol`) e quote
 * ≠ WSOL (`other-quote`) — no máximo 3 fixtures por pool, cotas por instrução (`buy`,
 * `buy_exact_quote_in`, `sell`), e todos os eventos com cashback > 0 encontrados.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUMP_AMM_IDL } from '../../ingest/src/idl.ts';

const CONTAINER = 'memebot-clickhouse';
const DATABASE = 'memebot';
const WSOL = 'So11111111111111111111111111111111111111112';
const PER_POOL = 3;
const PER_KIND_PER_CATEGORY = 10;
const MAX_CASHBACK_PER_CATEGORY = 6;

type Category = 'wsol' | 'base-wsol' | 'other-quote';
type Kind = 'buy' | 'buy_exact_quote_in' | 'sell';

function query(sql: string): unknown[] {
  const shCmd = `clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database ${DATABASE} --format JSONEachRow`;
  const out = execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', shCmd], {
    input: sql,
    maxBuffer: 1024 * 1024 * 512,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

interface Row {
  sig: string;
  event_index: number;
  slot: string;
  pool: string;
  raw_b64: string;
}

interface Ev {
  row: Row;
  kind: Kind;
  d: Record<string, unknown>;
}

function big(d: Record<string, unknown>, k: string): bigint {
  const v = d[k];
  if (typeof v !== 'bigint') throw new Error(`campo ${k} não é inteiro`);
  return v;
}

function decode(row: Row): Ev | null {
  const ev = PUMP_AMM_IDL.decodeEvent(Buffer.from(row.raw_b64, 'base64'));
  if (!ev || (ev.name !== 'BuyEvent' && ev.name !== 'SellEvent')) return null;
  const d = ev.data as Record<string, unknown>;
  let kind: Kind;
  if (ev.name === 'SellEvent') kind = 'sell';
  else if (d.ix_name === 'buy' || d.ix_name === 'buy_exact_quote_in') kind = d.ix_name;
  else return null;
  return { row, kind, d };
}

export interface PumpSwapGoldenFixture {
  description: string;
  source: { sig: string; eventIndex: number; slot: string; pool: string; eventRawB64: string };
  category: Category;
  ixName: Kind;
  before: { base: string; quote: string; virtualQuote: string };
  feeBps: { lp: string; protocol: string; creator: string; cashback: string };
  /** Campos do evento, com os nomes do IDL. */
  event: {
    baseAmount: string;
    quoteAmount: string;
    userQuoteAmount: string;
    lpFee: string;
    protocolFee: string;
    creatorFee: string;
    cashback: string;
  };
  /** Reservas reportadas pelo próximo evento do mesmo pool (estado depois deste trade). */
  after: { base: string; quote: string };
}

function toFixture(cur: Ev, next: Ev, category: Category): PumpSwapGoldenFixture {
  const d = cur.d;
  const isSell = cur.kind === 'sell';
  const s = (k: string): string => big(d, k).toString();
  return {
    description: `pumpswap ${cur.kind} real: pool=${cur.row.pool.slice(0, 8)}… sig=${cur.row.sig.slice(0, 10)}…`,
    source: { sig: cur.row.sig, eventIndex: cur.row.event_index, slot: cur.row.slot, pool: cur.row.pool, eventRawB64: cur.row.raw_b64 },
    category,
    ixName: cur.kind,
    before: { base: s('pool_base_token_reserves'), quote: s('pool_quote_token_reserves'), virtualQuote: s('virtual_quote_reserves') },
    feeBps: {
      lp: s('lp_fee_basis_points'),
      protocol: s('protocol_fee_basis_points'),
      creator: s('coin_creator_fee_basis_points'),
      cashback: s('cashback_fee_basis_points'),
    },
    event: {
      baseAmount: s(isSell ? 'base_amount_in' : 'base_amount_out'),
      quoteAmount: s(isSell ? 'quote_amount_out' : 'quote_amount_in'),
      userQuoteAmount: s(isSell ? 'user_quote_amount_out' : 'user_quote_amount_in'),
      lpFee: s('lp_fee'),
      protocolFee: s('protocol_fee'),
      creatorFee: s('coin_creator_fee'),
      cashback: s('cashback'),
    },
    after: { base: big(next.d, 'pool_base_token_reserves').toString(), quote: big(next.d, 'pool_quote_token_reserves').toString() },
  };
}

function baseContinuity(cur: Ev, next: Ev): boolean {
  const b0 = big(cur.d, 'pool_base_token_reserves');
  const b1 = big(next.d, 'pool_base_token_reserves');
  return cur.kind === 'sell' ? b1 === b0 + big(cur.d, 'base_amount_in') : b1 === b0 - big(cur.d, 'base_amount_out');
}

const CATEGORY_FILTER: Record<Category, string> = {
  wsol: `quote_mint = '${WSOL}'`,
  'base-wsol': `mint = '${WSOL}'`,
  'other-quote': `quote_mint NOT IN ('${WSOL}', '') AND mint != '${WSOL}'`,
};

function extract(category: Category, poolCount: number): PumpSwapGoldenFixture[] {
  const filter = CATEGORY_FILTER[category];
  const rows = query(
    `SELECT sig, event_index, toString(slot) AS slot, pool, raw_b64 FROM events_trade ` +
      `WHERE venue='pumpswap' AND raw_b64 != '' AND pool IN (` +
      `SELECT pool FROM events_trade WHERE venue='pumpswap' AND raw_b64 != '' AND ${filter} ` +
      `GROUP BY pool HAVING count() >= 30 ORDER BY cityHash64(pool) LIMIT ${String(poolCount)}) ` +
      `ORDER BY pool, events_trade.slot, recv_seq, event_index LIMIT 400 BY pool`,
  ) as Row[];

  const quota = new Map<string, number>();
  const perPool = new Map<string, number>();
  const out: PumpSwapGoldenFixture[] = [];
  let cashbackCount = 0;
  let prev: Ev | null = null;
  for (const row of rows) {
    const cur = decode(row);
    if (!cur) continue;
    if (prev && prev.row.pool === cur.row.pool && baseContinuity(prev, cur)) {
      const takeCashback = big(prev.d, 'cashback') > 0n && cashbackCount < MAX_CASHBACK_PER_CATEGORY;
      const qk = prev.kind;
      const used = quota.get(qk) ?? 0;
      const usedPool = perPool.get(prev.row.pool) ?? 0;
      if (takeCashback || (used < PER_KIND_PER_CATEGORY && usedPool < PER_POOL)) {
        out.push(toFixture(prev, cur, category));
        quota.set(qk, used + 1);
        perPool.set(prev.row.pool, usedPool + 1);
        if (takeCashback) cashbackCount++;
      }
    }
    prev = cur;
  }
  console.log(`${category}: ${String(rows.length)} eventos lidos, ${String(out.length)} fixtures (${JSON.stringify(Object.fromEntries(quota))}, cashback=${String(cashbackCount)})`);
  return out;
}

/**
 * Casos de borda de `buy_exact_quote_in` achados na análise (taxas de `n0` exatas, sem
 * arredondar, e `user_quote_amount_in + taxas = spendable - 1`). Raros (6 em ~7.700 eventos), por
 * isso buscados pela assinatura. Cada um vira fixture com o próximo evento do mesmo pool.
 */
const EDGE_SIGS = [
  '32HZUobydq2FjjQU4rchjQFH1hLD4TQnAoPJ7VwTUFsYawvpA9AfazoT4aDXAz7XHyMRSqQFEAL6AJp4Db6PSaRA',
  '3oCdje1Fy9gwJAm8eJtnK9VhLG6YbeXgTLcVmDx9C43oD49ZCYQLKYaWwttb4bx6t7xya93pQDxnJsKo6ofb1H51',
  '26FQbDriu6kftjmLVsJyKccDoyCBK8JXMZVssocjn8KGAPCQvnt6P1Lxde8daFoxBjRpEbuUzDyx5qPEWTyinG6j',
];

function extractEdgeCases(): PumpSwapGoldenFixture[] {
  const out: PumpSwapGoldenFixture[] = [];
  for (const sig of EDGE_SIGS) {
    const anchor = query(`SELECT pool, toString(slot) AS s FROM events_trade WHERE sig='${sig}' LIMIT 1`)[0] as
      | { pool: string; s: string }
      | undefined;
    if (!anchor) {
      console.log(`borda ${sig.slice(0, 10)}…: assinatura não encontrada no banco`);
      continue;
    }
    const rows = query(
      `SELECT sig, event_index, toString(slot) AS slot, pool, raw_b64 FROM events_trade ` +
        `WHERE venue='pumpswap' AND raw_b64 != '' AND pool='${anchor.pool}' ` +
        `AND events_trade.slot >= ${anchor.s} AND events_trade.slot < ${anchor.s} + 300 ` +
        `ORDER BY events_trade.slot, recv_seq, event_index`,
    ) as Row[];
    const evs = rows.map(decode).filter((e): e is Ev => e !== null);
    const i = evs.findIndex((e) => e.row.sig === sig);
    const cur = evs[i];
    const next = evs[i + 1];
    if (cur && next && baseContinuity(cur, next)) out.push(toFixture(cur, next, 'wsol'));
    else console.log(`borda ${sig.slice(0, 10)}…: sem próximo evento contínuo, ignorado`);
  }
  console.log(`borda buy_exact_quote_in: ${String(out.length)} fixtures`);
  return out;
}

function main(): void {
  const fixtures = [...extract('wsol', 30), ...extract('base-wsol', 10), ...extract('other-quote', 15), ...extractEdgeCases()];
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'golden');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'pumpswap.json'), JSON.stringify(fixtures, null, 2) + '\n');
  console.log(`pumpswap: ${String(fixtures.length)} fixtures gravadas`);
}

main();
