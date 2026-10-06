/**
 * Writes the home page, the manual and the studio once per language after `vite build`, with their text
 * already in the page and a full <head> (canonical, hreflang, Open Graph, Twitter, JSON-LD), so
 * a crawler or a link preview reads them without running any script:
 *
 *   dist/index.html  dist/fr/index.html  dist/es/index.html  dist/it/index.html   →  /  /fr/  /es/  /it/
 *   dist/docs.html   dist/fr/docs.html   dist/es/docs.html   dist/it/docs.html    →  /docs  /fr/docs ...
 *   dist/studio.html dist/fr/studio.html ...                                       →  /studio  /fr/studio ...
 *   dist/apply.html  dist/fr/apply.html ...                                        →  /apply  /fr/apply ...
 *
 * The browser then renders the page again from scratch once the fonts are in (createRoot, no
 * hydration): what is drawn on a canvas (the box, the cats) only exists from then on.
 *
 *   pnpm --filter @dno/web build   (runs it)      tsx scripts/prerender.mts   (again, on an existing dist)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = resolve(ROOT, "dist");
const LOCALES = ["en", "fr", "es", "it"] as const;
type Locale = (typeof LOCALES)[number];
const OG_LOCALE: Record<Locale, string> = { en: "en_US", fr: "fr_FR", es: "es_ES", it: "it_IT" };
/** Below this much visible text, the page did not really render: the build fails. */
const MIN_TEXT = { home: 2_000, docs: 20_000, studio: 600, apply: 600 } as const;

