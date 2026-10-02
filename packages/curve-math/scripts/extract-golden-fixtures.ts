/**
 * Script de extração de fixtures "golden" a partir de trades REAIS gravados em
 * `memebot.events_trade` (ClickHouse). Roda uma vez, manualmente — não faz parte
 * de `pnpm check` nem do build de produção.
 *
 * Uso:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     packages/curve-math/scripts/extract-golden-fixtures.ts
 *
 * Requer o container `memebot-clickhouse` rodando (docker compose up -d). As
 * credenciais do ClickHouse NUNCA são lidas/impressas aqui: a query roda via
 * `docker exec`, usando as env vars já definidas DENTRO do container
 * (CLICKHOUSE_USER / CLICKHOUSE_PASSWORD), nunca o `.env` do host.
 *
 * Formato de saída: array JSON `curve.json` (bonding curve, venue='curve'),
 * cada item é um par (trade anterior, trade atual) do MESMO mint, na ordem em
 * que aconteceram, o que dá o estado "antes" (reservas após o trade anterior)
 * e o resultado exato do trade atual. As fixtures do PumpSwap (`pumpswap.json`)
 * são geradas por `extract-pumpswap-fixtures.ts`.
 *
 * Curadoria aplicada (documentada aqui porque afeta quais trades aparecem):
 * - Só quote_mint em SOL_QUOTE_MINTS (config/protocol.ts) — é o único caso
 *   coberto pelo filtro `filters.allowedQuoteMints` da estratégia v0.
 * - Pump.fun tem uma conta `whitelist_pda` (ver Global.whitelist_pda em
 *   `protocol_config`) cujos trades saem com fee = 0 (isenção), o que não é
 *   a regra geral da curva — excluídos comparando a taxa observada com a
 *   esperada pelos bps padrão (95 protocolo / 30 criador, lidos de
 *   `protocol_config` FeeConfig da Pump.fun em 2026-09-29).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTAINER = 'memebot-clickhouse';
const DATABASE = 'memebot';
const CURVE_PROTOCOL_FEE_BPS = 95n;
const CURVE_CREATOR_FEE_BPS = 30n;
const SOL_QUOTE_MINTS = ['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112'];

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Executa uma query no ClickHouse via docker exec, sem nunca passar a senha pela nossa linha de comando. */
function query(sql: string): unknown[] {
  // As credenciais ficam só dentro do container (env do docker-compose), lidas pelo próprio
  // clickhouse-client via $CLICKHOUSE_USER/$CLICKHOUSE_PASSWORD — nunca aparecem neste processo.
  const shCmd = `clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database ${DATABASE} --query "${sql.replace(/"/g, '\\"')}" --format JSONEachRow`;
  const out = execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', shCmd], {
    maxBuffer: 1024 * 1024 * 256,
    encoding: 'utf8',
  });
  const lines = out.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as unknown);
}

interface CurveRow {
  mint: string;
  slot: string;
  recv_seq: string;
  side: 'buy' | 'sell';
  quote_amount: string;
  token_amount: string;
  virtual_quote_reserves: string;
  virtual_token_reserves: string;
  real_quote_reserves: string;
  real_token_reserves: string;
  protocol_fee: string;
  creator_fee: string;
  ix_name: string;
}

interface CurveFixture {
  description: string;
  before: { virtualQuote: string; virtualToken: string };
  trade: { side: 'buy' | 'sell'; quoteAmount: string; tokenAmount: string; ixName: string };
  after: { virtualQuote: string; virtualToken: string; realQuote: string; realToken: string };
  fees: { protocolFee: string; creatorFee: string };
}

