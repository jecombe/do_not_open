import type { Dashboard } from "../api";
import { TimeChart } from "../charts";
import { fmt } from "../format";
import { C } from "../labels";

export function Chain({ d }: { d: Dashboard }) {
  const sum = (key: string) => d.chain.reduce((a, r) => a + Number(r[key] ?? 0), 0);
  const purchases = sum("purchases");
  const opened = sum("opened");
  const duels = sum("duels");
  const settled = sum("duelsSettled");
  const busiest = d.chain.reduce((best, r) => (Number(r.active) > Number(best?.active ?? -1) ? r : best), d.chain[0]);

  return (
    <>
      <section className="facts">
        <div>
          <b>{fmt(purchases)}</b> achats, <b>{fmt(opened)}</b> boxes ouvertes sur {d.days} j
        </div>
        <div>
          <b>{fmt(settled)}</b> duels joués sur <b>{fmt(duels)}</b> postés
        </div>
        {busiest && Number(busiest.active) > 0 && (
          <div>
            Record : <b>{fmt(Number(busiest.active))}</b> wallets actifs le {new Date(`${busiest.day}T00:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}
          </div>
        )}
      </section>
      <p className="note">Seuls les faits publics de la chaîne : les propriétaires des boxes restent chiffrés, personne ne sait qui détient quoi.</p>
      <div className="grid2">
        <section className="card">
          <h2>Boxes</h2>
          <TimeChart
            rows={d.chain}
            series={[
              { key: "purchases", label: "Achats", color: C.sodium },
              { key: "opened", label: "Ouvertures", color: C.red },
              { key: "shakes", label: "Secouées", color: C.tape, kind: "line" },
              { key: "meals", label: "Repas", color: C.green, kind: "line" },
            ]}
          />
        </section>
        <section className="card">
          <h2>Duels</h2>
          <TimeChart
            rows={d.chain}
            series={[
              { key: "duels", label: "Postés", color: C.blue },
              { key: "duelsSettled", label: "Joués", color: C.violet, kind: "line" },
            ]}
          />
        </section>
        <section className="card">
          <h2>Rats, studio et change</h2>
          <TimeChart
            rows={d.chain}
            series={[
              { key: "rats", label: "Rats adoptés", color: C.kraft },
              { key: "packs", label: "Packs studio", color: C.violet },
              { key: "swaps", label: "ETH → USDC", color: C.spectral, kind: "line" },
            ]}
          />
        </section>
        <section className="card">
          <h2>Wallets actifs par jour</h2>
          <TimeChart rows={d.chain} series={[{ key: "active", label: "Wallets distincts", color: C.spectral, total: "max" }]} />
        </section>
      </div>
    </>
  );
}
