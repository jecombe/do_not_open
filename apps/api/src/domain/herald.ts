import { spec, TRAIT_KEYS } from "@dno/game-spec";
import { decodeSeed, resolveTrait, stateDef, tierForScore } from "@dno/generator";
import type { Enrichment, ProtocolEvent } from "./events";
import type { RevealedContents } from "./types";

/**
 * What the collection's own account says about the protocol, worded from public facts only.
 * Plain templates, no model: the official account must never get a fact wrong. Nothing here
 * names a wallet, not even an opener's, though that one is public.
 *
 * Two marks tell the posts apart: 🔓 when the chain has just decrypted something for everyone
 * (an opening, a duel, the vet...), 🔒 when something happened under encryption (a mint, a
 * shake, a pet, a meal). A 🔒 post says only what anyone can see, that it happened, and leaves
 * the rest in doubt: never what the buyer got, whether the shaker held the box, or whether a
 * meal went in.
 */
export type PostKind = "opening" | "milestone" | "duel" | "entangled" | "vet" | "weighIn" | "mint" | "shake" | "pet" | "meal" | "digest" | "lesson";

/** The chain has just made this public. */
export const REVEALED = "🔓";
/** This happened under encryption: only that it happened is public. */
export const SEALED = "🔒";

export interface Draft {
  /** Identity of what the post is about: the same fact is never queued twice. */
  key: string;
  kind: PostKind;
  text: string;
}

/** X counts every character, a link as 23 and an emoji as 2: this leaves room for both. */
export const MAX_POST = 270;

export const serial = (tokenId: number): string => `DNO-${String(tokenId).padStart(4, "0")}`;

const n = (v: number) => v.toLocaleString("en-US");

/** "a ghost Maine Coon": the state, unless it is the plain one, then the breed. */
function catOf(c: Pick<RevealedContents, "seed" | "state">): { cat: string; mood: string; accessory: string | null; brokeIt: string | null; room: string } {
  const { rolls } = decodeSeed(c.seed);
  const t = (k: (typeof TRAIT_KEYS)[number]) => resolveTrait(k, rolls[k]);
  const state = stateDef(c.state).key;
  const adjective = state === "alive" ? "" : state === "asleep" ? "sleeping " : `${state} `;
  const breed = t("breed").name;
  const article = /^[aeiou]/i.test(adjective || breed) ? "an" : "a";
  const accessory = t("accessory").variantIndex === 0 ? null : t("accessory").name;
  const brokeIt = t("brokenThing").variantIndex === 0 ? null : t("brokenThing").name;
  return { cat: `${article} ${adjective}${breed}`, mood: t("mood").name, accessory, brokeIt, room: t("room").name };
}

/** Cuts a post to fit, at a line or a word, never mid-word. */
export function fit(text: string, max = MAX_POST): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return `${cut.slice(0, at > max / 2 ? at : cut.length).trimEnd()}…`;
}

export interface HeraldContext {
  /** Where a box can be looked at, e.g. "https://donotopen.xyz/app.html?box=". Without it, no link. */
  boxUrl?: string | null;
  /** Also post what happens under encryption (mints, shakes, pets, meals): many posts, so only where they are free. */
  sealed?: boolean;
}

function opening(e: Extract<ProtocolEvent, { name: "Observed" }>, contents: RevealedContents | undefined, ctx: HeraldContext): Draft {
  const c = catOf(contents ?? e);
  const tier = tierForScore(e.score).name;
  const lines = [
    `📦 ${serial(e.tokenId)} has been opened.`,
    `Inside: ${c.cat}, ${c.mood.toLowerCase()}${c.accessory ? `, wearing ${/^[aeiou]/i.test(c.accessory) ? "an" : "a"} ${c.accessory.toLowerCase()}` : ""}${e.golden ? " ✨ golden" : ""}.`,
    c.brokeIt ? `Found in the ${c.room.replace(/^The /, "").toLowerCase()}, next to a broken ${c.brokeIt.toLowerCase()}.` : `Found in the ${c.room.replace(/^The /, "").toLowerCase()}.`,
    `Score ${n(e.score)} · ${tier}.`,
  ];
  if (ctx.boxUrl) lines.push(`${ctx.boxUrl}${e.tokenId}`);
  return { key: `opening:${e.tokenId}`, kind: "opening", text: fit(lines.join("\n")) };
}

