import { fold32, mulberry32 } from "./prng";

/**
 * The studio's rats: the depot's other residents, drawn for free in the browser. Nothing about
 * them is on-chain or rare; they are not cats on purpose, so nothing drawn in the studio can be
 * taken for a cat out of a box.
 */
export type RatCoat = "grey" | "brown" | "white" | "black" | "caramel" | "patched" | "hooded";
export type RatPose = "sit" | "stand" | "sniff";
export type RatProp = "none" | "cheese" | "crumb" | "fork";
export type RatHat = "none" | "party" | "beanie" | "crown" | "tophat" | "chef";
export type RatFace = "grin" | "teeth" | "tongue" | "smug" | "shock";
export type RatEyes = "dots" | "big" | "derp" | "sleepy" | "shades";

export interface RatSpec {
  seed: string;
  coat: RatCoat;
  /** Main fur, the patches or hood, the belly and the bare skin (ears, nose, hands, tail). */
  colors: { fur: string; patch: string; belly: string; skin: string; eye: string; outline: string };
  /** Multipliers around 1. */
  body: { girth: number; height: number; head: number; ears: number; snout: number; tail: number; teeth: number };
  pose: RatPose;
  face: RatFace;
  eyes: RatEyes;
  hat: RatHat;
  prop: RatProp;
  /** A bandana round the neck, in this colour, or none. */
  scarf: string | null;
  /** One ear with a bite out of it: a rat that has seen things. */
  nickedEar: boolean;
  animation: { sniffSpeed: number; tailSpeed: number; tailAmplitude: number; earSpeed: number; bounce: number };
}

interface CoatDef {
  fur: string[];
  patch: string[];
  belly: string[];
  skin: string;
  eye: string;
  outline: string;
}

const COATS: Record<RatCoat, CoatDef> = {
  grey: { fur: ["#8E8A93", "#9A96A0", "#7F7B86"], patch: ["#6E6A75"], belly: ["#D9D4DC"], skin: "#F2A7B5", eye: "#1A1410", outline: "#2A2430" },
  brown: { fur: ["#8A6248", "#9A6E50", "#7A5640"], patch: ["#5E4130"], belly: ["#E6D2BC"], skin: "#EFA0A8", eye: "#1A1410", outline: "#2C1E16" },
  white: { fur: ["#F3EFE8", "#EDE6DC"], patch: ["#DCD3C8"], belly: ["#FFFFFF"], skin: "#F7A9B8", eye: "#C2263A", outline: "#3A3036" },
  black: { fur: ["#34303A", "#2C2832"], patch: ["#1E1B22"], belly: ["#5A5560"], skin: "#C9848F", eye: "#F2C14E", outline: "#0E0C10" },
  caramel: { fur: ["#D49A5A", "#C88C4E", "#DDA868"], patch: ["#A86E36"], belly: ["#F5E3C8"], skin: "#F2A7B0", eye: "#1A1410", outline: "#3A2414" },
  patched: { fur: ["#F1ECE4"], patch: ["#5A4A40", "#8A6248", "#34303A"], belly: ["#FFFFFF"], skin: "#F4A6B4", eye: "#1A1410", outline: "#2C2420" },
  hooded: { fur: ["#F1ECE4"], patch: ["#34303A", "#7A5640", "#8E8A93"], belly: ["#FFFFFF"], skin: "#F4A6B4", eye: "#1A1410", outline: "#2C2420" },
};

const SCARVES = ["#C8102E", "#2E6FD8", "#F2C14E", "#3C9A5F", "#8E44AD"];

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

/** Picks from `[value, weight]` pairs. */
function weighted<T>(rand: () => number, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((n, [, w]) => n + w, 0);
  let r = rand() * total;
  for (const [value, w] of items) {
    r -= w;
    if (r < 0) return value;
  }
  return items[items.length - 1]![0];
}

const around = (rand: () => number, spread: number) => 1 + (rand() * 2 - 1) * spread;

/** A rat from any seed: the same seed always draws the same rat. */
export function buildRatSpec(seed: bigint): RatSpec {
  const rand = mulberry32(fold32(seed ^ 0x726174n));
  const coat = weighted<RatCoat>(rand, [
    ["grey", 3],
    ["brown", 3],
    ["white", 2],
    ["black", 2],
    ["caramel", 2],
    ["patched", 2],
    ["hooded", 2],
  ]);
  const def = COATS[coat];
  const eyes = weighted<RatEyes>(rand, [
    ["dots", 3],
    ["big", 4],
    ["derp", 2],
    ["sleepy", 2],
    ["shades", 1],
  ]);
  const face = weighted<RatFace>(rand, [
    ["grin", 3],
    ["teeth", 4],
    ["tongue", 2],
    ["smug", 2],
    ["shock", 1],
  ]);
  return {
    seed: seed.toString(),
    coat,
    colors: { fur: pick(rand, def.fur), patch: pick(rand, def.patch), belly: pick(rand, def.belly), skin: def.skin, eye: def.eye, outline: def.outline },
    body: {
      girth: around(rand, 0.22),
      height: around(rand, 0.1),
      head: around(rand, 0.12),
      ears: around(rand, 0.25),
      snout: around(rand, 0.18),
      tail: around(rand, 0.2),
      teeth: around(rand, 0.3),
    },
    pose: weighted<RatPose>(rand, [
      ["sit", 4],
      ["stand", 3],
      ["sniff", 2],
    ]),
    face,
    eyes,
    hat: weighted<RatHat>(rand, [
      ["none", 6],
      ["party", 2],
      ["beanie", 2],
      ["crown", 1],
      ["tophat", 1],
      ["chef", 1],
    ]),
    prop: weighted<RatProp>(rand, [
      ["none", 4],
      ["cheese", 4],
      ["crumb", 2],
      ["fork", 1],
    ]),
    scarf: rand() < 0.25 ? pick(rand, SCARVES) : null,
    nickedEar: rand() < 0.2,
    animation: {
      sniffSpeed: 9 + rand() * 7,
      tailSpeed: 1.6 + rand() * 1.4,
      tailAmplitude: 0.25 + rand() * 0.25,
      earSpeed: 0.7 + rand() * 0.8,
      bounce: rand() < 0.3 ? 0.03 : 0,
    },
  };
}
