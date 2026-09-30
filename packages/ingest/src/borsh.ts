import { getBase58Decoder } from '@solana/kit';

/** Subconjunto da especificação de IDL do Anchor (>= 0.30) usado pelos IDLs do Pump.fun/PumpSwap. */
export type IdlType =
  | 'bool' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'u128' | 'i128'
  | 'string' | 'bytes' | 'pubkey'
  | { vec: IdlType }
  | { option: IdlType }
  | { array: [IdlType, number] }
  | { defined: { name: string } };

export interface IdlField { name: string; type: IdlType }

export type IdlTypeDef =
  | { name: string; type: { kind: 'struct'; fields?: IdlField[] | IdlType[] } }
  | { name: string; type: { kind: 'enum'; variants: { name: string; fields?: IdlField[] | IdlType[] }[] } };

export type Decoded = boolean | number | bigint | string | null | Decoded[] | { [k: string]: Decoded };

export class BorshDecodeError extends Error {
  override name = 'BorshDecodeError';
}

const base58 = getBase58Decoder();

function isNamedFields(fields: IdlField[] | IdlType[]): fields is IdlField[] {
  const first = fields[0];
  return first !== undefined && typeof first === 'object' && 'name' in first && 'type' in first;
}

export class BorshReader {
  private offset = 0;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly types: ReadonlyMap<string, IdlTypeDef>;

  constructor(bytes: Uint8Array, types: ReadonlyMap<string, IdlTypeDef>) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.types = types;
  }

  get position(): number {
    return this.offset;
  }

  private need(n: number, what: string): void {
    if (this.offset + n > this.bytes.length) {
      throw new BorshDecodeError(
        `fim dos dados ao ler ${what}: precisa de ${String(n)} bytes no offset ${String(this.offset)}, total ${String(this.bytes.length)}`,
      );
    }
  }

  read(type: IdlType, what = 'valor'): Decoded {
    if (typeof type === 'string') return this.readPrimitive(type, what);
    if ('vec' in type) {
      const len = this.readU32(what);
      const out: Decoded[] = [];
      for (let i = 0; i < len; i++) out.push(this.read(type.vec, `${what}[${String(i)}]`));
      return out;
    }
    if ('option' in type) {
      const tag = this.readU8(what);
      if (tag === 0) return null;
      if (tag !== 1) throw new BorshDecodeError(`tag de option inválida (${String(tag)}) em ${what}`);
      return this.read(type.option, what);
    }
    if ('array' in type) {
      const [inner, len] = type.array;
      const out: Decoded[] = [];
      for (let i = 0; i < len; i++) out.push(this.read(inner, `${what}[${String(i)}]`));
      return out;
    }
    return this.readDefined(type.defined.name, what);
  }

  readFields(fields: IdlField[] | IdlType[] | undefined, what: string): { [k: string]: Decoded } {
    const out: { [k: string]: Decoded } = {};
    if (!fields || fields.length === 0) return out;
    if (isNamedFields(fields)) {
      for (const f of fields) out[f.name] = this.read(f.type, `${what}.${f.name}`);
    } else {
      fields.forEach((t, i) => {
        out[String(i)] = this.read(t, `${what}.${String(i)}`);
      });
    }
    return out;
  }

  private readDefined(name: string, what: string): Decoded {
    const def = this.types.get(name);
    if (!def) throw new BorshDecodeError(`tipo não definido no IDL: ${name}`);
    if (def.type.kind === 'struct') return this.readFields(def.type.fields, `${what}<${name}>`);
    const idx = this.readU8(`${what}<${name}>.variant`);
    const variant = def.type.variants[idx];
    if (!variant) throw new BorshDecodeError(`variante ${String(idx)} inexistente em ${name}`);
    if (!variant.fields || variant.fields.length === 0) return variant.name;
    return { [variant.name]: this.readFields(variant.fields, `${what}<${name}>.${variant.name}`) };
  }

  private readU8(what: string): number {
    this.need(1, what);
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  private readU32(what: string): number {
    this.need(4, what);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  private readBigLE(bytes: number, signed: boolean, what: string): bigint {
    this.need(bytes, what);
    let v = 0n;
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.bytes[this.offset + i] ?? 0);
    this.offset += bytes;
    const bits = BigInt(bytes * 8);
    if (signed && v >> (bits - 1n) === 1n) v -= 1n << bits;
    return v;
  }

  private readPrimitive(type: Extract<IdlType, string>, what: string): Decoded {
    switch (type) {
      case 'bool': {
        const b = this.readU8(what);
        if (b > 1) throw new BorshDecodeError(`bool inválido (${String(b)}) em ${what}`);
        return b === 1;
      }
      case 'u8':
        return this.readU8(what);
      case 'i8': {
        this.need(1, what);
        const v = this.view.getInt8(this.offset);
        this.offset += 1;
        return v;
      }
      case 'u16': {
        this.need(2, what);
        const v = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return v;
      }
      case 'i16': {
        this.need(2, what);
        const v = this.view.getInt16(this.offset, true);
        this.offset += 2;
        return v;
      }
      case 'u32':
        return this.readU32(what);
      case 'i32': {
        this.need(4, what);
        const v = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return v;
      }
      case 'u64':
        return this.readBigLE(8, false, what);
      case 'i64':
        return this.readBigLE(8, true, what);
      case 'u128':
        return this.readBigLE(16, false, what);
      case 'i128':
        return this.readBigLE(16, true, what);
      case 'pubkey': {
        this.need(32, what);
        const s = base58.decode(this.bytes.subarray(this.offset, this.offset + 32));
        this.offset += 32;
        return s;
      }
      case 'string': {
        const len = this.readU32(what);
        this.need(len, what);
        const s = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.offset, this.offset + len));
        this.offset += len;
        return s;
      }
      case 'bytes': {
        const len = this.readU32(what);
        this.need(len, what);
        const out = Array.from(this.bytes.subarray(this.offset, this.offset + len));
        this.offset += len;
        return out;
      }
    }
  }
}