function milestone(e: Extract<ProtocolEvent, { name: "MilestoneReached" }>): Draft {
  const all = spec.collection.milestones;
  const next = all.find((m) => m > e.sold);
  const tail = next ? `The counter stays silent until ${n(next)}.` : "That was the last box. The depot is sold out.";
  return { key: `milestone:${e.index}`, kind: "milestone", text: fit(`🏷️ ${n(e.sold)} boxes sold.\nHow many each buyer took is encrypted; only milestones are ever announced. ${tail}`) };
}

function duel(e: Extract<ProtocolEvent, { name: "DuelResolved" }>): Draft {
  const trait = spec.traits[e.traitIndex]?.name.toLowerCase() ?? "a trait";
  return {
    key: `duel:${e.duelId}`,
    kind: "duel",
    text: fit(`⚔️ Duel #${e.duelId}: ${serial(e.winner)} beat ${serial(e.loser)} on ${trait}.\nBoth boxes stay sealed. Neither cat was seen; only the winner is known.`),
  };
}

function entangled(e: Extract<ProtocolEvent, { name: "Entangled" }>): Draft {
  return {
    key: `entangled:${e.tokenA}:${e.tokenB}`,
    kind: "entangled",
    text: fit(`🧵 ${serial(e.tokenA)} and ${serial(e.tokenB)} are now entangled.\nOpen one, and the other opens with it.`),
  };
}

function vet(e: Extract<ProtocolEvent, { name: "AliveProven" }>): Draft {
  const verdict = e.alive ? "a heartbeat. Alive, and still sealed." : "no heartbeat. Whatever is in there, it is not alive.";
  return { key: `vet:${e.tokenId}`, kind: "vet", text: fit(`🩺 The vet put a stethoscope to ${serial(e.tokenId)}: ${verdict}`) };
}

const DISEASES: Record<string, string> = { diabetic: "diabetes", arthritic: "arthritis", fattyLiver: "a fatty liver" };

function weighIn(e: Extract<ProtocolEvent, { name: "Weighed" }>, enrichment: Enrichment | null): Draft {
  const build = enrichment?.weighIn?.build ?? (["thin", "normal", "chubby", "fat", "huge"][e.build] as string | undefined) ?? "weighed";
  const disease = enrichment?.weighIn?.disease ?? null;
  const sick = enrichment?.weighIn?.sick ?? e.sick;
  const tail = sick ? ` The vet is worried${disease ? `: ${DISEASES[disease] ?? disease}` : ""}. Fewer croquettes, maybe.` : "";
  return { key: `weighIn:${e.tokenId}`, kind: "weighIn", text: fit(`⚖️ ${serial(e.tokenId)} stepped on the scale: ${build}.${tail}`) };
}

function mint(e: Extract<ProtocolEvent, { name: "MintPlaced" }>): Draft {
  const first = serial(e.firstTokenId);
  const text =
    e.count === 1
      ? `🚚 One box number just left the depot: ${first}.\nIs anything in it? Only the buyer knows.`
      : `🚚 ${n(e.count)} box numbers just left the depot: ${first} to ${serial(e.firstTokenId + e.count - 1)}.\nSome hold a cat, some may be empty. Only the buyer knows which.`;
  return { key: `mint:${e.firstTokenId}`, kind: "mint", text: fit(text) };
}

/** Shakes, pets and meals come again and again: each is its own fact, keyed by its log. */
const logKey = (kind: string, e: ProtocolEvent) => `${kind}:${e.txHash}:${e.logIndex}`;

function shake(e: Extract<ProtocolEvent, { name: "Shaken" }>): Draft {
  return {
    key: logKey("shake", e),
    kind: "shake",
    text: fit(`🫨 Someone shook ${serial(e.tokenId)}.\nIf they hold it, they felt something move. If not, they felt nothing. Only they know which.`),
  };
}

