import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { LangSwitch } from "../i18n/LangSwitch";

export interface DocSection {
  id: string;
  title: string;
  body: ReactNode;
}

export interface DocLink {
  href: string;
  label: string;
}

/** Highlights the section being read in the contents. */
function useCurrent(ids: readonly string[]): string {
  const [current, setCurrent] = useState(ids[0] ?? "");
  useEffect(() => {
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setCurrent(e.target.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) seen.observe(el);
    }
    return () => seen.disconnect();
  }, [ids]);
  return current;
}

/**
 * The project's documentation and the vault's: the manual's look (docs.css) with one flat list
 * of chapters. The game's manual keeps its own, longer layout (Manual.tsx).
 */
export function DocShell({
  home,
  homeAria,
  nav,
  navLabel,
  languageLabel,
  contentsLabel,
  title,
  lede,
  heroLinks,
  sections,
  foot,
}: {
  home: string;
  homeAria: string;
  nav: DocLink[];
  navLabel: string;
  languageLabel: string;
  contentsLabel: string;
  title: string;
  lede: string;
  heroLinks: DocLink[];
  sections: DocSection[];
  foot: ReactNode;
}) {
  const ids = useRef(sections.map((s) => s.id)).current;
  const current = useCurrent(ids);
  const fold = useRef<HTMLDetailsElement>(null);
  const reading = sections.find((s) => s.id === current) ?? sections[0];

  // A link followed from the phone's unfolded list folds it back, then scrolls (see Manual.tsx).
  const follow = (e: MouseEvent<HTMLDetailsElement>) => {
    const id = (e.target as HTMLElement).closest("a")?.getAttribute("href")?.slice(1);
    if (!id) return;
    e.preventDefault();
    fold.current?.removeAttribute("open");
    document.getElementById(id)?.scrollIntoView();
    history.replaceState(history.state, "", `#${id}`);
  };

  const list = (
    <ol className="toc-parts">
      {sections.map((s) => (
        <li key={s.id}>
          <a className="toc-group" href={`#${s.id}`} aria-current={current === s.id ? "true" : undefined}>
            {s.title}
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="manual">
      <header className="top">
        <a className="wordmark" href={home} aria-label={homeAria}>
          Do not open
        </a>
        <nav className="views" aria-label={navLabel}>
          {nav.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
          <LangSwitch label={languageLabel} />
        </nav>
      </header>

      <section className="hero doc-hero">
        <h1>{title}</h1>
        <div>
          <p className="lede">{lede}</p>
          <p className="hero-links">
            {heroLinks.map((l, i) => (
              <a key={l.href} className={i === 0 ? "stamp-link" : undefined} href={l.href}>
                {l.label}
              </a>
            ))}
          </p>
        </div>
      </section>

      <div className="layout">
        <nav className="toc" aria-label={contentsLabel}>
          <div className="toc-wide">{list}</div>
          <details className="toc-narrow" ref={fold} onClick={follow}>
            <summary>
              <span className="toc-label">{contentsLabel}</span>
              <span className="toc-now">{reading?.title}</span>
            </summary>
            {list}
          </details>
        </nav>

        <main>
          {sections.map((s) => (
            <section key={s.id} id={s.id}>
              <h2>{s.title}</h2>
              {s.body}
            </section>
          ))}
        </main>
      </div>

      <footer className="foot">{foot}</footer>
    </div>
  );
}

/** Paragraphs from a list of messages. */
export const Prose = ({ children }: { children: string[] }) => (
  <div className="prose">
    {children.map((p, i) => (
      <p key={i}>{p}</p>
    ))}
  </div>
);
