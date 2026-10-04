import type { Address } from "./types";

export type StudioKind = "sketch" | "model";
/**
 * `failed`: the service could not draw it, and its unit came back. `rejected`: the service ran
 * (and billed the collection) but the result was refused, by the safety checker or because the
 * account already got its refunds of the day back: the unit is kept.
 */
export type StudioJobStatus = "running" | "done" | "failed" | "rejected";

/** Units of each kind: bought on-chain, or held by jobs. */
export interface StudioUnits {
  sketches: number;
  models: number;
}

/**
 * One generation. Creating it spends one unit of its kind; a failed job gives it back. Not on the
 * chain: a replay keeps every job.
 */
export interface StudioJob {
  id: string;
  account: Address;
  kind: StudioKind;
  status: StudioJobStatus;
  /** The player's words, as typed (trimmed). For a model, its sketch's. */
  prompt: string;
  /** The sketch a model was made from. Null for a sketch. */
  sketchId: string | null;
  /** Where the service left the result (a picture for a sketch, a GLB for a model), once done. */
  resultUrl: string | null;
  error: string | null;
  /** What the job is expected to cost the collection, in dollars, counted against the daily budget. */
  costUsd: number;
  /** Unix seconds. */
  createdAt: number;
  finishedAt: number | null;
}

/** What `startStudioJob` decides on: the account's units and what the studio spent today. */
export interface StudioLedger {
  bought: StudioUnits;
  /** Units held by the account's running and finished jobs. */
  used: StudioUnits;
  /** Dollars of every job started today, failed ones included (the service may have billed them), every account together. */
  spentTodayUsd: number;
}

export const NO_UNITS: StudioUnits = { sketches: 0, models: 0 };

export const unitOf = (kind: StudioKind): keyof StudioUnits => (kind === "sketch" ? "sketches" : "models");

export function unitsLeft(bought: StudioUnits, used: StudioUnits): StudioUnits {
  return { sketches: Math.max(0, bought.sketches - used.sketches), models: Math.max(0, bought.models - used.models) };
}

/** Units held by these jobs: running, finished and rejected ones hold theirs, failed ones gave it back. */
export function unitsHeld(jobs: Pick<StudioJob, "kind" | "status">[]): StudioUnits {
  const held = { sketches: 0, models: 0 };
  for (const j of jobs) if (j.status !== "failed") held[unitOf(j.kind)]++;
  return held;
}

/** The start of the UTC day `now` (unix seconds) falls in: the daily budget resets there. */
export const dayStart = (now: number): number => Math.floor(now / 86_400) * 86_400;

/**
 * Words that keep a prompt from reaching a paid service: licensed characters and brands (the
 * picture would be theirs, not ours), and adult or violent content. Matched on whole words,
 * case and accents ignored. Short on purpose: the image service has its own safety checker.
 */
const REFUSED_WORDS = [
  // licensed characters and brands
  "pikachu", "pokemon", "garfield", "hello kitty", "hellokitty", "doraemon", "sylvester", "tom and jerry", "felix the cat",
  "puss in boots", "cheshire", "nyan", "grumpy cat", "mickey", "disney", "pixar", "marvel", "dc comics", "batman", "spiderman",
  "spider-man", "superman", "sonic", "mario", "nintendo", "totoro", "ghibli", "simba", "lion king", "aristocats", "catwoman",
  "star wars", "harry potter", "minecraft", "fortnite", "barbie", "nike", "adidas", "gucci", "coca-cola", "mcdonald",
  // adult, violent, hateful
  "nude", "naked", "nsfw", "porn", "sex", "sexy", "hentai", "boobs", "breasts", "genitals", "fetish", "erotic", "lingerie",
  "gore", "blood", "bloody", "corpse", "decapitated", "torture", "dead cat", "kill", "murder", "suicide", "nazi", "swastika", "kkk",
];

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The first refused word the prompt contains, or null. */
export function refusedWord(prompt: string): string | null {
  const text = ` ${fold(prompt).replace(/[^a-z0-9-]+/g, " ")} `;
  for (const word of REFUSED_WORDS) if (text.includes(` ${word} `)) return word;
  return null;
}
