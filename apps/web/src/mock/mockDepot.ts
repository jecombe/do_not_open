import { TRAIT_KEYS } from "@dno/game-spec";
import { mulberry32, resolveTraits, traitDef, type ResolvedTrait } from "@dno/generator";

/**
 * Mock mode only. Stands in for the chain until the ChainAdapter lands (Phase 4):
 * on-chain the seed is drawn with FHE randomness and nobody can compute it.
 */
export function mockSeedForToken(tokenId: number): bigint {
  const rand = mulberry32(Math.imul(tokenId + 1, 0x2545f491));
  return (BigInt(Math.floor(rand() * 2 ** 32)) << 32n) | BigInt(Math.floor(rand() * 2 ** 32));
}

export interface ShakeResult {
  trait: ResolvedTrait;
  traitName: string;
}

/** One trait, picked pseudo-randomly, readable by the holder only. Never the state. */
export function mockShake(tokenId: number, shakeCount: number): ShakeResult {
  const pick = mulberry32(Math.imul(tokenId + 31, 7919) + shakeCount * 104729);
  const key = TRAIT_KEYS[Math.floor(pick() * TRAIT_KEYS.length)]!;
  const trait = resolveTraits(mockSeedForToken(tokenId))[key];
  return { trait, traitName: traitDef(key).name };
}
