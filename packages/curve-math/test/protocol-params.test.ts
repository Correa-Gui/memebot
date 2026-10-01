import { describe, expect, it } from 'vitest';
import { parseCurveInitialParams } from '../src/protocol-params.ts';

// Trecho do `config_json` real da conta Global (protocol_config, snapshot 2026-09-29).
const GLOBAL_JSON = {
  initialized: true,
  initial_virtual_token_reserves: '1073000000000000',
  initial_virtual_sol_reserves: '30000000000',
  initial_real_token_reserves: '793100000000000',
  token_total_supply: '1000000000000000',
  initial_virtual_quote_reserves: '4292000000',
};

describe('parseCurveInitialParams', () => {
  it('converte os campos u64 da conta Global (curva cotada em SOL)', () => {
    expect(parseCurveInitialParams(GLOBAL_JSON)).toEqual({
      initialVirtualQuote: 30_000_000_000n,
      initialVirtualToken: 1_073_000_000_000_000n,
      initialRealToken: 793_100_000_000_000n,
    });
  });

  it('rejeita campo ausente', () => {
    const withoutRealToken: Record<string, unknown> = { ...GLOBAL_JSON };
    delete withoutRealToken.initial_real_token_reserves;
    expect(() => parseCurveInitialParams(withoutRealToken)).toThrow();
  });

  it('rejeita u64 que não é string decimal', () => {
    expect(() => parseCurveInitialParams({ ...GLOBAL_JSON, initial_real_token_reserves: 793 })).toThrow();
    expect(() => parseCurveInitialParams({ ...GLOBAL_JSON, initial_real_token_reserves: '-1' })).toThrow();
  });

  it('rejeita reserva real inicial zero ou maior que a virtual', () => {
    expect(() => parseCurveInitialParams({ ...GLOBAL_JSON, initial_real_token_reserves: '0' })).toThrow(RangeError);
    expect(() =>
      parseCurveInitialParams({ ...GLOBAL_JSON, initial_real_token_reserves: '2000000000000000' }),
    ).toThrow(RangeError);
  });
});
