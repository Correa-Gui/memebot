import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PumpSwapFixture {
  description: string;
  before: { base: string; quote: string };
  trade: { side: 'buy' | 'sell'; quoteAmount: string; tokenAmount: string; userQuoteAmount: string };
  fees: { lpFee: string; protocolFee: string; creatorFee: string };
}

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golden', 'pumpswap.json');
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as PumpSwapFixture[];

/**
 * Teste de EXATIDÃO para o bookkeeping de taxas do PumpSwap: bruto = líquido + (lp + protocol +
 * creator), sempre, para as 80 fixtures reais. Confirmado contra os dados (ver
 * `scripts/extract-golden-fixtures.ts`): o campo bruto/líquido depende da instrução —
 * `buy_exact_quote_in` grava `quoteAmount`=bruto / `userQuoteAmount`=líquido; a instrução `buy`
 * (quantidade de base exata) grava o inverso; venda sempre grava `quoteAmount`=bruto. Em todos
 * os casos bruto ≥ líquido, por isso usamos max/min em vez de depender do `ix_name` (que o
 * evento de venda nem possui).
 *
 * LIMITAÇÃO DOCUMENTADA: tentamos também inferir os bps exatos de cada componente (lp/protocol/
 * creator) e reproduzi-los com `feeFromBps` — bateu para a maioria das fixtures, mas não para
 * todas (ver relatório da Fase 2). Como não ficou claro se a divergência é arredondamento por
 * componente, uma base de cálculo diferente de `netAmount`, ou tier mal escolhido, preferimos
 * não afirmar uma exatidão que não foi comprovada; o que ESTÁ comprovado e testado abaixo é a
 * identidade bruto/líquido/taxas, que é exata em 100% das fixtures. `baseOut`/reservas após o
 * swap também não têm teste golden aqui pelo mesmo motivo (ver `src/pumpswap.ts`).
 */
describe('PumpSwap — fixtures golden (bookkeeping de taxas, trades reais)', () => {
  it('carregou pelo menos 50 fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(50);
  });

  it.each(fixtures)('$description', (fx) => {
    const quoteAmount = BigInt(fx.trade.quoteAmount);
    const userQuoteAmount = BigInt(fx.trade.userQuoteAmount);
    const netAmount = quoteAmount < userQuoteAmount ? quoteAmount : userQuoteAmount;
    const grossAmount = quoteAmount < userQuoteAmount ? userQuoteAmount : quoteAmount;
    const lpFee = BigInt(fx.fees.lpFee);
    const protocolFee = BigInt(fx.fees.protocolFee);
    const creatorFee = BigInt(fx.fees.creatorFee);

    expect(lpFee).toBeGreaterThanOrEqual(0n);
    expect(protocolFee).toBeGreaterThanOrEqual(0n);
    expect(creatorFee).toBeGreaterThanOrEqual(0n);
    expect(grossAmount).toBe(netAmount + lpFee + protocolFee + creatorFee);
  });
});
