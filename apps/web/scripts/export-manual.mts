/**
 * Renders the manual in every language, as a reader sees it (numbers filled in, tables
 * included), and writes it in passages for the API's chatbot to search and quote:
 * apps/api/src/infrastructure/chat/manual.json. With --check it only compares, and fails
 * when the manual changed and the file was not written again (run by `pnpm test`).
 *
 *   pnpm --filter @dno/web export:manual
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";

const OUT = resolve(import.meta.dirname, "../../api/src/infrastructure/chat/manual.json");
const LOCALES = ["en", "fr", "es", "it"] as const;
/** Passages are cut at about this many characters, between paragraphs or table rows. */
const PASSAGE = 900;

// The manual reads a few browser globals while rendering: enough of them to render once.
const noop = () => {};
Object.assign(globalThis, {
  document: { documentElement: {}, addEventListener: noop, removeEventListener: noop },
  window: {
    matchMedia: () => ({ matches: true, addEventListener: noop, removeEventListener: noop }),
    location: { href: "http://localhost/docs.html", search: "", hash: "" },
    history: { state: null, replaceState: noop },
    localStorage: { getItem: () => null, setItem: noop },
    addEventListener: noop,
    removeEventListener: noop,
  },
});

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/g, (m, n) => ENTITIES[n] ?? m);
const text = (html: string) =>
  decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/ ([.,)])/g, "$1")
    .trim();

/** One section's blocks in reading order: headings, paragraphs, list items, table rows, figure labels. */
function blocks(section: string): { heading?: string; text: string }[] {
  const out: { heading?: string; text: string }[] = [];
  // A figure says what it draws in its aria-label and caption; its labels and drawing are not
  // prose. Tables and lists inside it are kept, row by row.
  const html = section.replace(/<figure\b[\s\S]*?<\/figure>/g, (figure) => {
    const labels = [...new Set([...figure.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]))].map((l) => `<p>${l}</p>`);
    const captions = [...figure.matchAll(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/g)].map((m) => m[0]);
    const rows = [...figure.matchAll(/<(tr|li|dt|dd)\b[^>]*>[\s\S]*?<\/\1>/g)].map((m) => m[0]);
    return [...labels, ...captions, ...rows].join("");
  });
  const re = /<(h3|p|li|tr|figcaption|dt)\b[^>]*>([\s\S]*?)<\/\1>/g;
  for (const m of html.matchAll(re)) {
    const tag = m[1]!;
    const body = tag === "tr" ? m[2]!.replace(/<\/t[dh]>/g, " | ") : m[2]!;
    const t = text(body).replace(/\s*\|\s*$/, "");
    if (!t) continue;
    out.push(tag === "h3" ? { heading: t, text: "" } : { text: tag === "dt" ? `${t}:` : t });
  }
  return out;
}

const vite = await createServer({ root: resolve(import.meta.dirname, ".."), server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { setLocale } = await vite.ssrLoadModule("/src/i18n/locale.ts");
  const { Manual, PARTS } = await vite.ssrLoadModule("/src/docs/Manual.tsx");
  const partOf = new Map<string, string>(PARTS.flatMap((p: { key: string; sections: readonly string[] }) => p.sections.map((s) => [s, p.key])));

  const locales: Record<string, unknown> = {};
  for (const locale of LOCALES) {
    setLocale(locale);
    const html: string = renderToStaticMarkup(createElement(Manual));
    const sections: { id: string; title: string; part: string }[] = [];
    const passages: { id: string; section: string; heading: string | null; text: string }[] = [];
    for (const m of html.matchAll(/<section id="([a-z]+)">([\s\S]*?)<\/section>/g)) {
      const [, id, body] = m as unknown as [string, string, string];
      const title = text(/<h2>([\s\S]*?)<\/h2>/.exec(body)?.[1] ?? id);
      sections.push({ id, title, part: partOf.get(id) ?? "manual" });
      let heading: string | null = null;
      let buffer: string[] = [];
      const flush = () => {
        if (buffer.length) passages.push({ id: `${id}-${passages.filter((p) => p.section === id).length}`, section: id, heading, text: buffer.join("\n") });
        buffer = [];
      };
      for (const b of blocks(body)) {
        if (b.heading !== undefined) {
          flush();
          heading = b.heading;
          continue;
        }
        if (buffer.length && buffer.join("\n").length + b.text.length > PASSAGE) flush();
        buffer.push(b.text);
      }
      flush();
    }
    if (sections.length < 10) throw new Error(`the ${locale} manual rendered only ${sections.length} sections`);
    locales[locale] = { sections, passages };
  }

  const json = JSON.stringify({ source: "apps/web/src/docs, rendered by apps/web/scripts/export-manual.mts", locales }, null, 1) + "\n";
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      // Missing: stale.
    }
    if (current !== json) {
      console.error("The manual changed: run `pnpm --filter @dno/web export:manual` and commit apps/api/src/infrastructure/chat/manual.json.");
      process.exitCode = 1;
    } else console.log("manual.json is up to date");
  } else {
    writeFileSync(OUT, json);
    console.log(`wrote ${OUT}`);
  }
} finally {
  await vite.close();
}
