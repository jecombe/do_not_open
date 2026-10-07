import { useEffect, useMemo, useState } from "react";
import { api, type Idea } from "../api";
import { ago, downloadCsv, fmt, when } from "../format";

export function Ideas({ onError }: { onError: (e: unknown) => void }) {
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [query, setQuery] = useState("");
  const [locale, setLocale] = useState<string | null>(null);

  useEffect(() => {
    api.ideas().then(setIdeas, onError);
  }, [onError]);

  const locales = useMemo(() => [...new Set((ideas ?? []).map((i) => i.locale))].sort(), [ideas]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (ideas ?? []).filter((i) => (!locale || i.locale === locale) && (!q || i.text.toLowerCase().includes(q) || (i.handle ?? "").includes(q.replace(/^@/, ""))));
  }, [ideas, query, locale]);

  if (!ideas) return <div className="splash">Chargement…</div>;

  return (
    <section className="card">
      <div className="toolbar">
        <input type="search" placeholder="Chercher dans les idées…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="chips">
          <button className={locale === null ? "on" : ""} onClick={() => setLocale(null)}>
            Toutes <small>{fmt(ideas.length)}</small>
          </button>
          {locales.map((l) => (
            <button key={l} className={l === locale ? "on" : ""} onClick={() => setLocale(l)}>
              {l.toUpperCase()} <small>{fmt(ideas.filter((i) => i.locale === l).length)}</small>
            </button>
          ))}
        </div>
        <button className="ghost" onClick={() => downloadCsv(`dno-idees-${new Date().toISOString().slice(0, 10)}.csv`, [["date", "locale", "handle", "text"], ...shown.map((i) => [new Date(i.createdAt * 1000).toISOString(), i.locale, i.handle, i.text])])}>
          Export CSV
        </button>
      </div>
      <ul className="ideas">
        {shown.map((i) => (
          <li key={i.id}>
            <p>{i.text}</p>
            <div className="meta">
              <span className="pill">{i.locale.toUpperCase()}</span>
              {i.handle ? (
                <a href={`https://x.com/${i.handle}`} target="_blank" rel="noreferrer noopener">
                  @{i.handle}
                </a>
              ) : (
                <span className="muted">anonyme</span>
              )}
              <time title={when(i.createdAt)}>{ago(i.createdAt)}</time>
            </div>
          </li>
        ))}
      </ul>
      {!shown.length && <p className="empty">Aucune idée ici.</p>}
    </section>
  );
}
