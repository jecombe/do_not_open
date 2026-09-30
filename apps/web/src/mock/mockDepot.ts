import { spec, TRAIT_KEYS } from "@dno/game-spec";
import { buildCatSpec, mulberry32, resolveTraits, traitDef, type CatSpec, type ResolvedTrait } from "@dno/generator";

/**
 * Mock mode only. Stands in for the chain until the ChainAdapter lands (Phase 4).
 * On-chain every one of these draws is encrypted and nobody can compute it.
 */
export function mockSeedForToken(tokenId: number): bigint {
  const rand = mulberry32(Math.imul(tokenId + 1, 0x2545f491));
  return (BigInt(Math.floor(rand() * 2 ** 32)) << 32n) | BigInt(Math.floor(rand() * 2 ** 32));
}

export interface TraitPeek {
  trait: ResolvedTrait;
  traitName: string;
}

function pickTrait(tokenId: number, salt: number): TraitPeek {
  const pick = mulberry32(Math.imul(tokenId + 31, 7919) + salt * 104729);
  const key = TRAIT_KEYS[Math.floor(pick() * TRAIT_KEYS.length)]!;
  return { trait: resolveTraits(mockSeedForToken(tokenId))[key], traitName: traitDef(key).name };
}

/** One trait, picked at random, readable by the viewer only. Never the state. */
export const mockShake = (tokenId: number, shakeCount: number): TraitPeek => pickTrait(tokenId, shakeCount);

/** Hidden affection gained by one feed: 0 to perFeedMax. */
export function mockFeedGain(tokenId: number, feedCount: number): number {
  const rand = mulberry32(Math.imul(tokenId + 7, 0x9e3779b1) + feedCount * 31337);
  return Math.floor(rand() * (spec.affection.perFeedMax + 1));
}

export const mockCat = (tokenId: number, affection = 0): CatSpec => buildCatSpec({ seed: mockSeedForToken(tokenId), affection });

export interface DuelOutcome {
  aWins: boolean;
  winner: number;
  loser: number;
  /** The one trait the loser has to show. */
  shown: TraitPeek;
}

/** Higher base rarity wins; ties go to B. The loser shows one trait, the winner nothing. */
export function mockDuel(tokenA: number, tokenB: number, duelCount: number): DuelOutcome {
  const aWins = mockCat(tokenA).rarity.score > mockCat(tokenB).rarity.score;
  const loser = aWins ? tokenB : tokenA;
  return { aWins, winner: aWins ? tokenA : tokenB, loser, shown: pickTrait(loser, 1000 + duelCount) };
}
