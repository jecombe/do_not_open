/** mulberry32: small deterministic PRNG for cosmetic jitter. Not used for anything rarity-relevant. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Folds a bigint into a 32-bit PRNG seed. */
export function fold32(value: bigint): number {
  let v = value;
  let out = 0x9e3779b9;
  while (v > 0n) {
    out = Math.imul(out ^ Number(v & 0xffffffffn), 0x85ebca6b) >>> 0;
    out ^= out >>> 13;
    v >>= 32n;
  }
  return out >>> 0;
}
