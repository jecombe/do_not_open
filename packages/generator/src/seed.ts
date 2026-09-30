import { spec, TRAIT_KEYS, type SeedField, type TraitKey } from "@dno/game-spec";

export const SEED_MASK = (1n << BigInt(spec.seed.bits)) - 1n;

export interface DecodedSeed {
  stateRoll: number;
  rolls: Record<TraitKey, number>;
  cosmetic: number;
}

function slice(field: SeedField) {
  const s = spec.seed.layout.find((l) => l.field === field);
  if (!s) throw new Error(`seed layout has no field "${field}"`);
  return s;
}

function read(seed: bigint, field: SeedField): number {
  const s = slice(field);
  return Number((seed >> BigInt(s.offset)) & ((1n << BigInt(s.bits)) - 1n));
}

export function normalizeSeed(seed: bigint | string | number): bigint {
  const v = BigInt(seed);
  if (v < 0n || v > SEED_MASK) throw new RangeError(`seed out of ${spec.seed.bits}-bit range`);
  return v;
}

/** Splits a 64-bit seed into the state roll, the five trait rolls and the cosmetic byte. */
export function decodeSeed(seedInput: bigint | string | number): DecodedSeed {
  const seed = normalizeSeed(seedInput);
  const rolls = {} as Record<TraitKey, number>;
  for (const key of TRAIT_KEYS) rolls[key] = read(seed, key);
  return { stateRoll: read(seed, "stateRoll"), rolls, cosmetic: read(seed, "cosmetic") };
}

/** Inverse of decodeSeed. Used for fixtures and tests. */
export function encodeSeed(parts: DecodedSeed): bigint {
  let seed = 0n;
  const put = (field: SeedField, value: number) => {
    const s = slice(field);
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** s.bits) {
      throw new RangeError(`${field}=${value} does not fit in ${s.bits} bits`);
    }
    seed |= BigInt(value) << BigInt(s.offset);
  };
  put("stateRoll", parts.stateRoll);
  for (const key of TRAIT_KEYS) put(key, parts.rolls[key]);
  put("cosmetic", parts.cosmetic);
  return seed;
}

export function seedToHex(seed: bigint): string {
  return "0x" + seed.toString(16).padStart(spec.seed.bits / 4, "0");
}
