import { z } from 'zod';
import { BorshDecodeError, BorshReader, type Decoded, type IdlTypeDef } from './borsh.ts';
import pumpIdlJson from './idl/pump.json' with { type: 'json' };
import pumpAmmIdlJson from './idl/pump_amm.json' with { type: 'json' };
import pumpFeesIdlJson from './idl/pump_fees.json' with { type: 'json' };

const Discriminator = z.array(z.number().int().min(0).max(255)).length(8);

const IdlSchema = z.object({
  address: z.string(),
  metadata: z.object({ name: z.string() }).passthrough(),
  events: z.array(z.object({ name: z.string(), discriminator: Discriminator })).default([]),
  accounts: z.array(z.object({ name: z.string(), discriminator: Discriminator })).default([]),
  // o layout dos tipos é validado ao decodificar (BorshReader lança em tipo desconhecido)
  types: z.array(z.object({ name: z.string(), type: z.object({ kind: z.enum(['struct', 'enum']) }).passthrough() })),
});

export interface DecodedEvent {
  name: string;
  data: { [k: string]: Decoded };
  /** Bytes que sobraram após o último campo do IDL: > 0 indica layout on-chain mais novo que o IDL. */
  trailingBytes: number;
}

export class ProgramIdl {
  readonly address: string;
  readonly name: string;
  private readonly types: ReadonlyMap<string, IdlTypeDef>;
  private readonly events: ReadonlyMap<string, string>;
  private readonly accounts: ReadonlyMap<string, readonly number[]>;

  constructor(json: unknown) {
    const idl = IdlSchema.parse(json);
    this.address = idl.address;
    this.name = idl.metadata.name;
    this.types = new Map(idl.types.map((t) => [t.name, t as unknown as IdlTypeDef]));
    this.events = new Map(idl.events.map((e) => [discKey(e.discriminator), e.name]));
    this.accounts = new Map(idl.accounts.map((a) => [a.name, a.discriminator]));
  }

  /** Nome do evento se os 8 primeiros bytes forem o discriminador de um evento conhecido. */
  eventName(bytes: Uint8Array): string | undefined {
    if (bytes.length < 8) return undefined;
    return this.events.get(discKey(bytes.subarray(0, 8)));
  }

  /** Decodifica um evento Anchor (discriminador + borsh). Retorna `null` se o discriminador não for de evento. */
  decodeEvent(bytes: Uint8Array): DecodedEvent | null {
    const name = this.eventName(bytes);
    if (!name) return null;
    const body = bytes.subarray(8);
    const { data, consumed } = this.decodeStruct(name, body);
    return { name, data, trailingBytes: body.length - consumed };
  }

  /** Decodifica os dados de uma conta, conferindo o discriminador. */
  decodeAccount(accountName: string, bytes: Uint8Array): { [k: string]: Decoded } {
    const disc = this.accounts.get(accountName);
    if (!disc) throw new BorshDecodeError(`conta ${accountName} não existe no IDL ${this.name}`);
    if (bytes.length < 8 || discKey(bytes.subarray(0, 8)) !== discKey(disc)) {
      throw new BorshDecodeError(`discriminador de conta não confere para ${accountName}`);
    }
    return this.decodeStruct(accountName, bytes.subarray(8)).data;
  }

  private decodeStruct(typeName: string, body: Uint8Array): { data: { [k: string]: Decoded }; consumed: number } {
    const def = this.types.get(typeName);
    if (def?.type.kind !== 'struct') throw new BorshDecodeError(`struct ${typeName} não existe no IDL ${this.name}`);
    const reader = new BorshReader(body, this.types);
    const data = reader.readFields(def.type.fields, typeName);
    return { data, consumed: reader.position };
  }
}

function discKey(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const PUMP_IDL = new ProgramIdl(pumpIdlJson);
export const PUMP_AMM_IDL = new ProgramIdl(pumpAmmIdlJson);
export const PUMP_FEES_IDL = new ProgramIdl(pumpFeesIdlJson);
