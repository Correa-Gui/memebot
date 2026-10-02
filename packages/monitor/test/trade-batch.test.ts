import { describe, expect, it } from 'vitest';
import { formatTradeBatchSummary } from '../src/index.ts';

describe('formatTradeBatchSummary', () => {
  it('shows profit, loss, net result, proportional bars, and escapes token symbols', () => {
    const chart = formatTradeBatchSummary({
      mode: 'paper', firstOperation: 1, lastOperation: 10,
      trades: [
        { symbol: 'WIN', pnlLamports: 10_000_000n },
        { symbol: 'LOSS', pnlLamports: -20_000_000n },
        ...Array.from({ length: 8 }, (_, index) => ({
          symbol: index === 0 ? '<bad&token>' : `T${String(index)}`,
          pnlLamports: index < 3 ? 5_000_000n : -2_000_000n,
        })),
      ],
    });
    expect(chart.text).toContain('<b>\u{1F4CA} PnL \u00b7 OPERA\u00c7\u00d5ES 1\u201310 [paper]</b>');
    expect(chart.text).toContain('\u2022 <b>Lucros:</b> 4 opera\u00e7\u00f5es \u00b7 +0,0250 SOL');
    expect(chart.text).toContain('\u2022 <b>Preju\u00edzos:</b> 6 opera\u00e7\u00f5es \u00b7 -0,0300 SOL');
    expect(chart.text).toContain('\u2022 <b>Saldo l\u00edquido:</b> -0,0050 SOL');
    expect(chart.text).toContain('01 \u{1F7E9}\u{1F7E9}\u{1F7E9}\u{1F7E9}\u{1F7E9} +0,0100 SOL \u00b7 WIN');
    expect(chart.text).toContain('02 \u{1F7E5}'.repeat(1) + '\u{1F7E5}'.repeat(9) + ' -0,0200 SOL \u00b7 LOSS');
    expect(chart.text).toContain('&lt;bad&amp;token&gt;');
  });
});
