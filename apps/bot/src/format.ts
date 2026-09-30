import type { PumpEvent } from '@memebot/core';

const SOL = 1_000_000_000n;

/** Lamports → "1.234567890" sem passar por float. */
export function formatLamports(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}${String(a / SOL)}.${(a % SOL).toString().padStart(9, '0')}`;
}

/** Linha legível de um evento para conferência manual no Solscan (modo --debug-events). */
export function describeEvent(e: PumpEvent, index: number): string {
  const link = `https://solscan.io/tx/${e.sig}`;
  const head = `#${String(index).padStart(2, '0')} slot=${String(e.slot)}`;
  switch (e.kind) {
    case 'token_created':
      return `${head} TOKEN_CREATED ${e.symbol} "${e.name}" mint=${e.mint} creator=${e.creator} quote=${e.quoteMint}\n    ${link}`;
    case 'trade': {
      const where = e.venue === 'pumpswap' ? `pumpswap pool=${e.pool}` : 'curve';
      return `${head} TRADE ${e.side.toUpperCase()} ${where} mint=${e.mint || '(pool não resolvida)'} trader=${e.trader} tokens=${String(e.tokenAmount)} quote=${formatLamports(e.quoteAmount)} (${e.quoteMint}) ix=${e.ixName ?? '-'}\n    ${link}`;
    }
    case 'curve_completed':
      return `${head} CURVE_COMPLETED mint=${e.mint}\n    ${link}`;
    case 'pool_created':
      return `${head} POOL_CREATED pool=${e.pool} base=${e.mint} quote=${e.quoteMint}\n    ${link}`;
    case 'tx_cost':
      return `${head} TX_COST fee=${formatLamports(e.feeLamports)} priority=${formatLamports(e.priorityFee)} jito=${e.jitoTip === null ? '?' : formatLamports(e.jitoTip)} cu=${String(e.computeUnits ?? '?')}\n    ${link}`;
  }
}
