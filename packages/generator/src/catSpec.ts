import { spec, type StateKey, type TierKey, type TraitKey } from "@dno/game-spec";
import { decodeSeed, normalizeSeed, seedToHex } from "./seed";
import { fold32, mulberry32 } from "./prng";
import { rarityScore, tierForScore } from "./rarity";
import { resolveTrait, stateDef, stateFromRoll, type ResolvedTrait } from "./traits";

export type FurPattern = "solid" | "tabby" | "tuxedo" | "calico" | "points" | "hairless" | "loaf" | "glitch";
export type EarShape = "pointed" | "large" | "tufted" | "round";
export type EyeShape = "round" | "half" | "narrow" | "wide" | "closed" | "happy";
export type PupilShape = "slit" | "round" | "huge";
export type MouthShape = "neutral" | "frown" | "smirk" | "open" | "smile";
export type Pose = "sit" | "loaf" | "crouch" | "curl" | "float";

export interface CatBody {
  pattern: FurPattern;
  furBase: string;
  furSecondary: string;
  furTertiary: string;
  furBelly: string;
  skin: string;
  outline: string;
  earShape: EarShape;
  /** Multipliers around 1. */
  girth: number;
  headSize: number;
  earSize: number;
  tailLength: number;
  tailFluff: number;
  mane: boolean;
}

export interface CatFace {
  eyeShape: EyeShape;
  pupil: PupilShape;
  mouth: MouthShape;
  eyeColorLeft: string;
  eyeColorRight: string;
  /** Radians. Negative tilts the inner brow down (stern). */
  browTilt: number;
  earsFlat: boolean;
  headTilt: number;
}

export interface CatAnimation {
  tailSpeed: number;
  tailAmplitude: number;
  breatheSpeed: number;
  bounce: number;
  float: boolean;
  flicker: boolean;
}

export interface CatRoom {
  key: string;
  floor: string;
  wall: string;
  accent: string;
  light: string;
}

export interface CatSpec {
  seed: string;
  state: StateKey;
  affection: number;
  traits: Record<TraitKey, ResolvedTrait>;
  rarity: { score: number; tier: TierKey; tierName: string; golden: boolean };
  body: CatBody;
  /** Second form a quantum cat flickers into. Null for every other state. */
  altBody: CatBody | null;
  face: CatFace;
  pose: Pose;
  animation: CatAnimation;
  accessory: { key: string; golden: boolean; color: string };
  brokenThing: { key: string };
  room: CatRoom;
  render: { ghost: boolean; quantum: boolean; opacity: number };
}

type BreedLook = Omit<CatBody, "girth" | "headSize" | "earSize" | "tailLength"> & { eye: string };

const base = { skin: "#E8A5A0", outline: "#1A1410", earShape: "pointed" as EarShape, tailFluff: 1, mane: false };

const BREEDS: Record<string, BreedLook> = {
  tabby: { ...base, pattern: "tabby", furBase: "#9A7B5B", furSecondary: "#4A3728", furTertiary: "#4A3728", furBelly: "#DCC8A8", eye: "#8FB339" },
  tuxedo: { ...base, pattern: "tuxedo", furBase: "#25232A", furSecondary: "#F2EEE6", furTertiary: "#F2EEE6", furBelly: "#F2EEE6", eye: "#E8C547" },
  orange: { ...base, pattern: "tabby", furBase: "#E8893A", furSecondary: "#B85C1E", furTertiary: "#B85C1E", furBelly: "#F8DDB8", eye: "#C9A227" },
  calico: { ...base, pattern: "calico", furBase: "#F3EDE2", furSecondary: "#D9772E", furTertiary: "#2B2622", furBelly: "#F3EDE2", eye: "#7FA650" },
  siamese: { ...base, pattern: "points", furBase: "#EADFCB", furSecondary: "#4B382E", furTertiary: "#4B382E", furBelly: "#F4ECDC", eye: "#4FA3E0" },
  void: { ...base, pattern: "solid", furBase: "#121016", furSecondary: "#121016", furTertiary: "#121016", furBelly: "#121016", outline: "#4A4560", skin: "#2A2430", eye: "#F5D93A" },
  sphynx: { ...base, pattern: "hairless", furBase: "#E2B6A4", furSecondary: "#C99583", furTertiary: "#C99583", furBelly: "#EBC7B7", earShape: "large", tailFluff: 0.55, eye: "#6FC3C9" },
  maineCoon: { ...base, pattern: "tabby", furBase: "#7A5A3E", furSecondary: "#3E2A1C", furTertiary: "#3E2A1C", furBelly: "#CDB392", earShape: "tufted", tailFluff: 1.9, mane: true, eye: "#D9A441" },
  loaf: { ...base, pattern: "loaf", furBase: "#D9A55C", furSecondary: "#8A5A2B", furTertiary: "#F3DFB5", furBelly: "#F3DFB5", earShape: "round", tailFluff: 0.8, eye: "#3B2A1A" },
  glitch: { ...base, pattern: "glitch", furBase: "#1B1B2A", furSecondary: "#FF2BD6", furTertiary: "#29F0FF", furBelly: "#2A2A40", outline: "#29F0FF", eye: "#29F0FF" },
};

