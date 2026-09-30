import raw from "./spec.json";

export type StateKey = "alive" | "asleep" | "ghost" | "quantum";
export type TraitKey = "breed" | "mood" | "accessory" | "brokenThing" | "room";
export type TierKey = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type SeedField = "stateRoll" | TraitKey | "cosmetic";

export interface SeedSlice {
  field: SeedField;
  offset: number;
  bits: number;
}

export interface StateDef {
  id: number;
  key: StateKey;
  name: string;
  /** Exclusive upper bound of the 16-bit state roll for this state. */
  rollBelow: number;
  scoreBonus: number;
}

export interface VariantDef {
  key: string;
  name: string;
  /** Number of roll values (out of 256) that map to this variant. */
  width: number;
}

export interface TraitDef {
  index: number;
  key: TraitKey;
  name: string;
  /** Multiplier of the trait roll in the rarity score. */
  weight: number;
  /** Ordered common to rare: a higher roll is always a rarer variant. */
  variants: VariantDef[];
}

export interface TierDef {
  key: TierKey;
  name: string;
  minScore: number;
  topPercent: number;
}

export interface GameSpec {
  version: string;
  collection: { name: string; symbol: string; maxSupply: number };
  seed: { bits: number; layout: SeedSlice[] };
  states: StateDef[];
  traits: TraitDef[];
  rarity: { formula: string; maxScore: number; tiers: TierDef[] };
  affection: {
    initial: number;
    perFeedMin: number;
    perFeedMax: number;
    goldenThreshold: number;
    goldenRule: string;
    goldenScoreBonus: number;
  };
  mechanics: Record<string, { paid: boolean; rule: string; [k: string]: unknown }>;
  events: Record<string, { fields: string[]; note?: string }>;
}

export const spec = raw as unknown as GameSpec;

export const TRAIT_KEYS: readonly TraitKey[] = ["breed", "mood", "accessory", "brokenThing", "room"];
