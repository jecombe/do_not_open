import { GALXE_QUEST, X_FOLLOW, X_HANDLE, xPost } from "../links";
import { useLocale } from "../i18n/locale";
import { homePath, SITE_URL } from "../site";
import { useT } from "./i18n";
import { usePassCount } from "./Passport";

/**
 * The first thing on the home page: a boarding pass for the mainnet list. X comes first (follow,
 * post, verify on Galxe); a wallet and testnet play are the bonus, and the laissez-passer below
 * tells the rest. Every action opens X or Galxe in a new tab.
 */
export function Boarding() {
  const t = useT();
  const locale = useLocale();
  const [count] = usePassCount();
  const url = `${SITE_URL}${homePath(locale)}`;
  const steps = [
    { key: "follow", href: X_FOLLOW, label: t("home.boarding.follow", { handle: X_HANDLE }) },
    { key: "post", href: xPost(t("home.boarding.tweet", { handle: X_HANDLE }), url), label: t("home.boarding.post") },
    { key: "verify", href: GALXE_QUEST, label: t("home.boarding.verify") },
  ];

  return (
    <section className="boarding" aria-labelledby="boarding-title">
      <div className="boarding-stub" aria-hidden="true">
        <span className="boarding-gate">{t("home.boarding.gate")}</span>
        <strong>X</strong>
        <span className="boarding-barcode" />
      </div>

      <div className="boarding-main">
        <p className="boarding-kicker">
          <span className="boarding-live" aria-hidden="true" />
          {t("home.boarding.kicker")}
          {count && <span className="boarding-count">{t("home.boarding.count", { count: count.claimants, places: count.places })}</span>}
        </p>
        <h2 id="boarding-title">{t("home.boarding.title")}</h2>
        <ol className="boarding-steps">
          {steps.map((s, i) => (
            <li key={s.key}>
              <span className="boarding-n" aria-hidden="true">
                {i + 1}
              </span>
              {s.href ? (
                <a className={`btn btn-small${s.key === "follow" ? " btn-x" : s.key === "post" ? "" : " btn-paper"}`} href={s.href} target="_blank" rel="noreferrer">
                  {s.key !== "verify" && (
                    <svg className="x-logo" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
                    </svg>
                  )}
                  {s.label}&nbsp;↗
                </a>
              ) : (
                <span className="btn btn-small btn-paper is-soon" aria-disabled="true">
                  {s.label} · {t("home.pass.soon")}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      <a className="boarding-bonus" href="#pass">
        <span className="boarding-bonus-tag">{t("home.boarding.bonus.tag")}</span>
        <strong>{t("home.boarding.bonus.title")}</strong>
        <span>{t("home.boarding.bonus.body")}</span>
        <span className="boarding-bonus-go">{t("home.boarding.bonus.go")}&nbsp;↓</span>
      </a>
    </section>
  );
}
