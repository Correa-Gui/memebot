/**
 * PRNG semeado (mulberry32): determinístico, estado = um uint32. Usado para as falhas simuladas do
 * paper (`PAPER_FAIL_RATE`) — o replay com a mesma seed reproduz exatamente as mesmas falhas.
 * Não é criptográfico, e não precisa ser.
 */
export function mulberry32Next(state: number): { value: number; state: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  return { value, state: next };
}

/** Seed uint32 derivada de uma string (FNV-1a 32 bits), ex.: o `runId`. */
export function seedFromString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
