import { useEffect, useState } from "react";
import { api, type VaultBoxState, type VaultDashboard, type VaultFeedItem } from "../api";
import { Bars, TimeChart } from "../charts";
import { ago, fmt } from "../format";
import { C } from "../labels";
import { KpiCard } from "./Overview";

/** The dashboard reloads itself this often while the tab is visible. */
const REFRESH_MS = 60_000;

const STATE_LABEL: Record<VaultBoxState, string> = {
  sealed: "Scellées",
  listed: "En vente sur Seaport",
  sold: "Vendues, ETH à réclamer",
  withdrawn: "Retirées",
  claimed: "Vendues, ETH réclamé",
};

const ACTION_LABEL: Record<string, string> = { withdraw: "retrait", list: "mise en vente", unlist: "retrait de vente", claim: "claim" };
const OUTCOME_LABEL: Record<string, string> = { done: "faite", refused: "refusée (mauvaise clé)", stale: "caduque (la boîte a changé)", expired: "expirée (pas de preuve en un jour)" };

/** Wei (a decimal string) in ETH, four decimals at most. */
const eth = (wei: string) => {
  const n = Number(BigInt(wei) / 10n ** 14n) / 1e4;
  return `${n.toLocaleString("fr-FR", { maximumFractionDigits: 4 })} ETH`;
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The sealed vault, from its public events only: where its boxes stand, its Seaport and private
 * sales, its requests, its activity by day. Never who holds a box: nobody can know.
 */
export function Vault({ days, onError }: { days: number; onError: (e: unknown) => void }) {
  const [d, setD] = useState<VaultDashboard | null>(null);

  useEffect(() => {
    const load = () => api.vault(days).then(setD, onError);
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [days, onError]);

  if (!d) return <div className="splash">Chargement…</div>;
  const s = d.summary;
  const inVault = s.boxes.sealed + s.boxes.listed + s.boxes.sold;
  const settled = s.requests.settled.done + s.requests.settled.refused + s.requests.settled.stale + s.requests.settled.expired;

  return (
    <>
      <section className="facts">
        <div>
          <b>{fmt(inVault)}</b> NFT dans le coffre, <b>{fmt(s.deposits)}</b> déposés depuis le début
        </div>
        <div>
          <b>{fmt(s.seaportSales)}</b> ventes Seaport pour <b>{eth(s.seaportVolume)}</b>, <b>{fmt(s.privateSales.settled)}</b> ventes privées réglées
        </div>
        <div>
          <b>{fmt(s.listed)}</b> annonces en ligne, <b>{fmt(s.privateSales.open)}</b> ventes privées en attente
        </div>
        {s.requests.pending > 0 && (
          <div className="warn">
            <b>{fmt(s.requests.pending)}</b> demandes en attente de preuve
          </div>
        )}
      </section>
      <p className="note">
        Seuls les faits publics du contrat : qui détient une boîte, la clé et le prix d'une vente privée restent chiffrés. L'index ne garde aucune adresse de déposant, d'acheteur ni de destinataire.
      </p>
      <section className="kpis">
        {d.kpis.map((k) => (
          <KpiCard key={k.key} k={k} />
        ))}
      </section>
      <div className="grid2">
        <section className="card">
          <h2>Activité par jour</h2>
          <TimeChart
            rows={d.daily}
            series={[
              { key: "deposits", label: "Dépôts", color: C.spectral },
              { key: "seaportSales", label: "Ventes Seaport", color: C.sodium },
              { key: "privateSales", label: "Ventes privées", color: C.violet },
              { key: "withdrawals", label: "Retraits", color: C.red, kind: "line" },
              { key: "listings", label: "Mises en vente", color: C.blue, kind: "line" },
            ]}
          />
        </section>
        <section className="card">
          <h2>Où en sont les boîtes</h2>
          <Bars items={(Object.keys(STATE_LABEL) as VaultBoxState[]).map((k) => ({ label: STATE_LABEL[k], count: s.boxes[k] }))} color={C.spectral} />
          <h2 className="mt">Argent</h2>
          <ul className="plain">
            <li>
              Payé par les acheteurs Seaport : <b>{eth(s.seaportVolume)}</b>
            </li>
            <li>
              Réclamé par les détenteurs (frais déduits) : <b>{eth(s.claimed)}</b>
            </li>
            <li>Ventes privées : prix chiffrés, jamais visibles.</li>
          </ul>
        </section>
        <section className="card">
          <h2>Demandes via clé</h2>
          <Bars items={Object.entries(s.requests.placed).map(([k, n]) => ({ label: ACTION_LABEL[k] ?? k, count: n }))} color={C.tape} />
          <h2 className="mt">Issues ({fmt(settled)} réglées)</h2>
          <Bars items={Object.entries(s.requests.settled).map(([k, n]) => ({ label: OUTCOME_LABEL[k] ?? k, count: n }))} color={C.blue} />
        </section>
        <section className="card">
          <h2>Collections déposées</h2>
          {s.collections.length ? (
            <div className="table-wrap">
              <table className="players">
                <thead>
                  <tr>
                    <th>Collection</th>
                    <th>Dépôts</th>
                    <th>Encore dans le coffre</th>
                  </tr>
                </thead>
                <tbody>
                  {s.collections.map((c) => (
                    <tr key={c.collection}>
                      <td title={c.collection}>
                        <code>{short(c.collection)}</code>
                      </td>
                      <td>{fmt(c.deposits)}</td>
                      <td>{fmt(c.inVault)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">Aucun dépôt pour l'instant.</p>
          )}
          <h2 className="mt">Annonces Seaport</h2>
          <ul className="plain">
            <li>
              Publiées <b>{fmt(s.listings)}</b> · en ligne <b>{fmt(s.listed)}</b> · retirées <b>{fmt(s.unlisted)}</b> · expirées <b>{fmt(s.expired)}</b>
            </li>
            <li>
              Ventes privées : proposées <b>{fmt(s.privateSales.offered)}</b> · réglées <b>{fmt(s.privateSales.settled)}</b> · annulées <b>{fmt(s.privateSales.cancelled)}</b>
            </li>
          </ul>
        </section>
      </div>
      <section className="card feed">
        <h2>En direct</h2>
        <VaultFeed items={d.recent} />
      </section>
    </>
  );
}

function feedText(i: VaultFeedItem): string {
  const box = i.boxId !== null ? ` boîte #${i.boxId}` : "";
  switch (i.name) {
    case "VaultDeposited":
      return `Dépôt${box}`;
    case "VaultWithdrawn":
      return `Retrait${box}`;
    case "VaultListed":
      return `Mise en vente${box} à ${eth(i.detail ?? "0")}`;
    case "VaultUnlisted":
      return `Annonce retirée${box}`;
    case "VaultListingExpired":
      return `Annonce expirée${box}`;
    case "VaultSoldOnSeaport":
      return `Vendue sur Seaport${box} pour ${eth(i.detail ?? "0")}`;
    case "VaultClaimed":
      return `ETH réclamé${box} : ${eth(i.detail ?? "0")}`;
    case "VaultSaleOffered":
      return `Vente privée proposée${box}`;
    case "VaultSaleSettled":
      return `Vente privée ${i.detail ?? ""} réglée`;
    case "VaultSaleCancelled":
      return `Vente privée ${i.detail ?? ""} annulée`;
    case "VaultRequestPlaced":
      return `Demande de ${ACTION_LABEL[i.detail ?? ""] ?? i.detail}${box}`;
    case "VaultRequestSettled":
      return `Demande ${OUTCOME_LABEL[i.detail ?? ""] ?? i.detail}`;
    default:
      return i.name;
  }
}

function VaultFeed({ items }: { items: VaultFeedItem[] }) {
  if (!items.length) return <p className="empty">Rien pour l'instant.</p>;
  return (
    <ul className="feed-list">
      {items.map((i) => (
        <li key={`${i.txHash}:${i.name}:${i.boxId}`}>
          <span className="icon">🔐</span>
          <span className="what">{feedText(i)}</span>
          {i.at !== null ? <time title={new Date(i.at * 1000).toLocaleString("fr-FR")}>{ago(i.at)}</time> : <time>bloc {fmt(i.block)}</time>}
        </li>
      ))}
    </ul>
  );
}