function pet(e: Extract<ProtocolEvent, { name: "Fed" }>): Draft {
  return {
    key: logKey("pet", e),
    kind: "pet",
    text: fit(`🐾 Someone petted ${serial(e.tokenId)} through the cardboard.\nWhether it counted stays sealed. Whatever is inside may remember.`),
  };
}

function meal(e: Extract<ProtocolEvent, { name: "MealServed" }>): Draft {
  return {
    key: logKey("meal", e),
    kind: "meal",
    text: fit(`🍪 Croquettes were offered to ${serial(e.tokenId)}.\nHow many, and whether any got in, stays sealed until the scale.`),
  };
}

const mark = (sign: string, d: Draft): Draft => ({ ...d, text: fit(`${sign} ${d.text}`) });

/** The posts a batch of events calls for, in chain order. Everything else is left to the daily digest. */
export function draftsFor(events: { event: ProtocolEvent; enrichment: Enrichment | null }[], ctx: HeraldContext = {}): Draft[] {
  const out: Draft[] = [];
  for (const { event: e, enrichment } of events) {
    if (e.name === "Observed") out.push(mark(REVEALED, opening(e, enrichment?.contents, ctx)));
    else if (e.name === "MilestoneReached") out.push(mark(REVEALED, milestone(e)));
    else if (e.name === "DuelResolved") out.push(mark(REVEALED, duel(e)));
    else if (e.name === "Entangled") out.push(mark(REVEALED, entangled(e)));
    else if (e.name === "AliveProven") out.push(mark(REVEALED, vet(e)));
    else if (e.name === "Weighed") out.push(mark(REVEALED, weighIn(e, enrichment)));
    else if (!ctx.sealed) continue;
    else if (e.name === "MintPlaced") out.push(mark(SEALED, mint(e)));
    else if (e.name === "Shaken") out.push(mark(SEALED, shake(e)));
    else if (e.name === "Fed") out.push(mark(SEALED, pet(e)));
    else if (e.name === "MealServed") out.push(mark(SEALED, meal(e)));
  }
  return out;
}

export interface Tally {
  shipped: number;
  shakes: number;
  pets: number;
  meals: number;
  opened: number;
  duels: number;
}

export function tallyOf(events: ProtocolEvent[]): Tally {
  const t: Tally = { shipped: 0, shakes: 0, pets: 0, meals: 0, opened: 0, duels: 0 };
  for (const e of events) {
    if (e.name === "MintPlaced") t.shipped += e.count;
    else if (e.name === "Shaken") t.shakes++;
    else if (e.name === "Fed") t.pets++;
    else if (e.name === "MealServed") t.meals++;
    else if (e.name === "Observed") t.opened++;
    else if (e.name === "DuelResolved") t.duels++;
  }
  return t;
}

/** The day at the depot, in a few lines. Null on a day nothing happened: silence says it better. */
export function digest(day: string, t: Tally): Draft | null {
  const rows = [
    t.shipped && `• ${n(t.shipped)} box numbers shipped`,
    t.shakes && `• ${n(t.shakes)} ${t.shakes === 1 ? "box" : "boxes"} shaken`,
    t.pets && `• ${n(t.pets)} ${t.pets === 1 ? "cat" : "cats"} petted through the cardboard`,
    t.meals && `• ${n(t.meals)} ${t.meals === 1 ? "meal" : "meals"} of croquettes served`,
    t.opened && `• ${n(t.opened)} ${t.opened === 1 ? "box" : "boxes"} opened`,
    t.duels && `• ${n(t.duels)} ${t.duels === 1 ? "duel" : "duels"} settled`,
  ].filter(Boolean);
  if (!rows.length) return null;
  return { key: `digest:${day}`, kind: "digest", text: fit(`📋 Today at the depot:\n${rows.join("\n")}\nWho did any of it? Nobody knows. Not even us.`) };
}
