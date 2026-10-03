import { fit, MAX_POST, type Draft } from "./herald";
import type { Manual, ManualPassage, ManualSection } from "./manual";

/**
 * The daily lesson: once a day the collection's account explains one part of how the game
 * works, from one passage of the player's manual. A model may word it, but only from that
 * passage's section, and what it writes is checked here before it is queued; when it fails the
 * checks, the post quotes the manual instead.
 */

/** A passage to explain, with the section it belongs to as context. */
export interface Topic {
  section: ManualSection;
  passage: ManualPassage;
  /** The whole section's text: what the model reads, and what its numbers are checked against. */
  context: string;
}

/** Sections never taught: the release form is legal wording, not something to paraphrase. */
const UNTAUGHT = new Set(["terms"]);

/**
 * Every passage of the players' part of the manual, in teaching order: each section's passages
 * spread evenly over the cycle (a section of eight comes back every few days, one of two twice),
 * so two days in a row rarely share a section.
 */
export function syllabus(manual: Manual): Topic[] {
  const sections = manual.sections.filter((s) => s.part === "manual" && !UNTAUGHT.has(s.id));
  return sections
    .flatMap((section, order) => {
      const passages = manual.passages.filter((p) => p.section === section.id);
      const context = passages.map((p) => (p.heading ? `${p.heading}\n${p.text}` : p.text)).join("\n\n");
      // Where in the cycle each passage falls: the middle of its slice.
      return passages.map((passage, i) => ({ topic: { section, passage, context }, at: (i + 0.5) / passages.length, order }));
    })
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map((t) => t.topic);
}

/** The topic of a UTC day ("2026-10-03"): the syllabus in a loop, one passage a day. */
export function topicOf(topics: Topic[], day: string): Topic | null {
  if (!topics.length) return null;
  const index = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  return topics[((index % topics.length) + topics.length) % topics.length]!;
}

/** X counts a link as 23 characters, plus the line break before it. */
const LINK_COST = 24;

/** Room left for the words, once the link to the manual is added. */
export const lessonBudget = (link: string | null) => (link ? MAX_POST - LINK_COST : MAX_POST);

/** What the model is told. The topic comes as the "manual", the request as the question. */
export function lessonInstructions(budget: number): string {
  return [
    "You write one post a day for the official channel of DO NOT OPEN, a collection of 10,000 sealed boxes with cats inside, on Zama's FHEVM, where the cats, the owners and the balances are encrypted on-chain.",
    "Each post explains one part of how the game works to people who have never played. Today's part is the FOCUS passage below; the SECTION around it is context.",
    "Use ONLY facts from the text below. Never invent a rule, a number, a price, a date, an address or a feature, and never round or change a number. If a fact is not there, leave it out.",
    "Explain ONE idea, the most interesting one in the FOCUS passage, so that a newcomer gets it. Plain English, short sentences.",
    "Say what the text says, not what follows from it: no conclusions, advice or warnings of your own, and never turn a reason the text gives into a different one.",
    `At most ${budget} characters, counting emoji as 2. Start with one fitting emoji. No hashtags, no @mentions, no links, no markdown, no quotation of the manual's headings.`,
    "Voice: the depot that keeps the boxes, dry and a little wry, fond of cats. Clarity first.",
    "Never give financial advice, price predictions, or tell anyone to buy; never call the system anonymous or say nothing at all is visible: the manual says what stays public.",
    'Return JSON: {"answer": the post, "sections": []}.',
  ].join("\n");
}

/** The topic as the model reads it. */
export function lessonSource(topic: Topic): string {
  return `SECTION: ${topic.section.title}\n${topic.context}\n\nFOCUS:\n${topic.passage.heading ? `${topic.passage.heading}\n` : ""}${topic.passage.text}`;
}

/** Wordings the official account never uses, whatever the passage says. */
const FORBIDDEN = [
  /\banonym/i,
  /\buntraceable\b/i,
  /\b100\s?%\s?(private|secret|safe|secure)/i,
  /\bguarantee/i,
  /\binvest/i,
  /\bprofit/i,
  /\bmoon\b/i,
  /\bpump/i,
  /\bfinancial advice\b/i,
  /\bbuy now\b/i,
  /\bairdrop/i,
  /\bgiveaway\b/i,
  /\bnot financial\b/i,
];

/** X's count: a character each, two for an emoji or anything outside the basic plane. */
export function postLength(text: string): number {
  let n = 0;
  for (const ch of text) n += /\p{Extended_Pictographic}/u.test(ch) || ch.codePointAt(0)! > 0xffff ? 2 : 1;
  return n;
}

/** "10,000" and "10000" are the same number; "2.5" stays a decimal. */
const numbersIn = (text: string) => (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((m) => m.replace(/,(?=\d{3}\b)/g, ""));

/** Why a model's post cannot go out, or null when it can. */
export function lessonProblem(text: string, topic: Topic, budget: number): string | null {
  if (!text.trim()) return "empty";
  if (postLength(text) > budget) return `too long (${postLength(text)} > ${budget})`;
  if (/0x[0-9a-f]{6,}/i.test(text)) return "an address";
  if (/https?:\/\/|www\.|\.(com|xyz|io)\b/i.test(text)) return "a link";
  if (/(^|\s)[#@]\w/.test(text)) return "a hashtag or a mention";
  if (/\*\*|__|^#+\s/m.test(text)) return "markdown";
  const bad = FORBIDDEN.find((r) => r.test(text));
  if (bad) return `a forbidden wording (${bad.source})`;
  const known = new Set(numbersIn(`${topic.section.title}\n${topic.context}`));
  const unknown = numbersIn(text).filter((x) => !known.has(x));
  if (unknown.length) return `numbers not in the manual: ${unknown.join(", ")}`;
  return null;
}

/** The finished post: the words, then the link to the section, if there is one. */
export function lessonDraft(day: string, text: string, link: string | null): Draft {
  return { key: `lesson:${day}`, kind: "lesson", text: link ? `${text.trim()}\n${link}` : text.trim() };
}

/** When no model can write it, or what it wrote failed the checks: the manual, quoted. */
export function quotedLesson(day: string, topic: Topic, link: string | null): Draft {
  const budget = lessonBudget(link) - postLength(`📖 ${topic.section.title}\n“”`);
  const sentences = (text: string) =>
    text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      // A row of a table reads badly out of it.
      .filter((s) => s && !s.includes(" | "));
  let picked = sentences(topic.passage.text);
  if (!picked.length) picked = sentences(topic.context);
  let quote = "";
  for (const s of picked) {
    const next = quote ? `${quote} ${s}` : s;
    if (postLength(next) > budget) break;
    quote = next;
  }
  if (!quote) quote = fit(picked[0] ?? topic.section.title, budget);
  return lessonDraft(day, `📖 ${topic.section.title}\n“${quote}”`, link);
}
