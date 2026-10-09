/**
 * Renders the manual in every language, as a reader sees it (numbers filled in, tables
 * included), and writes it in passages for the API's chatbot to search and quote:
 * apps/api/src/infrastructure/chat/manual.json (the game's clerk). The sealed vault's docs and
 * the project's go the same way to vault-manual.json (the Warden, on the home page and the
 * vault's), their section ids prefixed `vault-` and `project-`. With --check it only compares,
 * and fails when the docs changed and a file was not written again (run by `pnpm test`).
 *
 *   pnpm --filter @dno/web export:manual
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";

const OUT = resolve(import.meta.dirname, "../../api/src/infrastructure/chat/manual.json");
const VAULT_OUT = resolve(import.meta.dirname, "../../api/src/infrastructure/chat/vault-manual.json");
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

type Book = { sections: { id: string; title: string; part: string }[]; passages: { id: string; section: string; heading: string | null; text: string }[] };

/** A rendered page's `<section id>`s cut in passages; `prefix` goes before each section id, `partOf` says each one's audience. */
function bookOf(html: string, prefix = "", partOf: (id: string) => string = () => "manual", into: Book = { sections: [], passages: [] }): Book {
  const { sections, passages } = into;
  for (const m of html.matchAll(/<section id="([a-z]+)">([\s\S]*?)<\/section>/g)) {
    const [, raw, body] = m as unknown as [string, string, string];
    const id = `${prefix}${raw}`;
    const title = text(/<h2>([\s\S]*?)<\/h2>/.exec(body)?.[1] ?? raw);
    sections.push({ id, title, part: partOf(raw) });
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
  return into;
}

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
  const partOf = new Map<string, string>(PARTS.flatMap((p: { audience: string; sections: readonly string[] }) => p.sections.map((s) => [s, p.audience])));

  const locales: Record<string, unknown> = {};
  for (const locale of LOCALES) {
    setLocale(locale);
    const html: string = renderToStaticMarkup(createElement(Manual));
    const { sections, passages } = bookOf(html, "", (id) => partOf.get(id) ?? "manual");
    if (sections.length < 10) throw new Error(`the ${locale} manual rendered only ${sections.length} sections`);
    locales[locale] = { sections, passages };
  }

  // The Warden's book: the vault's docs, then the project's.
  const { VaultDocs } = await vite.ssrLoadModule("/src/vault/docs/VaultDocs.tsx");
  const { ProjectDocs } = await vite.ssrLoadModule("/src/project/ProjectDocs.tsx");
  const vaultLocales: Record<string, Book> = {};
  for (const locale of LOCALES) {
    setLocale(locale);
    const book = bookOf(renderToStaticMarkup(createElement(VaultDocs)), "vault-");
    bookOf(renderToStaticMarkup(createElement(ProjectDocs)), "project-", () => "manual", book);
    if (book.sections.length < 12) throw new Error(`the ${locale} vault and project docs rendered only ${book.sections.length} sections`);
    vaultLocales[locale] = book;
  }

  const files = [
    { out: OUT, name: "manual.json", json: JSON.stringify({ source: "apps/web/src/docs, rendered by apps/web/scripts/export-manual.mts", locales }, null, 1) + "\n" },
    {
      out: VAULT_OUT,
      name: "vault-manual.json",
      json: JSON.stringify({ source: "apps/web/src/vault/docs and apps/web/src/project, rendered by apps/web/scripts/export-manual.mts", locales: vaultLocales }, null, 1) + "\n",
    },
  ];
  for (const f of files) {
    if (process.argv.includes("--check")) {
      let current = "";
      try {
        current = readFileSync(f.out, "utf8");
      } catch {
        // Missing: stale.
      }
      if (current !== f.json) {
        console.error(`The docs changed: run \`pnpm --filter @dno/web export:manual\` and commit apps/api/src/infrastructure/chat/${f.name}.`);
        process.exitCode = 1;
      } else console.log(`${f.name} is up to date`);
    } else {
      writeFileSync(f.out, f.json);
      console.log(`wrote ${f.out}`);
    }
  }
} finally {
  await vite.close();
}
