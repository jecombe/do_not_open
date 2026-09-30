import { spec } from "@dno/game-spec";
import { mulberry32 } from "./prng";

/**
 * Look of a sealed box. Derived from the PUBLIC token id only: a sealed box must
 * never carry information about the encrypted seed, or the render would leak it.
 */
export interface BoxSpec {
  tokenId: number;
  serial: string;
  /** Depot routing code printed on the label. Cosmetic. */
  dock: string;
  weightKg: number;
  /** Lateral tape offset on the lid, as a fraction of the box width (-0.5..0.5). */
  tapeOffset: number;
  labelSkew: number;
  stampRotation: number;
  stampOffset: [number, number];
  /** 0 = fresh, 1 = battered. Drives scuffs and ink fade. */
  wear: number;
  dents: { face: number; u: number; v: number; radius: number }[];
  /** Seed for procedural texture noise. */
  noiseSeed: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function buildBoxSpec(tokenId: number): BoxSpec {
  if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId >= spec.collection.maxSupply) {
    throw new RangeError(`tokenId ${tokenId} outside 0..${spec.collection.maxSupply - 1}`);
  }
  const noiseSeed = (Math.imul(tokenId + 1, 0x9e3779b1) ^ 0xd0_0d_b0_c5) >>> 0;
  const rand = mulberry32(noiseSeed);
  const span = (spread: number) => (rand() * 2 - 1) * spread;

  const dents = Array.from({ length: Math.floor(rand() * 4) }, () => ({
    face: Math.floor(rand() * 4),
    u: round(0.15 + rand() * 0.7),
    v: round(0.15 + rand() * 0.7),
    radius: round(0.05 + rand() * 0.08),
  }));

  return {
    tokenId,
    serial: `DNO-${String(tokenId).padStart(4, "0")}`,
    dock: `${"ABCDEFGH"[Math.floor(rand() * 8)]}${10 + Math.floor(rand() * 90)}`,
    weightKg: round(3.2 + rand() * 3.1),
    tapeOffset: round(span(0.04)),
    labelSkew: round(span(0.06)),
    stampRotation: round(span(0.22) - 0.12),
    stampOffset: [round(span(0.08)), round(span(0.06))],
    wear: round(rand()),
    dents,
    noiseSeed,
  };
}
