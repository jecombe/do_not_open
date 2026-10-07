import type { Dashboard, Kpi } from "../api";
import { Heatmap, Spark, TimeChart } from "../charts";
import { ago, change, duration, fmt } from "../format";
import type { XTask } from "../api";
import { C, FEED_ICON, KPI_LABEL, TASK_LABEL } from "../labels";

const KPI_COLOR: Record<string, string> = {
  passes: C.sodium,
  x: C.blue,
  seated: C.green,
  discord: C.violet,
  claims: C.spectral,
  ideas: C.tape,
  purchases: C.sodium,
  opened: C.red,
  duels: C.blue,
  rats: C.kraft,
  packs: C.violet,
  active: C.spectral,
};

export function Overview({ d }: { d: Dashboard }) {
  return (
    <>
      <Seats d={d} />
      <section className="kpis">
        {d.kpis.map((k) => (
          <KpiCard key={k.key} k={k} />
        ))}
      </section>
      <div className="cols">
        <section className="card wide">
          <h2>Embarquement par jour</h2>
          <TimeChart
            rows={d.boarding}
            series={[
              { key: "passes", label: "Cartes créées", color: C.sodium },
              { key: "x", label: "X connectés", color: C.blue, kind: "line" },
              { key: "seated", label: "Places prises", color: C.green, kind: "line" },
              { key: "claims", label: "Claims", color: C.spectral, kind: "line" },
            ]}
          />
        </section>
        <section className="card feed">
          <h2>En direct</h2>
          <Feed items={d.recent} />
        </section>
      </div>
      <div className="cols">
        <section className="card wide">
          <h2>Jeu on-chain par jour</h2>
          <TimeChart
            rows={d.chain}
            series={[
              { key: "purchases", label: "Achats", color: C.sodium },
              { key: "opened", label: "Ouvertures", color: C.red },
              { key: "duels", label: "Duels", color: C.blue },
              { key: "rats", label: "Rats", color: C.kraft },
              { key: "active", label: "Wallets actifs", color: C.spectral, kind: "line", total: "max" },
            ]}
          />
        </section>
        <section className="card">
          <h2>Quand ils sont là</h2>
          <Heatmap grid={d.heatmap} />
        </section>
      </div>
    </>
  );
}

function Seats({ d }: { d: Dashboard }) {
  const { taken, places, perDay, daysToFull } = d.seats;
  const share = places ? Math.min(1, taken / places) : 0;
  return (
    <section className="card seats">
      <div className="seats-head">
        <div>
          <h2>Whitelist mainnet</h2>
          <div className="big">
            {fmt(taken)} <small>/ {places === null ? "∞" : fmt(places)} places</small>
          </div>
        </div>
        <dl>
          <div>
            <dt>Rythme (7 j)</dt>
            <dd>{perDay} / jour</dd>
          </div>
          <div>
            <dt>Pleine dans</dt>
            <dd>{daysToFull === null ? "–" : daysToFull === 0 ? "pleine" : `~${fmt(daysToFull)} j`}</dd>
          </div>
          <div>
            <dt>Carte → place</dt>
            <dd>{d.medianToSeat === null ? "–" : `${duration(d.medianToSeat)} (médiane)`}</dd>
          </div>
        </dl>
      </div>
      {places !== null && (
        <div className="progress" title={`${Math.round(share * 100)} %`}>
          <div style={{ width: `${share * 100}%` }} />
          <span>{Math.round(share * 1000) / 10} %</span>
        </div>
      )}
    </section>
  );
}

function KpiCard({ k }: { k: Kpi }) {
  const meta = KPI_LABEL[k.key] ?? { label: k.key, hint: "" };
  const week = change(k.last7, k.prev7);
  const color = KPI_COLOR[k.key] ?? C.sodium;
  return (
    <div className="kpi" style={{ "--accent": color } as React.CSSProperties}>
      <div className="kpi-label" title={meta.hint}>
        {meta.label}
      </div>
      <div className="kpi-total">{fmt(k.total)}</div>
      <div className="kpi-row">
        <span>
          aujourd'hui <b>{fmt(k.today)}</b> <em>hier {fmt(k.yesterday)}</em>
        </span>
      </div>
      <div className="kpi-row">
        <span>
          7 j <b>{fmt(k.last7)}</b>
        </span>
        <span className={week.up === null ? "flat" : week.up ? "up" : "down"}>{week.up === null ? week.text : `${week.up ? "▲" : "▼"} ${week.text}`}</span>
      </div>
      <Spark values={k.spark} color={color} />
    </div>
  );
}

function feedText(i: Dashboard["recent"][number]) {
  switch (i.kind) {
    case "pass":
      return "a créé une carte d'embarquement";
    case "x":
      return "a connecté son compte X";
    case "task":
      return `a fait : ${TASK_LABEL[i.text as XTask] ?? i.text}`;
    case "seated":
      return "a pris une place 🎉";
    case "discord":
      return "a rejoint le Discord (/board)";
    case "claim":
      return "a claim sa place whitelist";
    case "idea":
      return <>a proposé <q>{i.text}</q></>;
    default:
      return i.text;
  }
}

export function Feed({ items }: { items: Dashboard["recent"] }) {
  if (!items.length) return <p className="empty">Rien pour l'instant.</p>;
  return (
    <ul className="feed-list">
      {items.map((i, n) => (
        <li key={n}>
          <span className="icon">{FEED_ICON[i.kind] ?? "•"}</span>
          <span className="what">
            {i.who && (i.who.startsWith("@") ? <a href={`https://x.com/${i.who.slice(1)}`} target="_blank" rel="noreferrer noopener">{i.who}</a> : <b>{i.who}</b>)} {feedText(i)}
          </span>
          <time title={new Date(i.at * 1000).toLocaleString("fr-FR")}>{ago(i.at)}</time>
        </li>
      ))}
    </ul>
  );
}
