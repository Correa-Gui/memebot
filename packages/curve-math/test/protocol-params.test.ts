import { describe, expect, it } from 'vitest';
import { parseCurveInitialParams, parseFeeConfigAccount, worstCaseCurveFees } from '../src/protocol-params.ts';

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

// `config_json` real da conta FeeConfig do Pump.fun (protocol_config, snapshot 2026-09-30).
const FEE_CONFIG_JSON = {
  bump: 253,
  admin: 'FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF',
  flat_fees: { lp_fee_bps: '0', protocol_fee_bps: '95', creator_fee_bps: '30' },
  fee_tiers: [{ market_cap_lamports_threshold: '0', fees: { lp_fee_bps: '0', protocol_fee_bps: '95', creator_fee_bps: '30' } }],
  stable_fee_tiers: [{ market_cap_lamports_threshold: '0', fees: { lp_fee_bps: '0', protocol_fee_bps: '95', creator_fee_bps: '30' } }],
  exotic_flat_fees: { lp_fee_bps: '0', protocol_fee_bps: '95', creator_fee_bps: '30' },
};

describe('parseFeeConfigAccount / worstCaseCurveFees', () => {
  it('converte o FeeConfig real e devolve 95/30 bps', () => {
    const cfg = parseFeeConfigAccount(FEE_CONFIG_JSON);
    expect(cfg.feeTiers).toEqual([{ marketCapLamportsThreshold: 0n, fees: { lpFeeBps: 0n, protocolFeeBps: 95n, creatorFeeBps: 30n } }]);
    expect(worstCaseCurveFees(cfg)).toEqual({ protocolFeeBps: 95n, creatorFeeBps: 30n });
  });

  it('com tiers diferentes, escolhe o mais caro (protocolo + criador)', () => {
    const tier = (threshold: string, p: string, c: string) => ({ market_cap_lamports_threshold: threshold, fees: { lp_fee_bps: '0', protocol_fee_bps: p, creator_fee_bps: c } });
    const cfg = parseFeeConfigAccount({ ...FEE_CONFIG_JSON, fee_tiers: [tier('0', '95', '30'), tier('1000', '90', '50'), tier('2000', '50', '10')] });
    expect(worstCaseCurveFees(cfg)).toEqual({ protocolFeeBps: 90n, creatorFeeBps: 50n });
    expect(worstCaseCurveFees(parseFeeConfigAccount({ ...FEE_CONFIG_JSON, fee_tiers: [] }))).toEqual({ protocolFeeBps: 95n, creatorFeeBps: 30n });
  });

  it('rejeita formato inválido', () => {
    expect(() => parseFeeConfigAccount({ ...FEE_CONFIG_JSON, flat_fees: { protocol_fee_bps: 95 } })).toThrow();
  });
});
