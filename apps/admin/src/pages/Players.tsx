import { useEffect, useMemo, useState } from "react";
import { api, type PlayerRow, type XTask } from "../api";
import { ago, downloadCsv, fmt, when } from "../format";
import { TASK_LABEL } from "../labels";

const TASKS: XTask[] = ["follow", "post", "like", "reply", "repost"];

const FILTERS = {
  all: { label: "Tous", keep: () => true },
  seated: { label: "Avec une place", keep: (p: PlayerRow) => p.seated },
  stuck: { label: "X connecté, sans place", keep: (p: PlayerRow) => !!p.handle && !p.seated },
  nox: { label: "Sans X", keep: (p: PlayerRow) => !p.handle },
  nowallet: { label: "Place sans wallet", keep: (p: PlayerRow) => p.seated && !p.wallet },
} as const;
type Filter = keyof typeof FILTERS;

type Sort = "updatedAt" | "createdAt" | "tasks" | "handle";

const tasksDone = (p: PlayerRow) => TASKS.filter((t) => p.tasks[t] !== null).length;

export function Players({ onError }: { onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<PlayerRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("updatedAt");
  const [wallets, setWallets] = useState<Record<string, string | null>>({});
  const [limit, setLimit] = useState(200);

  useEffect(() => {
    api.players().then(setRows, onError);
  }, [onError]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase().replace(/^@/, "");
    const list = rows.filter((p) => FILTERS[filter].keep(p) && (!q || p.code.toLowerCase().includes(q) || (p.handle ?? "").includes(q)));
    const by: Record<Sort, (a: PlayerRow, b: PlayerRow) => number> = {
      updatedAt: (a, b) => b.updatedAt - a.updatedAt,
      createdAt: (a, b) => b.createdAt - a.createdAt,
      tasks: (a, b) => tasksDone(b) - tasksDone(a) || b.updatedAt - a.updatedAt,
      handle: (a, b) => (a.handle ?? "~").localeCompare(b.handle ?? "~"),
    };
    return list.sort(by[sort]);
  }, [rows, query, filter, sort]);

  const reveal = async (code: string) => {
    try {
      const { address } = await api.wallet(code);
      setWallets((w) => ({ ...w, [code]: address }));
    } catch (e) {
      onError(e);
    }
  };

  // The export leaves the wallets out, like the list.
  const exportCsv = () =>
    downloadCsv(`dno-joueurs-${new Date().toISOString().slice(0, 10)}.csv`, [
      ["code", "handle", "created", "x_connected", ...TASKS, "seated", "seated_at", "wallet_linked", "claimed", "discord", "tweet"],
      ...shown.map((p) => [
        p.code,
        p.handle,
        new Date(p.createdAt * 1000).toISOString(),
        p.verifiedAt ? new Date(p.verifiedAt * 1000).toISOString() : null,
        ...TASKS.map((t) => (p.tasks[t] ? new Date(p.tasks[t]! * 1000).toISOString() : null)),
        p.seated ? "yes" : "no",
        p.seatedAt ? new Date(p.seatedAt * 1000).toISOString() : null,
        p.wallet ? "yes" : "no",
        p.claimed ? "yes" : "no",
        p.discord ? "yes" : "no",
        p.tweetUrl,
      ]),
    ]);

  if (!rows) return <div className="splash">Chargement…</div>;

  return (
    <section className="card">
      <div className="toolbar">
        <input type="search" placeholder="Chercher un @pseudo ou un code DNO-…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="chips">
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
            <button key={f} className={f === filter ? "on" : ""} onClick={() => setFilter(f)}>
              {FILTERS[f].label} <small>{fmt(rows.filter(FILTERS[f].keep).length)}</small>
            </button>
          ))}
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Trier">
          <option value="updatedAt">Dernière activité</option>
          <option value="createdAt">Carte la plus récente</option>
          <option value="tasks">Le plus de tâches</option>
          <option value="handle">Pseudo A→Z</option>
        </select>
        <button className="ghost" onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      <div className="table-wrap">
        <table className="players">
          <thead>
            <tr>
              <th>Joueur</th>
              <th>Carte</th>
              <th>Tâches</th>
              <th>Place</th>
              <th>Wallet</th>
              <th>Claim</th>
              <th>Discord</th>
              <th>Activité</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((p) => (
              <tr key={p.code}>
                <td>
                  {p.handle ? (
                    <a href={`https://x.com/${p.handle}`} target="_blank" rel="noreferrer noopener">
                      @{p.handle}
                    </a>
                  ) : (
                    <span className="muted">pas de X</span>
                  )}
                  {p.tweetUrl && (
                    <a className="tweet" href={p.tweetUrl} target="_blank" rel="noreferrer noopener" title="Le tweet d'embarquement">
                      ↗
                    </a>
                  )}
                </td>
                <td>
                  <code>{p.code}</code>
                  <div className="muted small" title={when(p.createdAt)}>
                    {ago(p.createdAt)}
                  </div>
                </td>
                <td>
                  <span className="dots">
                    {TASKS.map((t) => (
                      <i key={t} className={p.tasks[t] !== null ? "done" : ""} title={`${TASK_LABEL[t]}${p.tasks[t] ? ` · ${when(p.tasks[t]!)}` : " · pas fait"}`} />
                    ))}
                  </span>
                </td>
                <td>{p.seated ? <span className="pill ok" title={p.seatedAt ? when(p.seatedAt) : ""}>💺 oui</span> : <span className="muted">–</span>}</td>
                <td>
                  {!p.wallet ? (
                    <span className="muted">–</span>
                  ) : p.code in wallets ? (
                    <code className="wallet" title="Cliquer pour copier" onClick={() => wallets[p.code] && navigator.clipboard?.writeText(wallets[p.code]!)}>
                      {wallets[p.code] ?? "?"}
                    </code>
                  ) : (
                    <button className="link" onClick={() => reveal(p.code)} title="Montrer le wallet lié (journalisé)">
                      afficher
                    </button>
                  )}
                </td>
                <td>{p.claimed ? <span className="pill ok">✍️</span> : <span className="muted">–</span>}</td>
                <td>{p.discord ? <span className="pill ok">🎮</span> : <span className="muted">–</span>}</td>
                <td className="muted small" title={when(p.updatedAt)}>
                  {ago(p.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > limit && (
        <button className="ghost more" onClick={() => setLimit((n) => n + 200)}>
          Voir plus ({fmt(shown.length - limit)} restants)
        </button>
      )}
      {!shown.length && <p className="empty">Personne ne correspond.</p>}
    </section>
  );
}
