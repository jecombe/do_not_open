import { spec, TRAIT_KEYS, type TierDef, type TraitKey } from "@dno/game-spec";
import { traitDef } from "./traits";

/** rarityScore = sum(weight * roll) + state bonus. Mirrors the on-chain encrypted computation. */
export function rarityScore(rolls: Record<TraitKey, number>, stateBonus: number): number {
  let score = stateBonus;
  for (const key of TRAIT_KEYS) score += traitDef(key).weight * rolls[key];
  return score;
}

export function tierForScore(score: number): TierDef {
  let tier = spec.rarity.tiers[0]!;
  for (const t of spec.rarity.tiers) if (score >= t.minScore) tier = t;
  return tier;
}

/**
 * Exact probability mass of the rarity score over a uniform 64-bit seed.
 * Returned as integer counts over `total` equally likely outcomes.
 */
export function scoreDistribution(): { counts: bigint[]; total: bigint } {
  let dist: bigint[] = [1n];
  for (const key of TRAIT_KEYS) {
    const w = traitDef(key).weight;
    const next = new Array<bigint>(dist.length + 255 * w).fill(0n);
    for (let s = 0; s < dist.length; s++) {
      const c = dist[s]!;
      if (c === 0n) continue;
      for (let roll = 0; roll < 256; roll++) next[s + roll * w]! += c;
    }
    dist = next;
  }
  const counts = new Array<bigint>(spec.rarity.maxScore + 1).fill(0n);
  let lower = 0;
  for (const state of spec.states) {
    const width = BigInt(state.rollBelow - lower);
    lower = state.rollBelow;
    for (let s = 0; s < dist.length; s++) counts[s + state.scoreBonus]! += dist[s]! * width;
  }
  return { counts, total: 256n ** 5n * 65536n };
}

/** Smallest score such that P(score >= it) <= topPercent. */
export function minScoreForTopPercent(topPercent: number): number {
  const { counts, total } = scoreDistribution();
  // Compare counts * 1e6 against total * percent * 1e4 to stay in integers.
  const limit = total * BigInt(Math.round(topPercent * 10_000));
  let above = 0n;
  let min = counts.length;
  for (let s = counts.length - 1; s >= 0; s--) {
    above += counts[s]!;
    if (above * 1_000_000n > limit) break;
    min = s;
  }
  return Math.min(min, counts.length - 1);
}

/** What a box's score can still be, given the traits one holder has felt so far. */
export interface ScoreEstimate {
  min: number;
  max: number;
  /** Chance of each tier, in `spec.rarity.tiers` order, summing to 1. */
  tiers: { key: TierDef["key"]; chance: number }[];
}

/**
 * Score range and tier odds of a sealed box when only some trait rolls are known. `known` is
 * indexed like `spec.traits`; null is a trait not felt yet, taken as a uniform byte. The state
 * stays hidden until the box is opened, so it is always weighed by its odds.
 */
export function estimateScore(known: readonly (number | null)[]): ScoreEstimate {
  let dist = [1];
  let base = 0;
  spec.traits.forEach((trait, i) => {
    const roll = known[i];
    if (roll !== null && roll !== undefined) {
      base += trait.weight * roll;
      return;
    }
    const next = new Array<number>(dist.length + 255 * trait.weight).fill(0);
    for (let s = 0; s < dist.length; s++) {
      const p = dist[s]! / 256;
      if (p === 0) continue;
      for (let r = 0; r < 256; r++) next[s + r * trait.weight]! += p;
    }
    dist = next;
  });
  const chances = spec.rarity.tiers.map(() => 0);
  let lower = 0;
  for (const state of spec.states) {
    const p = (state.rollBelow - lower) / 65536;
    lower = state.rollBelow;
    for (let s = 0; s < dist.length; s++) {
      const score = base + s + state.scoreBonus;
      chances[spec.rarity.tiers.indexOf(tierForScore(score))]! += dist[s]! * p;
    }
  }
  const bonuses = spec.states.map((s) => s.scoreBonus);
  return {
    min: base + Math.min(...bonuses),
    max: base + dist.length - 1 + Math.max(...bonuses),
    tiers: spec.rarity.tiers.map((t, i) => ({ key: t.key, chance: chances[i]! })),
  };
}
