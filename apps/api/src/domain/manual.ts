/**
 * The player's manual as the chatbot reads it: sections and passages per language, exported
 * from the web app's rendered manual. Searching it needs no model: a plain BM25 ranking, used
 * when no model can answer, so the chat still points at the right paragraphs.
 */

export const MANUAL_LOCALES = ["en", "fr", "es", "it"] as const;
export type ManualLocale = (typeof MANUAL_LOCALES)[number];

export interface ManualSection {
  /** The section's anchor in the manual page: docs.html#<id>. */
  id: string;
  title: string;
  /** "manual" for players, "testnet" while on the testnet, "dev" for developers. */
  part: string;
}

export interface ManualPassage {
  id: string;
  section: string;
  /** The sub-heading the passage sits under, if any. */
  heading: string | null;
  text: string;
}

export interface Manual {
  sections: ManualSection[];
  passages: ManualPassage[];
}

/** Words too common to tell passages apart, per language. Short on purpose. */
const STOPWORDS = new Set(
  [
    "the a an and or of to in on at for is are be it its this that with as by from what how why who when can do does i you my your me",
    "le la les un une des et ou de du au aux en dans sur pour par est sont ce cette qui que quoi comment pourquoi quand je tu il elle mon ma mes ton ta tes se ne pas",
    "el los las un una unos y o de del al en por para es son que como por que quien cuando yo tu mi mis su se no",
    "il lo la gli le un una e o di del della in su per da che come perche chi quando io tu mio mia non si",
  ]
    .join(" ")
    .split(" "),
);

/** Lower case, accents off, split on anything that is not a letter or a digit. */
export function tokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const K1 = 1.2;
const B = 0.75;

/** Ranks a manual's passages for a question; built once per language. */
export class ManualIndex {
  private readonly docs: { passage: ManualPassage; terms: Map<string, number>; length: number }[];
  private readonly df = new Map<string, number>();
  private readonly averageLength: number;

  constructor(readonly manual: Manual) {
    this.docs = manual.passages.map((passage) => {
      const section = manual.sections.find((s) => s.id === passage.section);
      // The section title and sub-heading count as words of the passage.
      const all = tokens([section?.title, passage.heading, passage.text].filter(Boolean).join(" "));
      const terms = new Map<string, number>();
      for (const t of all) terms.set(t, (terms.get(t) ?? 0) + 1);
      for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { passage, terms, length: all.length };
    });
    this.averageLength = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }

  /** The `limit` passages that best match `query`, best first. Empty when no word matches. */
  search(query: string, limit = 3): ManualPassage[] {
    const words = [...new Set(tokens(query))];
    const n = this.docs.length;
    return this.docs
      .map((d) => {
        let score = 0;
        for (const w of words) {
          const tf = d.terms.get(w);
          if (!tf) continue;
          const df = this.df.get(w)!;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / this.averageLength));
        }
        return { passage: d.passage, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.passage);
  }

  /** The whole manual as plain text for a model: sections tagged with their ids, so answers can cite them. */
  asText(): string {
    const out: string[] = [];
    for (const s of this.manual.sections) {
      out.push(`## [${s.id}] ${s.title}`);
      let heading: string | null = null;
      for (const p of this.manual.passages.filter((p) => p.section === s.id)) {
        if (p.heading && p.heading !== heading) out.push(`### ${p.heading}`);
        heading = p.heading;
        out.push(p.text);
      }
      out.push("");
    }
    return out.join("\n");
  }

  section(id: string): ManualSection | undefined {
    return this.manual.sections.find((s) => s.id === id);
  }
}
