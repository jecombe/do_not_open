import { useCallback, useEffect, useState } from "react";
import { api, SignedOut, type Dashboard } from "./api";
import { ago } from "./format";
import { Boarding } from "./pages/Boarding";
import { Chain } from "./pages/Chain";
import { Ideas } from "./pages/Ideas";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Players } from "./pages/Players";

const TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "boarding", label: "Embarquement" },
  { id: "players", label: "Joueurs" },
  { id: "chain", label: "Jeu on-chain" },
  { id: "ideas", label: "Idées" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const PERIODS = [7, 14, 30, 90];
/** The dashboard reloads itself this often while the tab is visible. */
const REFRESH_MS = 60_000;

const tabOf = (hash: string): Tab => (TABS.some((t) => `#${t.id}` === hash) ? (hash.slice(1) as Tab) : "overview");

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>(tabOf(location.hash));
  const [days, setDays] = useState(() => {
    try {
      return Number(localStorage.getItem("dno-admin-days")) || 30;
    } catch {
      return 30;
    }
  });
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  /** Any call that finds the session gone sends back to the sign-in page. */
  const guard = useCallback((e: unknown) => {
    if (e instanceof SignedOut) setSignedIn(false);
    else setError((e as Error).message);
  }, []);

  useEffect(() => {
    api.session().then((s) => setSignedIn(s.signedIn), guard);
  }, [guard]);

  useEffect(() => {
    const onHash = () => setTab(tabOf(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const load = useCallback(() => {
    api.dashboard(days).then((d) => {
      setData(d);
      setError(null);
    }, guard);
  }, [days, guard]);

  useEffect(() => {
    if (!signedIn) return;
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), REFRESH_MS);
    // "il y a 2 min" stays true.
    const clock = setInterval(() => tick((n) => n + 1), 15_000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
  }, [signedIn, load]);

  if (signedIn === null) return <div className="splash">…</div>;
  if (!signedIn) return <Login onIn={() => setSignedIn(true)} />;

  const pickDays = (n: number) => {
    setDays(n);
    try {
      localStorage.setItem("dno-admin-days", String(n));
    } catch {
      // Private window: the period is not remembered.
    }
  };

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="stencil">DO NOT OPEN</span>
          <span className="tag">admin</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} className={t.id === tab ? "on" : ""}>
              {t.label}
            </a>
          ))}
        </nav>
        <div className="tools">
          <div className="period" role="group" aria-label="Période">
            {PERIODS.map((n) => (
              <button key={n} className={n === days ? "on" : ""} onClick={() => pickDays(n)}>
                {n} j
              </button>
            ))}
          </div>
          <button className="ghost" onClick={load} title="Recharger">
            ↻ {data ? ago(data.generatedAt) : ""}
          </button>
          <button className="ghost" onClick={() => api.logout().finally(() => setSignedIn(false))}>
            Sortir
          </button>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      <main>
        {tab === "players" ? (
          <Players onError={guard} />
        ) : tab === "ideas" ? (
          <Ideas onError={guard} />
        ) : !data ? (
          <div className="splash">Chargement…</div>
        ) : tab === "boarding" ? (
          <Boarding d={data} />
        ) : tab === "chain" ? (
          <Chain d={data} />
        ) : (
          <Overview d={data} />
        )}
      </main>
    </div>
  );
}
