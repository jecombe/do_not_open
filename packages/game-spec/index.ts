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
  /** `milestones`: the only sold counts ever announced, increasing, the last one `maxSupply`. */
  collection: { name: string; symbol: string; maxSupply: number; milestones: number[]; milestonesRule: string };
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
  economy: EconomySpec;
  market: MarketSpec;
  whitelist: WhitelistSpec;
  events: Record<string, { fields: string[]; note?: string }>;
}

/** The flea market, where players sell each other boxes, cats and rats in cUSDC. */
export interface MarketSpec {
  name: string;
  /** Share of each sale paid to the treasury, in basis points. */
  feeBps: number;
  /** The most the fee can ever be set to, in basis points. */
  maxFeeBps: number;
  /** The most an item may be listed or offered for, in whole USDC. */
  maxPriceUsdc: string;
  rule: string;
  stateRule: string;
  leaks: string;
}

/** The mainnet whitelist and the gift each seated wallet collects, by rank. */
export interface WhitelistSpec {
  places: number;
  rule: string;
  claimDays: number;
  tiers: WhitelistTierDef[];
  leaks: string;
}

export type WhitelistTierKey = "first" | "business" | "economy";

export interface WhitelistTierDef {
  key: WhitelistTierKey;
  name: string;
  /** Ranks on the list, 1-based, both included. */
  fromRank: number;
  toRank: number;
  /** cCROQ drawn at random, encrypted, both included. */
  croqMin: number;
  croqMax: number;
  box: boolean;
  rat: boolean;
}

/** The tier of a 1-based rank on the whitelist, or null past the last one. */
export function whitelistTierOf(rank: number, tiers: readonly WhitelistTierDef[] = spec.whitelist.tiers): number | null {
  const i = tiers.findIndex((t) => rank >= t.fromRank && rank <= t.toRank);
  return i < 0 ? null : i;
}

export type BuildKey = "thin" | "normal" | "chubby" | "fat" | "huge";
export type DiseaseKey = "diabetic" | "arthritic" | "fattyLiver";

export type AllocationKey = "gameReserve" | "welcomeBags" | "liquidity" | "treasury";

/** The CROQ economy. Amounts are whole croquettes: the token has no decimals. */
export interface EconomySpec {
  token: {
    name: string;
    symbol: string;
    confidentialName: string;
    confidentialSymbol: string;
    decimals: number;
    totalSupply: number;
    rule: string;
  };
  allocation: { key: AllocationKey; name: string; amount: number; rule: string }[];
  welcomeBag: { amount: number; rule: string };
  purr: { maxPerDay: number; vetMultiplier: number; maxDays: number; halvingDays: number; rule: string };
  meal: { mealsPerDay: number; maxEatenPerDay: number; treasuryBps: number; burnBps: number; rule: string };
  weight: {
    builds: { key: BuildKey; name: string; minWeight: number; scoreBonus: number }[];
    sick: { minWeight: number; weightSpread: number; scoreBonus: number; rule: string };
    diseases: { key: DiseaseKey; name: string; rollBelow: number }[];
    rule: string;
  };
  burn: { rule: string };
}

export const spec = raw as unknown as GameSpec;

export const TRAIT_KEYS: readonly TraitKey[] = ["breed", "mood", "accessory", "brokenThing", "room"];
export { studio, packCostUsd, styledPrompt, type StudioSpec, type StudioPackDef, type StudioUnit } from "./studioSpec";
