/**
 * Fixtures "golden" do PumpSwap para pools SEM criador (`Pool.coin_creator` = chave padrão
 * `11111111111111111111111111111111`). Roda manualmente — não faz parte de `pnpm check`.
 *
 * Uso:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     packages/curve-math/scripts/extract-pumpswap-no-creator-fixtures.ts
 *
 * Achado de 2026-10-03 (verificação em massa de 11.356.386 trades reais do PumpSwap contra
 * `src/pumpswap.ts`, todos os eventos com `pumpswap_trade_extra`): 148 divergências, 100% em eventos
 * com `coin_creator` = chave padrão, em que o evento traz `coin_creator_fee_basis_points` > 0 mas
 * `coin_creator_fee` = 0 — o programa não cobra a taxa do criador quando não há criador. Com o bps
 * efetivo do criador = 0 (`effectivePumpSwapFeeBps`), os 148 batem com 0 de diferença.
 * As assinaturas abaixo são eventos reais desse tipo (vendas e as duas instruções de compra); cada
 * fixture usa o próximo evento do mesmo pool como "reservas depois" (mesmo critério de continuidade
 * da base do extrator principal).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseContinuity, decode, query, toFixture } from './extract-pumpswap-fixtures.ts';
import type { Category, Ev, PumpSwapGoldenFixture, Row } from './extract-pumpswap-fixtures.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
const DEFAULT_PUBKEY = '11111111111111111111111111111111';

const SIGS = [
  // sell
  'aNCNdKjTw3vjxMG63ERQecaEuX7CaCwb5nVV1vVSXTDnDcfYXpC5xVcEJt5bbrCswKzCH8p186N3BkxcmKXPNJh',
  '3YZf5fZynpUYooysebY94auK1nMcRcANQ7kBh4k3bDSe9P6teKp5hfksaeQQ2Qmm9GjbVUP4zjRaPa9YfpFxxN3Q',
  'VodGVRwYXB7L8BxN2qFr1YPoULHsUgFY5uULkSFXihPpKiiYZpbDqdFdZY2MCyFr6JqLV9k7WxbjyH2QLabu2yE',
  '5BNK34TmZMWX9FSRcehw6N7JQrs3a7gcqFgvcLH31ik1ax8fmqfa118kaFQJRM9XahBBcfYUcxGtGkoGQLb26j4Q',
  '17ocHGbxibezLDwZFD7euo73xh4MySCWn7xG9qGUYDrDcBq3CuSQYZQEcGNQ8oRp6kWhFWagxJ4uHbQ8RogNKRH',
  '3X6EHSP1Q8jVw2MAjbXSoPMS7PLoixXkjCtg32ULGD5frNAg8QkGw8vAx64w9LofmTTKWWonNkW68AYeSw5zgneh',
  // buy_exact_quote_in
  '3a3JB6DwdcdwsD8TwXHjCCPf7e6HTkUXP4mkMZN9f15Aa8PYYusZrdvmckLWDVASDqN6ZGHhZW1Qg49RLUCSHtji',
  '4dzEsuMqRSiVUKM3Sh5Asa4qon3R6rJnTbQ1S56Ms3c637TKDnwodpP2BywqugQWA4nFDM33TNhqVa4SKW9vstx9',
  '4HiuTaZnU1JgWtGhPxtdhsc2eBcX1XkKWree7FU8xFmqgVDoswkgo9vQM5tcoT3gJvc3THLkBktrCE8gEpuBYAaN',
  '362ZY26Edmgckh3sp15CxEkjYxjiSKN979g3dWKmhyo2BPZe5hCjZ9hGQk5BgUS3GukJYVtJjvm3aLRZBj6NPqJM',
  '5PQigYXURsLsfRJf9PAsTaLdSVt533Rrgv7jgo315GuK48QKkD6oS3AV9krm4MAGRYGcQGkuDYHU4Nkemzzs6CMs',
  '3z25WxpK5ARwXosA6kb3QN83o6tgjYZiNJtyzkJwVLPNu7oTazGaC78oMWGcsRTX3xqcKjJKt7dQ6yxH6kRzm8ZX',
  // buy (base exata)
  '31n2QkbLZCEP3obhjCXfra4ZXxLNe9V69JoGU94xTHBAdwBNuMj9R4jc99hoixyXtSx9UNjRpG4XhKuDxp9atTK5',
  '4tRzCFb1RM75eAvv5gRVCmBqXY5mxeThd5VDwT2QpuCR75RdwJaQ89Z1iBvCUcpDThEHQijscaosQXqge47bmrYb',
  'VV9oritbomcUojCN7zMci13CFmRNdSwai67tQVW9PW7ptrhiKM5thewQAuNaBkqSbeLduJQR7AdHuNsSpcqS7Eu',
  '5zKBaPPbybrn4NgfYeqS1Rxupbb2NYUqndTkEs3W4XffRvAAdJ1RSb9SaQkfhsMZfDF7QScdReiPZYgCkHeMkcGZ',
  '3YtovSJygFgvzmU8s6GCm8w7pYpzTY2qGD8higbvVnuwL71EwkC5baMuV6auKKhG8Zz79ijfrjbkMqpdErJUEtbN',
  '6EwyUbHxg6ohCXwmmDXjjVEmsiR1XJXZcmADH4ieKGzi1TLU6cD3EQWcL1FLpf5LJwyBdJ6LAHXSSggXb8w992i',
];

export interface PumpSwapNoCreatorFixture extends PumpSwapGoldenFixture {
  coinCreator: string;
}

function main(): void {
  const out: PumpSwapNoCreatorFixture[] = [];
  for (const sig of SIGS) {
    const anchor = query(`SELECT pool, toString(slot) AS s, quote_mint, mint FROM events_trade WHERE sig='${sig}' AND venue='pumpswap' LIMIT 1`)[0] as
      | { pool: string; s: string; quote_mint: string; mint: string }
      | undefined;
    if (!anchor) {
      console.log(`${sig.slice(0, 10)}…: assinatura não encontrada`);
      continue;
    }
    const rows = query(
      `SELECT sig, event_index, toString(slot) AS slot, pool, raw_b64 FROM events_trade ` +
        `WHERE venue='pumpswap' AND raw_b64 != '' AND pool='${anchor.pool}' ` +
        `AND events_trade.slot >= ${anchor.s} ` +
        `ORDER BY events_trade.slot, recv_seq, event_index LIMIT 40`,
    ) as Row[];
    const evs = rows.map(decode).filter((e): e is Ev => e !== null);
    const i = evs.findIndex((e) => e.row.sig === sig && String(e.d.coin_creator) === DEFAULT_PUBKEY && e.d.coin_creator_fee === 0n);
    const cur = evs[i];
    const next = evs[i + 1];
    if (!cur || !next || !baseContinuity(cur, next)) {
      console.log(`${sig.slice(0, 10)}…: sem próximo evento contínuo, ignorado`);
      continue;
    }
    const category: Category = anchor.quote_mint === WSOL ? 'wsol' : anchor.mint === WSOL ? 'base-wsol' : 'other-quote';
    const fx = toFixture(cur, next, category);
    out.push({ ...fx, description: fx.description.replace('pumpswap ', 'pumpswap sem criador '), coinCreator: String(cur.d.coin_creator) });
  }
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'golden');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'pumpswap-no-creator.json'), JSON.stringify(out, null, 2) + '\n');
  const by = out.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.ixName]: (acc[f.ixName] ?? 0) + 1 }), {});
  console.log(`pumpswap sem criador: ${String(out.length)} fixtures gravadas ${JSON.stringify(by)}`);
}

main();
