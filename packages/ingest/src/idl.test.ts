import { describe, expect, it } from 'vitest';
import { PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, PUMP_FEES_PROGRAM_ID } from '../../../config/protocol.ts';
import { PUMP_AMM_IDL, PUMP_FEES_IDL, PUMP_IDL } from './idl.ts';

describe('IDLs oficiais', () => {
  it('endereços batem com config/protocol.ts', () => {
    expect(PUMP_IDL.address).toBe(PUMP_FUN_PROGRAM_ID);
    expect(PUMP_AMM_IDL.address).toBe(PUMP_SWAP_PROGRAM_ID);
    expect(PUMP_FEES_IDL.address).toBe(PUMP_FEES_PROGRAM_ID);
  });

  it('reconhece os discriminadores dos eventos usados', () => {
    const disc = (bytes: number[]) => new Uint8Array([...bytes, 0]);
    expect(PUMP_IDL.eventName(disc([189, 219, 127, 211, 78, 230, 97, 238]))).toBe('TradeEvent');
    expect(PUMP_IDL.eventName(disc([27, 114, 169, 77, 222, 235, 99, 118]))).toBe('CreateEvent');
    expect(PUMP_AMM_IDL.eventName(disc([103, 244, 82, 31, 44, 245, 119, 119]))).toBe('BuyEvent');
    expect(PUMP_AMM_IDL.eventName(disc([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
  });

  it('falha de forma explícita em dados truncados', () => {
    const truncated = new Uint8Array([189, 219, 127, 211, 78, 230, 97, 238, 1, 2, 3]);
    expect(() => PUMP_IDL.decodeEvent(truncated)).toThrow(/fim dos dados/);
  });
});
