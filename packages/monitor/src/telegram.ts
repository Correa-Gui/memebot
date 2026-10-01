import type { Logger } from '@memebot/core';
import { z } from 'zod';

/**
 * Cliente mínimo da Bot API do Telegram (`sendMessage`) via `fetch` nativo. Regras (CLAUDE.md §3):
 * - timeout por requisição, retry limitado com backoff exponencial (respeita `retry_after` do 429,
 *   com teto), fila com limite (descarta a mensagem MAIS ANTIGA quando cheia, contando);
 * - fallback: falha do Telegram nunca lança para quem chama nem trava o bot — só log;
 * - sem `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`: desligado, com um aviso no log;
 * - o token NUNCA vai para o log: a URL da Bot API contém o token, então mensagens de erro (que no
 *   `fetch` do Node podem incluir a URL) passam por `redactToken` antes de serem logadas.
 * - só dados públicos (mint, símbolo, preços, PnL do run) — nada de chaves/saldos da carteira.
 */
export interface TelegramOptions {
  botToken: string;
  chatId: string;
  logger: Logger;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Tentativas extras depois da primeira (padrão 3). */
  maxRetries?: number;
  baseBackoffMs?: number;
  /** Teto da espera pedida por um 429 (`retry_after`), ms. */
  maxRetryAfterMs?: number;
  /** Mensagens aguardando envio; acima disso a mais antiga é descartada. */
  maxQueue?: number;
  apiBaseUrl?: string;
}

export interface TelegramStats {
  sent: number;
  failed: number;
  dropped: number;
}

/** Limite de texto do `sendMessage` (Bot API): 4096 caracteres. */
export const TELEGRAM_MAX_TEXT = 4096;

const ApiResponse = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

/** Remove o token (e qualquer coisa com cara de `bot<id>:<segredo>`) de um texto antes de logar. */
export function redactToken(text: string, token: string): string {
  let out = token.length > 0 ? text.split(token).join('[REDACTED]') : text;
  out = out.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
  return out;
}

class PermanentError extends Error {}

export class TelegramNotifier {
  readonly enabled: boolean;
  readonly stats: TelegramStats = { sent: 0, failed: 0, dropped: 0 };
  private readonly o: Required<Omit<TelegramOptions, 'logger'>> & { logger: Logger };
  private readonly queue: string[] = [];
  private worker: Promise<void> | null = null;

  constructor(opts: TelegramOptions) {
    this.o = {
      fetchFn: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      timeoutMs: 5_000,
      maxRetries: 3,
      baseBackoffMs: 500,
      maxRetryAfterMs: 30_000,
      maxQueue: 100,
      apiBaseUrl: 'https://api.telegram.org',
      ...opts,
    };
    this.enabled = opts.botToken.trim().length > 0 && opts.chatId.trim().length > 0;
    if (!this.enabled) {
      opts.logger.warn('Telegram desligado: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID vazios (alertas só no log)');
    }
  }

  /** Enfileira (nunca lança, nunca bloqueia). */
  send(text: string): void {
    if (!this.enabled) return;
    const body = text.length > TELEGRAM_MAX_TEXT ? `${text.slice(0, TELEGRAM_MAX_TEXT - 1)}…` : text;
    this.queue.push(body);
    while (this.queue.length > this.o.maxQueue) {
      this.queue.shift();
      this.stats.dropped++;
      this.o.logger.warn({ dropped: this.stats.dropped }, 'fila do Telegram cheia: mensagem mais antiga descartada');
    }
    this.worker ??= this.drain().finally(() => {
      this.worker = null;
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Espera a fila esvaziar, no máximo `timeoutMs` (encerramento). */
  async close(timeoutMs = 10_000): Promise<void> {
    if (!this.worker) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    });
    await Promise.race([this.worker, timeout]);
    clearTimeout(timer);
  }

  private async drain(): Promise<void> {
    for (let text = this.queue.shift(); text !== undefined; text = this.queue.shift()) {
      try {
        await this.sendWithRetry(text);
        this.stats.sent++;
      } catch (e) {
        this.stats.failed++;
        const msg = redactToken(e instanceof Error ? e.message : String(e), this.o.botToken);
        this.o.logger.error({ err: msg }, 'falha ao enviar alerta ao Telegram (seguindo sem ele)');
      }
    }
  }

  private async sendWithRetry(text: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      try {
        const waitMs = await this.sendOnce(text);
        if (waitMs === null) return;
        lastError = new Error('HTTP 429 (rate limit)');
        await this.o.sleep(waitMs);
        continue;
      } catch (e) {
        if (e instanceof PermanentError) throw e;
        lastError = e;
      }
      if (attempt < this.o.maxRetries) await this.o.sleep(this.o.baseBackoffMs * 2 ** attempt);
    }
    throw new Error(`sendMessage falhou após ${String(this.o.maxRetries + 1)} tentativas: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  /** `null` = enviado; número = esperar (429). Lança em erro transitório ou `PermanentError`. */
  private async sendOnce(text: string): Promise<number | null> {
    const url = `${this.o.apiBaseUrl}/bot${this.o.botToken}/sendMessage`;
    const res = await this.o.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.o.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(this.o.timeoutMs),
    });
    let parsed: z.infer<typeof ApiResponse> | null = null;
    try {
      const r = ApiResponse.safeParse(await res.json());
      parsed = r.success ? r.data : null;
    } catch {
      parsed = null;
    }
    if (res.ok && parsed?.ok === true) return null;
    if (res.status === 429) {
      const retryAfterMs = (parsed?.parameters?.retry_after ?? 1) * 1_000;
      return Math.min(retryAfterMs, this.o.maxRetryAfterMs);
    }
    const detail = `HTTP ${String(res.status)}${parsed?.description ? `: ${parsed.description}` : ''}`;
    // 4xx (chat inválido, token revogado, texto inválido) não se resolve repetindo.
    if (res.status >= 400 && res.status < 500) throw new PermanentError(detail);
    throw new Error(detail);
  }
}
