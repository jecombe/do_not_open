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
