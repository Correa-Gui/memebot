import type { PumpSwapSwapDetails } from '@memebot/core';
import { BorshDecodeError } from './borsh.ts';
import { PUMP_AMM_IDL } from './idl.ts';
import { NormalizeError, pumpSwapSwapDetails } from './normalize.ts';

export type DecodeSwapDetailsResult =
  | { ok: true; details: PumpSwapSwapDetails }
  | { ok: false; reason: 'empty_raw' | 'not_swap_event' | 'unknown_ix_name' | 'decode_error'; detail: string };

/**
 * Decodifica os campos extras do swap a partir da linha `Program data:` original (`raw_b64` de
 * `events_trade`), com o IDL oficial `pump_amm.json` — a mesma regra do `normalize` ao vivo
 * (`pumpSwapSwapDetails`). Usado pelo backfill de `pumpswap_trade_extra`. Nunca lança por dado
 * ruim: devolve o motivo, para o chamador contar.
 */
export function decodePumpSwapSwapDetails(rawB64: string): DecodeSwapDetailsResult {
  if (rawB64.length === 0) return { ok: false, reason: 'empty_raw', detail: 'raw_b64 vazio (TTL expirou?)' };
  try {
    const ev = PUMP_AMM_IDL.decodeEvent(Buffer.from(rawB64, 'base64'));
    if (!ev || (ev.name !== 'BuyEvent' && ev.name !== 'SellEvent')) {
      return { ok: false, reason: 'not_swap_event', detail: ev?.name ?? 'discriminador desconhecido' };
    }
    const details = pumpSwapSwapDetails(ev.name, ev.data);
    if (!details) {
      const ix = ev.data['ix_name'];
      return { ok: false, reason: 'unknown_ix_name', detail: typeof ix === 'string' ? ix : 'ix_name ausente' };
    }
    return { ok: true, details };
  } catch (e) {
    if (e instanceof BorshDecodeError || e instanceof NormalizeError) {
      return { ok: false, reason: 'decode_error', detail: e.message };
    }
    throw e;
  }
}