function extractCurveFixtures(limit: number): CurveFixture[] {
  const quoteList = SOL_QUOTE_MINTS.map((m) => `'${m}'`).join(',');
  // Importante: `recv_seq` só é cronológico DENTRO de uma mesma sessão de ingestão (reinicia a
  // cada restart do bot); comparar recv_seq entre sessões deu pares de trades fora de ordem e
  // reservas inconsistentes num teste manual. `slot` é o relógio real da chain — ordenamos por
  // ele primeiro e usamos recv_seq só como tiebreaker dentro do mesmo slot.
  const rows = query(
    `SELECT mint, slot, recv_seq, side, quote_amount, token_amount, virtual_quote_reserves, virtual_token_reserves, ` +
      `real_quote_reserves, real_token_reserves, protocol_fee, creator_fee, ix_name ` +
      `FROM events_trade WHERE venue='curve' AND quote_mint IN (${quoteList}) ` +
      `AND virtual_quote_reserves IS NOT NULL ORDER BY mint, slot, recv_seq LIMIT 400000`,
  ) as CurveRow[];

  const byMint = new Map<string, CurveRow[]>();
  for (const r of rows) {
    const list = byMint.get(r.mint) ?? [];
    list.push(r);
    byMint.set(r.mint, list);
  }

  let skippedFeeMismatch = 0;
  let skippedReserveMismatch = 0;
  const fixtures: CurveFixture[] = [];
  for (const [, list] of byMint) {
    for (let i = 1; i < list.length && fixtures.length < limit; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (!prev || !cur) continue;
      const quoteAmount = BigInt(cur.quote_amount);
      const expectedProtocolFee = ceilDiv(quoteAmount * CURVE_PROTOCOL_FEE_BPS, 10000n);
      const expectedCreatorFee = ceilDiv(quoteAmount * CURVE_CREATOR_FEE_BPS, 10000n);
      // Exclui trades isentos (whitelist_pda) ou com bps fora do padrão lido em protocol_config.
      if (BigInt(cur.protocol_fee) !== expectedProtocolFee || BigInt(cur.creator_fee) !== expectedCreatorFee) {
        skippedFeeMismatch++;
        continue;
      }
      // Autoverificação: aplica a própria fórmula da curva (constant product, ceiling) usando
      // `prev` como reservas "antes" e exige bater com o resultado real gravado em `cur`. Isso
      // descarta pares cuja ordem (slot, recv_seq) não reflete a sequência real de trades do
      // mint — p.ex. se houver outro trade do mesmo mint fora do filtro de quote_mint entre eles.
      const vQb = BigInt(prev.virtual_quote_reserves);
      const vTb = BigInt(prev.virtual_token_reserves);
      const k = vQb * vTb;
      let predictedQuoteAmount: bigint;
      let predictedTokenAmount: bigint;
      let predictedVQ: bigint;
      let predictedVT: bigint;
      if (cur.side === 'buy') {
        predictedVQ = vQb + quoteAmount;
        predictedVT = ceilDiv(k, predictedVQ);
        predictedTokenAmount = vTb - predictedVT;
        predictedQuoteAmount = quoteAmount;
      } else {
        predictedVT = vTb + BigInt(cur.token_amount);
        predictedVQ = ceilDiv(k, predictedVT);
        predictedQuoteAmount = vQb - predictedVQ;
        predictedTokenAmount = BigInt(cur.token_amount);
      }
      const matches =
        predictedQuoteAmount === quoteAmount &&
        predictedTokenAmount === BigInt(cur.token_amount) &&
        predictedVQ === BigInt(cur.virtual_quote_reserves) &&
        predictedVT === BigInt(cur.virtual_token_reserves);
      if (!matches) {
        skippedReserveMismatch++;
        continue;
      }
      fixtures.push({
        description: `curve trade real: mint=${cur.mint.slice(0, 8)}… recv_seq=${cur.recv_seq}`,
        before: { virtualQuote: prev.virtual_quote_reserves, virtualToken: prev.virtual_token_reserves },
        trade: { side: cur.side, quoteAmount: cur.quote_amount, tokenAmount: cur.token_amount, ixName: cur.ix_name },
        after: {
          virtualQuote: cur.virtual_quote_reserves,
          virtualToken: cur.virtual_token_reserves,
          realQuote: cur.real_quote_reserves,
          realToken: cur.real_token_reserves,
        },
        fees: { protocolFee: cur.protocol_fee, creatorFee: cur.creator_fee },
      });
    }
    if (fixtures.length >= limit) break;
  }
  console.log(
    `curve: ${String(fixtures.length)} fixtures ok, ${String(skippedFeeMismatch)} descartados por taxa fora do padrão, ` +
      `${String(skippedReserveMismatch)} descartados por ordem/reservas inconsistentes`,
  );
  return fixtures;
}

function main(): void {
  const curve = extractCurveFixtures(120);

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'golden');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'curve.json'), JSON.stringify(curve, null, 2) + '\n');
  console.log(`curve: ${String(curve.length)} fixtures`);
}

main();
