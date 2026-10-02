import { Writable } from 'node:stream';
import { createLogger } from '@memebot/core';
import { describe, expect, it } from 'vitest';
import { TelegramNotifier, formatAlertMessage, formatEntryAlert, formatExitAlert, formatHourlySummary, formatSol, redactToken } from '../src/index.ts';

const TOKEN = '123456:SEGREDO-abc_DEF';

function capturingLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    destination: new Writable({
      write: (chunk: Buffer, _e, cb) => {
        lines.push(chunk.toString());
        cb();
      },
    }),
  });
  return { logger, lines };
}

const noSleep = (): Promise<void> => Promise.resolve();

function ok(): Response {
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
}

function bodyOf(init: RequestInit | undefined): { chat_id?: string; text?: string; parse_mode?: string; disable_web_page_preview?: boolean; reply_markup?: unknown } {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { chat_id?: string; text?: string; parse_mode?: string; disable_web_page_preview?: boolean; reply_markup?: unknown };
}

describe('TelegramNotifier', () => {
  it('sem token/chat: desligado, avisa no log e não chama fetch', () => {
    const { logger, lines } = capturingLogger();
    let calls = 0;
    const n = new TelegramNotifier({
      botToken: '', chatId: '', logger,
      fetchFn: () => {
        calls++;
        return Promise.resolve(ok());
      },
    });
    n.send('oi');
    expect(n.enabled).toBe(false);
    expect(calls).toBe(0);
    expect(lines.join('')).toMatch(/Telegram desligado/);
  });

  it('envia sendMessage com chat_id e texto', async () => {
    const { logger } = capturingLogger();
    const reqs: { url: string; body: { chat_id?: string; text?: string } }[] = [];
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, sleep: noSleep,
      fetchFn: (url, init) => {
        reqs.push({ url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, body: bodyOf(init) });
        return Promise.resolve(ok());
      },
    });
    n.send({ text: '<b>olá</b>', reply_markup: { inline_keyboard: [[{ text: 'Pump.fun', url: 'https://pump.fun/coin/mint' }, { text: 'Solscan', url: 'https://solscan.io/token/mint' }]] } });
    await n.close(1_000);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(reqs[0]?.body).toMatchObject({
      chat_id: '42', text: '<b>olá</b>', parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: 'Pump.fun', url: 'https://pump.fun/coin/mint' }, { text: 'Solscan', url: 'https://solscan.io/token/mint' }]] },
    });
    expect(n.stats).toEqual({ sent: 1, failed: 0, dropped: 0 });
  });

  it('retry com backoff em erro de rede/5xx e respeita retry_after do 429', async () => {
    const { logger } = capturingLogger();
    const sleeps: number[] = [];
    const responses: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error('ECONNRESET')),
      () => Promise.resolve(new Response('{"ok":false}', { status: 502 })),
      () => Promise.resolve(new Response(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }), { status: 429 })),
      () => Promise.resolve(ok()),
    ];
    let i = 0;
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, maxRetries: 3, baseBackoffMs: 100,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      fetchFn: () => (responses[i++] ?? (() => Promise.resolve(ok())))(),
    });
    n.send('x');
    await n.close(1_000);
    expect(n.stats.sent).toBe(1);
    expect(sleeps).toEqual([100, 200, 2_000]);
  });

  it('falha definitiva: não lança, conta, e o log NUNCA contém o token (nem pela URL no erro do fetch)', async () => {
    const { logger, lines } = capturingLogger();
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, maxRetries: 1, sleep: noSleep,
      fetchFn: (url) => Promise.reject(new Error(`fetch failed for ${typeof url === 'string' ? url : url instanceof URL ? url.href : url.url}`)),
    });
    expect(() => {
      n.send('x');
    }).not.toThrow();
    await n.close(1_000);
    expect(n.stats.failed).toBe(1);
    const log = lines.join('');
    expect(log).toMatch(/falha ao enviar alerta/);
    expect(log).not.toContain('SEGREDO');
  });

  it('4xx não é repetido', async () => {
    const { logger } = capturingLogger();
    let calls = 0;
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, sleep: noSleep,
      fetchFn: () => {
        calls++;
        return Promise.resolve(new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }));
      },
    });
    n.send('x');
    await n.close(1_000);
    expect(calls).toBe(1);
    expect(n.stats.failed).toBe(1);
  });

  it('fila limitada: descarta as mais antigas e conta', async () => {
    const { logger } = capturingLogger();
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const n = new TelegramNotifier({
      botToken: TOKEN, chatId: '42', logger, maxQueue: 2, sleep: noSleep,
      fetchFn: async (_u, init) => {
        await gate;
        sent.push(bodyOf(init).text ?? '');
        return ok();
      },
    });
    for (const t of ['a', 'b', 'c', 'd', 'e']) n.send(t);
    release();
    await n.close(1_000);
    expect(n.stats.dropped).toBe(2);
    expect(sent).toEqual(['a', 'd', 'e']);
  });

  it('redactToken remove o token e padrões bot<id>:<segredo>', () => {
    expect(redactToken(`x https://api.telegram.org/bot${TOKEN}/sendMessage`, TOKEN)).not.toContain('SEGREDO');
    expect(redactToken('bot987:outro-segredo', '')).toBe('bot[REDACTED]');
  });
});

