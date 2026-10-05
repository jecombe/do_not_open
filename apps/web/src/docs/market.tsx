import { useT } from "./i18n";

/** The flea market chapter's figure: the two ways to buy, side by side. */

const WAYS = ["price", "steps", "short", "beaten", "public"] as const;

/** Buying at the asking price, and with a secret offer, line by line. */
export function MarketWaysTable() {
  const t = useT();
  return (
    <div className="form versus">
      <table>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">{t("fig.ways.ask")}</th>
            <th scope="col">{t("fig.ways.offer")}</th>
          </tr>
        </thead>
        <tbody>
          {WAYS.map((k) => (
            <tr key={k}>
              <th scope="row">{t(`fig.ways.${k}`)}</th>
              <td>{t(`fig.ways.${k}.ask`)}</td>
              <td>{t(`fig.ways.${k}.offer`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
