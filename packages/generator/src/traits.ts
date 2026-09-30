import { spec, TRAIT_KEYS, type StateDef, type StateKey, type TraitDef, type TraitKey } from "@dno/game-spec";
import { decodeSeed } from "./seed";

export interface ResolvedTrait {
  key: TraitKey;
  roll: number;
  variantIndex: number;
  variant: string;
  name: string;
}

export function traitDef(key: TraitKey): TraitDef {
  const def = spec.traits.find((t) => t.key === key);
  if (!def) throw new Error(`unknown trait "${key}"`);
  return def;
}

/** Maps a trait roll (0..255) to its variant through the cumulative width table. */
export function resolveTrait(key: TraitKey, roll: number): ResolvedTrait {
  if (!Number.isInteger(roll) || roll < 0 || roll > 255) throw new RangeError(`trait roll ${roll} out of range`);
  const def = traitDef(key);
  let upper = 0;
  for (let i = 0; i < def.variants.length; i++) {
    const v = def.variants[i]!;
    upper += v.width;
    if (roll < upper) return { key, roll, variantIndex: i, variant: v.key, name: v.name };
  }
  throw new Error(`trait "${key}" widths do not cover roll ${roll}`);
}

export function stateFromRoll(stateRoll: number): StateDef {
  if (!Number.isInteger(stateRoll) || stateRoll < 0 || stateRoll > 65535) {
    throw new RangeError(`state roll ${stateRoll} out of range`);
  }
  const state = spec.states.find((s) => stateRoll < s.rollBelow);
  if (!state) throw new Error(`state thresholds do not cover roll ${stateRoll}`);
  return state;
}

export function stateDef(key: StateKey | number): StateDef {
  const state = spec.states.find((s) => s.key === key || s.id === key);
  if (!state) throw new Error(`unknown state "${key}"`);
  return state;
}

export function resolveTraits(seed: bigint | string | number): Record<TraitKey, ResolvedTrait> {
  const { rolls } = decodeSeed(seed);
  const out = {} as Record<TraitKey, ResolvedTrait>;
  for (const key of TRAIT_KEYS) out[key] = resolveTrait(key, rolls[key]);
  return out;
}