describe('mensagens', () => {
  it('formatSol arredonda sem float, com quatro casas e vírgula', () => {
    expect(formatSol(50_000_000n)).toBe('0,0500 SOL');
    expect(formatSol(-1_234_567_890n)).toBe('-1,2346 SOL');
  });

  const mint = '7ZyApMyXTsiCCC9kESbFCPgk2m6nBksDvKGybRRZpump';

  it('compra: cabeçalho, custo, rent, idade, preço compacto, escape HTML e botões', () => {
    const entry = formatEntryAlert({
      mint, symbol: '<A&B>', name: 'token <script> & nome', priceLamportsPerUnit: 0.0000959, sizeLamports: 50_000_000n,
      curveFeeLamports: 500_000n, priorityFeeLamports: 100_000n, jitoTipLamports: 200_000n, baseFeeLamports: 5_000n,
      rentLamports: 1_513_840n, tokenAgeMs: 65_000, mode: 'paper',
    });
    expect(entry.text).toContain('<b>🟢 COMPRA · &lt;A&amp;B&gt; [paper]</b>');
    expect(entry.text).toContain('<b>Mint:</b> <code>7ZyA…RRZpump</code>');
    expect(entry.text).toContain('<b>Nome:</b> <code>token &lt;script&gt; &amp; nome</code>');
    expect(entry.text).toContain('<b>ENTRADA</b>');
    expect(entry.text).toContain('• <b>Tamanho:</b> 0,0500 SOL');
    expect(entry.text).toContain('• <b>Preço:</b> 0,0₇959 SOL/token');
    expect(entry.text).toContain('• <b>Idade do token:</b> 1m 5s');
    expect(entry.text).toContain('<b>CUSTOS</b>');
    expect(entry.text).toContain('• <b>Compra:</b> 0,0008 SOL (1,6% do tamanho)');
    expect(entry.text).toContain('• <b>Rent:</b> 0,0015 SOL (volta ao fechar)');
    expect(entry.text).not.toContain('https://');
    expect(entry.reply_markup?.inline_keyboard[0]).toEqual([
      { text: 'Pump.fun', url: `https://pump.fun/coin/${mint}` },
      { text: 'Solscan', url: `https://solscan.io/token/${mint}` },
    ]);
  });

  it('venda com prejuízo e stop: motivo traduzido, fração/tempo, PnL e aviso acima de 1,5×', () => {
    const exit = formatExitAlert({
      mint, symbol: 'AYT', name: 'AYT & name', reason: 'stop_loss', fraction: 1, remainingFraction: 0,
      priceLamportsPerUnit: 0.0000484, pnlLamports: -24_300_000n, pnlRatio: -0.486,
      closed: true, operationPnlLamports: -24_300_000n, operationPnlRatio: -0.486, heldMs: 5_688, stopLossPct: 0.2, mode: 'paper',
    });
    expect(exit.text).toContain('<b>🔴 VENDA (prejuízo) · AYT [paper]</b>');
    expect(exit.text).toContain('<b>Mint:</b> <code>7ZyA…RRZpump</code>');
    expect(exit.text).toContain('• <b>Motivo:</b> stop loss');
    expect(exit.text).toContain('• <b>PnL desta venda:</b> -0,0243 SOL (-48,6%)');
    expect(exit.text).toContain('• <b>Vendida agora:</b> 100,0% da posição atual');
    expect(exit.text).toContain('• <b>Restante:</b> 0,0% da posição inicial');
    expect(exit.text).toContain('• <b>Tempo:</b> 5s');
    expect(exit.text).toContain('<b>RESULTADO TOTAL DA OPERAÇÃO</b>');
    expect(exit.text).toContain('⚠️ <b>Perda acima de 1,5× o stop:</b> configurado 20,0%; resultado -48,6%.');
    expect(exit.text).toContain('<b>Nome:</b> <code>AYT &amp; name</code>');
  });

  it('venda parcial e venda lucrativa usam cabeçalhos próprios e motivos em português', () => {
    const partial = formatExitAlert({
      mint, symbol: 'AYT', name: null, reason: 'take_profit_1', fraction: 0.5, remainingFraction: 0.5,
      priceLamportsPerUnit: 0.0002, pnlLamports: 5_000_000n, pnlRatio: 0.2, closed: false,
      operationPnlLamports: null, operationPnlRatio: null, heldMs: 61_000, stopLossPct: 0.2, mode: 'paper',
    });
    expect(partial.text).toContain('<b>🟡 VENDA PARCIAL · AYT [paper]</b>');
    expect(partial.text).toContain('• <b>Motivo:</b> alvo 1');
    expect(partial.text).toContain('• <b>Vendida agora:</b> 50,0% da posição atual');
    expect(partial.text).toContain('• <b>Restante:</b> 50,0% da posição inicial');

    const profit = formatExitAlert({
      mint, symbol: 'AYT', name: null, reason: 'take_profit_2', fraction: 1, remainingFraction: 0,
      priceLamportsPerUnit: 0.0003, pnlLamports: 50_000_000n, pnlRatio: 1, closed: true,
      operationPnlLamports: 50_000_000n, operationPnlRatio: 1, heldMs: 121_000, stopLossPct: 0.2, mode: 'paper',
    });
    expect(profit.text).toContain('<b>🟢 VENDA (lucro) · AYT [paper]</b>');
    expect(profit.text).toContain('• <b>Motivo:</b> alvo 2');
    expect(profit.text).toContain('• <b>Tempo:</b> 2m 1s');
  });

  it('traduz todos os motivos de saída e formata alerta e resumo horário', () => {
    const reasonLabels = [
      ['trailing_stop', 'trailing stop'], ['time_stop', 'tempo esgotado'], ['emergency_creator_sell', 'criador vendeu'],
      ['emergency_large_sell', 'venda grande'], ['graduated', 'token graduou'],
    ] as const;
    for (const [reason, label] of reasonLabels) {
      const message = formatExitAlert({
        mint, symbol: null, name: null, reason, fraction: 1, remainingFraction: 0, priceLamportsPerUnit: 0.1,
        pnlLamports: -1n, pnlRatio: -0.01, closed: true, operationPnlLamports: -1n, operationPnlRatio: -0.01,
        heldMs: 1_000, stopLossPct: 0.2, mode: 'paper',
      });
      expect(message.text).toContain(`• <b>Motivo:</b> ${label}`);
    }
    expect(formatAlertMessage('TESTE', ['a < b & c']).text).toContain('<b>⚠️ ALERTA · TESTE [paper]</b>');
    expect(formatAlertMessage('TESTE', ['a < b & c']).text).toContain('• a &lt; b &amp; c');

    // 2026-10-02 01:00–02:00 BRT = 04:00–05:00 UTC
    const from = Date.UTC(2026, 9, 2, 4, 0, 0);
    const summary = formatHourlySummary({
      mode: 'paper', runId: 'r', fromMs: from, toMs: from + 3_600_000, openedOperations: 3, closedOperations: 2, winningOperations: 1,
      netPnlLamports: -1_500_000n, runNetPnlLamports: 3_000_000n, capitalLamports: 150_000_000n,
      best: { symbol: 'GOOD<x>', pnlRatio: 0.42 }, worst: { symbol: 'BAD', pnlRatio: -0.21 }, openPositions: 1,
      exitsByReason: new Map([['stop_loss', 2], ['take_profit_1', 1], ['take_profit_2', 1], ['trailing_stop', 1]]),
      evaluatedTokens: 310, rejectionsByReason: new Map([['minUniqueHolders', 30], ['maxAgeSec', 2]]),
      entriesBlockedBy: 'kill_switch:daily_loss',
      health: { streamGapMs: 34_200, http429PerMin: 0, priorityFeeLamports: 43_347n, jitoTipLamports: 97_500n, costSource: 'tx_costs_median' },
    });
    const t = summary.text;
    expect(t).toContain('<b>📊 RESUMO 01:00–02:00 BRT [paper]</b>');
    expect(t).toContain('• <b>Operações:</b> 3 abertas · 2 fechadas (1✅ 1❌)');
    expect(t).toContain('• <b>PnL hora:</b> -0,0015 SOL (-1,0%)');
    expect(t).toContain('• <b>PnL run:</b> 0,0030 SOL (+2,0%)');
    expect(t).toContain('• <b>Melhor/pior:</b> GOOD&lt;x&gt; +42,0% / BAD -21,0%');
    expect(t).toContain('• <b>Saídas:</b> stop 2 · alvo 1 1 · alvo 2 1 · trailing 1');
    expect(t).toContain('• <b>Abertas agora:</b> 1');
    expect(t).toContain('⛔ <b>Entradas bloqueadas:</b> kill_switch:daily_loss (zera 21:00 BRT)');
    expect(t).toContain('• <b>Avaliados:</b> 310 · <b>mais rejeitou:</b> minUniqueHolders (30)');
    expect(t).toContain('sem stream 34s · 429 0,0/min · custo 0,0001 SOL/tx (tx_costs_median)');
    // cabe numa tela de celular: poucas linhas
    expect(t.split('\n').length).toBeLessThanOrEqual(10);
  });
});
