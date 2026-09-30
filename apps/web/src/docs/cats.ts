import { spec, type StateKey, type TraitKey } from "@dno/game-spec";
import { buildCatSpec, encodeSeed, viceFromCosmetic, type CatSpec, type Vice } from "@dno/generator";

/** The line-ups the cat parade can show. */
export type CatSet = "breeds" | "states" | "vices" | "extras";
export const CAT_SETS: readonly CatSet[] = ["breeds", "states", "vices", "extras"];

export interface RosterCat {
  /** Names the blurb: `docs.cats.<set>.<key>` in the dictionaries. */
  key: string;
  cat: CatSpec;
  /** Share of boxes that hold this kind of cat, 0..1. Null when it depends on play, not luck. */
  odds: number | null;
}

const traitDef = (key: TraitKey) => spec.traits.find((t) => t.key === key)!;

/** Lowest roll that lands on a variant. */
function rollFor(key: TraitKey, variant: string): number {
  let roll = 0;
  for (const v of traitDef(key).variants) {
    if (v.key === variant) return roll;
    roll += v.width;
  }
  throw new Error(`no ${key} "${variant}"`);
}

function share(key: TraitKey, variant: string): number {
  const def = traitDef(key);
  const total = def.variants.reduce((sum, v) => sum + v.width, 0);
  return def.variants.find((v) => v.key === variant)!.width / total;
}

function stateShare(key: StateKey): number {
  const i = spec.states.findIndex((s) => s.key === key);
  return (spec.states[i]!.rollBelow - (spec.states[i - 1]?.rollBelow ?? 0)) / 65536;
}

/** Cosmetic bytes that give a vice, out of 256. */
function viceShare(vice: Vice): number {
  let n = 0;
  for (let c = 0; c < 256; c++) if (viceFromCosmetic(c) === vice) n++;
  return n / 256;
}

interface Pick {
  breed?: string;
  mood?: string;
  accessory?: string;
  state?: StateKey;
  cosmetic?: number;
  affection?: number;
}

function catFor(pick: Pick): CatSpec {
  const state = spec.states.findIndex((s) => s.key === (pick.state ?? "alive"));
  const seed = encodeSeed({
    stateRoll: state === 0 ? 0 : spec.states[state - 1]!.rollBelow,
    rolls: {
      breed: rollFor("breed", pick.breed ?? "orange"),
      mood: rollFor("mood", pick.mood ?? "unbothered"),
      accessory: rollFor("accessory", pick.accessory ?? "none"),
      brokenThing: 0,
      room: 0,
    },
    cosmetic: pick.cosmetic ?? 1,
  });
  return buildCatSpec({ seed, affection: pick.affection ?? 0 });
}

/** A mood per breed, so the line-up shows off the poses and faces as well. */
const BREED_MOODS: Record<string, string> = {
  tabby: "unbothered",
  tuxedo: "judging",
  orange: "hungry",
  calico: "smug",
  siamese: "plotting",
  void: "judging",
  sphynx: "betrayed",
  maineCoon: "unbothered",
  loaf: "smug",
  glitch: "zoomies",
};

let cache: Record<CatSet, RosterCat[]> | null = null;

/** Every cat the parade can show, built once. */
export function roster(): Record<CatSet, RosterCat[]> {
  if (cache) return cache;
  cache = {
    breeds: traitDef("breed").variants.map((v) => ({
      key: v.key,
      cat: catFor({ breed: v.key, mood: BREED_MOODS[v.key] }),
      odds: share("breed", v.key),
    })),
    states: spec.states.map((s) => ({
      key: s.key,
      cat: catFor({ breed: "orange", mood: s.key === "quantum" ? "zoomies" : "unbothered", state: s.key }),
      odds: stateShare(s.key),
    })),
    vices: [
      // Cosmetic bytes 42 and 13 are the first that give each vice.
      { key: "stoned", cat: catFor({ breed: "tabby", cosmetic: 42 }), odds: viceShare("stoned") },
      { key: "drunk", cat: catFor({ breed: "tuxedo", cosmetic: 13 }), odds: viceShare("drunk") },
    ],
    extras: [
      { key: "golden", cat: catFor({ breed: "calico", accessory: "crown", affection: spec.affection.goldenThreshold + 1 }), odds: null },
      { key: "wizard", cat: catFor({ breed: "void", mood: "enlightened", accessory: "wizardHat" }), odds: share("mood", "enlightened") * share("accessory", "wizardHat") },
    ],
  };
  return cache;
}

/** "1 in 20" style odds for the rarer cats, rounded to something a person would say. */
export function oneIn(odds: number): number {
  const n = 1 / odds;
  if (n < 10) return Math.round(n);
  if (n < 100) return Math.round(n / 5) * 5;
  return Math.round(n / 50) * 50;
}
