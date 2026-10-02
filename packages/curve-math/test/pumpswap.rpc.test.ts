import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pumpSwapBuyExactBaseOut, pumpSwapBuyExactQuoteIn, pumpSwapSell } from '../src/pumpswap.ts';
import type { PumpSwapBuyResult, PumpSwapReserves, PumpSwapSellResult } from '../src/pumpswap.ts';

interface RpcTx {
  sig: string;
  slot: number;
  ixName: 'buy' | 'buy_exact_quote_in' | 'sell';
  eventFoundInTxLogs: boolean;
  event: {
    poolBaseTokenReserves: string;
    poolQuoteTokenReserves: string;
    virtualQuoteReserves: string;
    feeBps: { lp: string; protocol: string; creator: string; cashback: string };
    baseAmount: string;
    quoteAmount: string;
    userQuoteAmount: string;
  };
  vaultBalances: { basePre: string; basePost: string; quotePre: string; quotePost: string };
}

interface RpcFixture {
  pool: string;
  poolAccount: { owner: string; decoded: { virtual_quote_reserves: string } };
  txs: RpcTx[];
}

const fx = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pumpswap-rpc', 'vaults.json'), 'utf8'),
) as RpcFixture;

/**
 * Transações reais buscadas via RPC (`getTransaction`, `getAccountInfo` da conta `Pool`), ver
 * `fixtures/pumpswap-rpc/vaults.json`. Confirma, sem depender de continuidade entre eventos:
 * - reservas do evento = `preTokenBalances` das vaults da pool (estado ANTES do swap);
 * - `Pool.virtual_quote_reserves` (conta on-chain) = campo `virtual_quote_reserves` do evento;
 * - as reservas depois calculadas pelo modelo = `postTokenBalances` das vaults.
 */
describe('PumpSwap — vaults reais (RPC)', () => {
  it('a conta Pool pertence ao programa PumpSwap', () => {
    expect(fx.poolAccount.owner).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    expect(fx.txs.map((t) => t.ixName).sort()).toEqual(['buy', 'buy_exact_quote_in', 'sell']);
  });

  it.each(fx.txs)('$ixName $sig', (tx) => {
    expect(tx.eventFoundInTxLogs).toBe(true);
    expect(tx.event.poolBaseTokenReserves).toBe(tx.vaultBalances.basePre);
    expect(tx.event.poolQuoteTokenReserves).toBe(tx.vaultBalances.quotePre);
    expect(tx.event.virtualQuoteReserves).toBe(fx.poolAccount.decoded.virtual_quote_reserves);

    const r: PumpSwapReserves = {
      base: BigInt(tx.vaultBalances.basePre),
      quote: BigInt(tx.vaultBalances.quotePre),
      virtualQuote: BigInt(fx.poolAccount.decoded.virtual_quote_reserves),
    };
    const fees = {
      lpFeeBps: BigInt(tx.event.feeBps.lp),
      protocolFeeBps: BigInt(tx.event.feeBps.protocol),
      creatorFeeBps: BigInt(tx.event.feeBps.creator),
      cashbackFeeBps: BigInt(tx.event.feeBps.cashback),
    };
    let res: PumpSwapBuyResult | PumpSwapSellResult;
    if (tx.ixName === 'sell') res = pumpSwapSell(r, BigInt(tx.event.baseAmount), fees);
    else if (tx.ixName === 'buy') res = pumpSwapBuyExactBaseOut(r, BigInt(tx.event.baseAmount), fees);
    else res = pumpSwapBuyExactQuoteIn(r, BigInt(tx.event.quoteAmount), fees);

    expect(res.reservesAfter.base).toBe(BigInt(tx.vaultBalances.basePost));
    expect(res.reservesAfter.quote).toBe(BigInt(tx.vaultBalances.quotePost));
  });
});
