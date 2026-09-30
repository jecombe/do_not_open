import { spec, type StateKey, type TierKey, type TraitKey } from "@dno/game-spec";
import { resolveTrait, VICE_NAMES, type CatSpec, type Vice } from "@dno/generator";
import { lookup } from "./app";

/**
 * The game's own names, in the visitor's language. The spec's English names are the
 * fallback, so a variant added to spec.json still shows something before it is translated.
 */
export const stateName = (key: StateKey): string => lookup(`state.${key}`) ?? spec.states.find((s) => s.key === key)?.name ?? key;

export const traitName = (key: TraitKey): string => lookup(`trait.${key}`) ?? spec.traits.find((t) => t.key === key)?.name ?? key;

export const variantName = (trait: TraitKey, variant: string): string =>
  lookup(`variant.${trait}.${variant}`) ?? spec.traits.find((t) => t.key === trait)?.variants.find((v) => v.key === variant)?.name ?? variant;

export const tierName = (key: TierKey): string => lookup(`tier.${key}`) ?? spec.rarity.tiers.find((t) => t.key === key)?.name ?? key;

export const viceName = (key: Vice): string => lookup(`vice.${key}`) ?? VICE_NAMES[key];

/** "Mood" and "Judging" for a trait index and its roll, as the chain reports them. */
export function rollNames(traitIndex: number, roll: number): { trait: string; variant: string } {
  const def = spec.traits[traitIndex]!;
  return { trait: traitName(def.key), variant: variantName(def.key, resolveTrait(def.key, roll).variant) };
}

/** The translated names a cat is described with in prose. */
export const catNames = (cat: CatSpec) => ({
  state: stateName(cat.state),
  breed: variantName("breed", cat.traits.breed.variant),
  mood: variantName("mood", cat.traits.mood.variant),
  tier: tierName(cat.rarity.tier),
});

/** Upper-cases the first letter: names are stored lower-case inside sentences, and some sentences start with one. */
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