interface MoodLook {
  eyeShape: EyeShape;
  pupil: PupilShape;
  mouth: MouthShape;
  browTilt: number;
  earsFlat: boolean;
  pose: Pose;
  tailSpeed: number;
  tailAmplitude: number;
  bounce: number;
}

const MOODS: Record<string, MoodLook> = {
  unbothered: { eyeShape: "half", pupil: "slit", mouth: "neutral", browTilt: 0, earsFlat: false, pose: "sit", tailSpeed: 0.8, tailAmplitude: 0.25, bounce: 0 },
  judging: { eyeShape: "narrow", pupil: "slit", mouth: "frown", browTilt: -0.35, earsFlat: false, pose: "sit", tailSpeed: 1.6, tailAmplitude: 0.18, bounce: 0 },
  zoomies: { eyeShape: "wide", pupil: "huge", mouth: "open", browTilt: 0.1, earsFlat: false, pose: "crouch", tailSpeed: 5, tailAmplitude: 0.5, bounce: 0.06 },
  hungry: { eyeShape: "round", pupil: "huge", mouth: "open", browTilt: 0.25, earsFlat: false, pose: "sit", tailSpeed: 1.2, tailAmplitude: 0.3, bounce: 0.015 },
  smug: { eyeShape: "happy", pupil: "round", mouth: "smirk", browTilt: 0, earsFlat: false, pose: "loaf", tailSpeed: 1, tailAmplitude: 0.35, bounce: 0 },
  betrayed: { eyeShape: "wide", pupil: "slit", mouth: "frown", browTilt: 0.35, earsFlat: true, pose: "sit", tailSpeed: 0.4, tailAmplitude: 0.1, bounce: 0 },
  plotting: { eyeShape: "narrow", pupil: "slit", mouth: "smirk", browTilt: -0.25, earsFlat: false, pose: "crouch", tailSpeed: 2.2, tailAmplitude: 0.22, bounce: 0 },
  enlightened: { eyeShape: "closed", pupil: "round", mouth: "smile", browTilt: 0, earsFlat: false, pose: "float", tailSpeed: 0.5, tailAmplitude: 0.4, bounce: 0 },
};

const ROOMS: Record<string, Omit<CatRoom, "key">> = {
  livingRoom: { floor: "#8A5F3C", wall: "#C9B79C", accent: "#B5533C", light: "#FFD9A0" },
  kitchen: { floor: "#D8D2C4", wall: "#9DB8A8", accent: "#E3B23C", light: "#FFF1D0" },
  bedroom: { floor: "#6E5A6B", wall: "#B9A9C9", accent: "#F0C6B4", light: "#FFCFA8" },
  bathroom: { floor: "#9CC2C9", wall: "#E4EEF0", accent: "#3D7A8A", light: "#E8F6FF" },
  attic: { floor: "#5C4632", wall: "#7A6248", accent: "#C99A4E", light: "#FFB870" },
  serverRoom: { floor: "#1F2630", wall: "#2C3644", accent: "#3DDC97", light: "#7FB8FF" },
  laboratory: { floor: "#C9D1D6", wall: "#EEF2F3", accent: "#8E5BD9", light: "#D8FFE8" },
  theVoid: { floor: "#0B0A12", wall: "#151226", accent: "#7DE3D0", light: "#9A8CFF" },
};

const ACCESSORY_COLORS: Record<string, string> = {
  none: "#000000",
  bellCollar: "#C2261D",
  bowTie: "#2B4C9B",
  bandana: "#D94F30",
  sunglasses: "#15151A",
  partyHat: "#E85D9C",
  monocle: "#C9A227",
  wizardHat: "#4B3A9B",
  crown: "#E8B931",
  halo: "#FFF3B0",
};

export const GOLD = "#F2C230";

function lookup<T>(table: Record<string, T>, key: string, what: string): T {
  const v = table[key];
  if (!v) throw new Error(`no ${what} look for "${key}"`);
  return v;
}