// The pages read a few browser globals while rendering: enough of them to render once. Effects
// (three.js, observers, timers) never run on the server.
const noop = () => {};
const storage = { getItem: () => null, setItem: noop };
const location = { href: "https://do-not-open.app/", pathname: "/", search: "", hash: "" };
Object.assign(globalThis, {
  document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, querySelector: () => null },
  window: {
    matchMedia: () => ({ matches: true, addEventListener: noop, removeEventListener: noop }),
    location,
    history: { state: null, replaceState: noop },
    localStorage: storage,
    addEventListener: noop,
    removeEventListener: noop,
  },
});
// Node has a `localStorage` of its own that warns when read without a backing file.
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonLd = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
const visibleText = (html: string) =>
  html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { setLocale } = await vite.ssrLoadModule("/src/i18n/locale.ts");
  const site = await vite.ssrLoadModule("/src/site.ts");
  const { DISCORD, REPO } = await vite.ssrLoadModule("/src/links.ts");
  const { spec } = await vite.ssrLoadModule("@dno/game-spec");
  const { Home } = await vite.ssrLoadModule("/src/home/Home.tsx");
  const { Manual } = await vite.ssrLoadModule("/src/docs/Manual.tsx");
  const home = await vite.ssrLoadModule("/src/home/i18n.ts");
  const docs = await vite.ssrLoadModule("/src/docs/i18n.ts");
  const { StudioPage } = await vite.ssrLoadModule("/src/studio/StudioPage.tsx");
  const { ApplyPage } = await vite.ssrLoadModule("/src/apply/ApplyPage.tsx");
  const app = await vite.ssrLoadModule("/src/i18n/app.ts");

  const SITE: string = site.SITE_URL;
  const IMAGE = `${SITE}/og.png`;
  const PAGES = {
    home: { file: "index.html", component: Home, t: home.t, prefix: "home", path: site.homePath as (l: Locale) => string },
    docs: { file: "docs.html", component: Manual, t: docs.t, prefix: "docs", path: site.docsPath as (l: Locale) => string },
    studio: { file: "studio.html", component: StudioPage, t: app.t, prefix: "studio", path: site.studioPath as (l: Locale) => string },
    apply: { file: "apply.html", component: ApplyPage, t: home.t, prefix: "apply", path: site.applyPath as (l: Locale) => string },
  } as const;

  // The English files are the templates. A second run starts from them again: the tags and the
  // markup this script adds are stripped first.
  const templates = Object.fromEntries(
    Object.entries(PAGES).map(([page, { file }]) => [
      page,
      readFileSync(resolve(DIST, file), "utf8")
        .replace(/\s*<!-- seo -->[\s\S]*?<!-- \/seo -->/, "")
        .replace(/\s*<title>[\s\S]*?<\/title>/, "")
        .replace(/\s*<meta name="description"[^>]*>/, "")
        .replace(/<div id="root">[\s\S]*<\/div>(\s*<\/body>)/, '<div id="root"></div>$1'),
    ]),
  ) as Record<keyof typeof PAGES, string>;

  const written: string[] = [];
  for (const [page, { file, component, t, prefix, path }] of Object.entries(PAGES) as [keyof typeof PAGES, (typeof PAGES)[keyof typeof PAGES]][]) {
    for (const locale of LOCALES) {
      const url = `${SITE}${path(locale)}`;
      Object.assign(location, { href: url, pathname: path(locale) });
      setLocale(locale);

      const markup: string = renderToStaticMarkup(createElement(component));
      const text = visibleText(markup);
      if (text.length < MIN_TEXT[page] || !/<h1\b/.test(markup))
        throw new Error(`prerender: ${page} in ${locale} rendered only ${text.length} characters of text (expected ${MIN_TEXT[page]}+ and an <h1>)`);

      const supply = Number(spec.collection.maxSupply).toLocaleString(locale);
      const title: string = t(`${prefix}.title`);
      const description: string = t(`${prefix}.description`, { supply });
      const imageAlt: string = t(`${prefix}.imageAlt`);
      const website = { "@type": "WebSite", "@id": `${SITE}/#website`, name: "DO NOT OPEN", url: `${SITE}/`, inLanguage: [...LOCALES], sameAs: [REPO, DISCORD] };
      const graph =
        page === "home"
          ? [
              { ...website, description },
              {
                "@type": "VideoGame",
                "@id": `${SITE}/#game`,
                name: "DO NOT OPEN",
                url,
                description,
                inLanguage: locale,
                image: IMAGE,
                gamePlatform: "Web browser",
                applicationCategory: "Game",
                isAccessibleForFree: true,
                sameAs: [REPO, DISCORD],
              },
            ]
          : page === "studio" || page === "apply"
            ? [
                website,
                { "@type": "WebPage", "@id": `${url}#page`, name: title, description, url, inLanguage: locale, image: IMAGE, isPartOf: { "@id": `${SITE}/#website` } },
              ]
            : [
              website,
              {
                "@type": "TechArticle",
                "@id": `${url}#article`,
                headline: title,
                description,
                url,
                inLanguage: locale,
                image: IMAGE,
                isPartOf: { "@id": `${SITE}/#website` },
              },
            ];

      const head = [
        "<!-- seo -->",
        `<title>${escapeHtml(title)}</title>`,
        `<meta name="description" content="${escapeHtml(description)}" />`,
        `<link rel="canonical" href="${url}" />`,
        ...LOCALES.map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE}${path(l)}" />`),
        `<link rel="alternate" hreflang="x-default" href="${SITE}${path("en")}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="DO NOT OPEN" />`,
        `<meta property="og:title" content="${escapeHtml(title)}" />`,
        `<meta property="og:description" content="${escapeHtml(description)}" />`,
        `<meta property="og:url" content="${url}" />`,
        `<meta property="og:locale" content="${OG_LOCALE[locale]}" />`,
        ...LOCALES.filter((l) => l !== locale).map((l) => `<meta property="og:locale:alternate" content="${OG_LOCALE[l]}" />`),
        `<meta property="og:image" content="${IMAGE}" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta property="og:image:alt" content="${escapeHtml(imageAlt)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
        `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
        `<meta name="twitter:image" content="${IMAGE}" />`,
        `<meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}" />`,
        `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
        `<link rel="manifest" href="/site.webmanifest" />`,
        jsonLd({ "@context": "https://schema.org", "@graph": graph }),
        "<!-- /seo -->",
      ].join("\n    ");

      const html = templates[page]
        .replace(/<html lang="[^"]*">/, `<html lang="${locale}">`)
        .replace(/(<meta name="viewport"[^>]*>)/, `$1\n    ${head}`)
        .replace('<div id="root"></div>', () => `<div id="root">${markup}</div>`);
      if (!html.includes("<!-- seo -->") || !html.includes(markup.slice(0, 200))) throw new Error(`prerender: could not fill the ${file} template`);
      // Built asset URLs are absolute, so a copy one folder down still finds them.
      if (/(?:src|href)="(?!\/|https?:|#|data:|mailto:)/.test(templates[page])) throw new Error(`prerender: ${file} has a relative asset URL`);

      const out = locale === "en" ? resolve(DIST, file) : resolve(DIST, locale, file);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, html);
      written.push(`${path(locale).padEnd(9)} ${out.slice(DIST.length + 1).padEnd(16)} ${text.length.toLocaleString("en")} chars`);
    }
  }
  console.log(`prerendered ${written.length} pages:\n  ${written.join("\n  ")}`);
} finally {
  await vite.close();
}