function bodyFor(breed: string, rand: () => number): CatBody {
  const { eye: _eye, ...look } = lookup(BREEDS, breed, "breed");
  const jitter = (spread: number) => 1 + (rand() * 2 - 1) * spread;
  return {
    ...look,
    girth: round(jitter(0.1) * (breed === "maineCoon" ? 1.15 : breed === "sphynx" ? 0.9 : 1)),
    headSize: round(jitter(0.06)),
    earSize: round(jitter(0.12) * (look.earShape === "large" ? 1.35 : 1)),
    tailLength: round(jitter(0.15) * (breed === "loaf" ? 0.5 : 1)),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export interface CatSpecInput {
  seed: bigint | string | number;
  /** Encrypted affection counter, known only at reveal. Defaults to 0. */
  affection?: number;
  /** Optional cross-check against the state decrypted on-chain. Must match the seed. */
  state?: StateKey | number;
}

/** seed (+ affection) -> everything the renderer needs. Pure and deterministic. */
export function buildCatSpec(input: CatSpecInput): CatSpec {
  const seed = normalizeSeed(input.seed);
  const affection = input.affection ?? 0;
  const decoded = decodeSeed(seed);
  const state = stateFromRoll(decoded.stateRoll);
  if (input.state !== undefined && stateDef(input.state).id !== state.id) {
    throw new Error(`state "${input.state}" does not match the seed (derives "${state.key}")`);
  }

  const traits = {
    breed: resolveTrait("breed", decoded.rolls.breed),
    mood: resolveTrait("mood", decoded.rolls.mood),
    accessory: resolveTrait("accessory", decoded.rolls.accessory),
    brokenThing: resolveTrait("brokenThing", decoded.rolls.brokenThing),
    room: resolveTrait("room", decoded.rolls.room),
  };

  const rand = mulberry32(fold32(seed));
  const breedLook = lookup(BREEDS, traits.breed.variant, "breed");
  const body = bodyFor(traits.breed.variant, rand);
  const mood = lookup(MOODS, traits.mood.variant, "mood");

  // One cat in 32 has odd eyes. Driven by the cosmetic byte so it never affects rarity.
  const oddEyes = decoded.cosmetic % 32 === 0;
  const face: CatFace = {
    eyeShape: mood.eyeShape,
    pupil: mood.pupil,
    mouth: mood.mouth,
    eyeColorLeft: breedLook.eye,
    eyeColorRight: oddEyes ? "#4FA3E0" : breedLook.eye,
    browTilt: mood.browTilt,
    earsFlat: mood.earsFlat,
    headTilt: round((rand() * 2 - 1) * 0.12),
  };

  let pose: Pose = body.pattern === "loaf" ? "loaf" : mood.pose;
  const animation: CatAnimation = {
    tailSpeed: mood.tailSpeed,
    tailAmplitude: mood.tailAmplitude,
    breatheSpeed: 1.4,
    bounce: mood.bounce,
    float: pose === "float",
    flicker: false,
  };

  let altBody: CatBody | null = null;
  const render = { ghost: false, quantum: false, opacity: 1 };

  if (state.key === "asleep") {
    pose = "curl";
    face.eyeShape = "closed";
    face.mouth = "neutral";
    face.browTilt = 0;
    face.earsFlat = false;
    Object.assign(animation, { tailSpeed: 0.2, tailAmplitude: 0.05, breatheSpeed: 0.7, bounce: 0, float: false });
  } else if (state.key === "ghost") {
    render.ghost = true;
    render.opacity = 0.55;
    animation.float = true;
    animation.bounce = 0;
  } else if (state.key === "quantum") {
    render.quantum = true;
    animation.flicker = true;
    // The second form is another breed picked from the cosmetic byte, never the same as the first.
    const breeds = spec.traits[0]!.variants;
    const offset = 1 + (decoded.cosmetic % (breeds.length - 1));
    const alt = breeds[(traits.breed.variantIndex + offset) % breeds.length]!;
    altBody = bodyFor(alt.key, rand);
  }

  const golden = affection > spec.affection.goldenThreshold;
  const baseScore = rarityScore(decoded.rolls, state.scoreBonus);
  const tier = tierForScore(baseScore);
  const roomKey = traits.room.variant;

  return {
    seed: seedToHex(seed),
    state: state.key,
    affection,
    traits,
    rarity: {
      score: baseScore + (golden ? spec.affection.goldenScoreBonus : 0),
      tier: tier.key,
      tierName: tier.name,
      golden,
    },
    body,
    altBody,
    face,
    pose,
    animation,
    accessory: {
      key: traits.accessory.variant,
      golden,
      color: golden ? GOLD : lookup(ACCESSORY_COLORS, traits.accessory.variant, "accessory"),
    },
    brokenThing: { key: traits.brokenThing.variant },
    room: { key: roomKey, ...lookup(ROOMS, roomKey, "room") },
    render,
  };
}
