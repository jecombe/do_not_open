import { spec, type WhitelistTierKey } from "@dno/game-spec";
import { useLocale } from "../i18n/locale";
import { useT } from "./i18n";

const TIERS = spec.whitelist.tiers;

/** The class a tier flies, in the reader's language. */
export function useTierName(): (tier: number) => string {
  const t = useT();
  return (tier) => t(`home.gifts.class.${TIERS[tier]!.key as WhitelistTierKey}`);
}

/**
 * The whitelist's gifts as three plane tickets, one per class: ranks, the croquettes drawn under
 * encryption, and the free box and rat. Numbers come from the spec, as the contract's do.
 */
export function GiftTiers() {
  const t = useT();
  const locale = useLocale();
  const n = (v: number) => v.toLocaleString(locale);

  return (
    <section id="gifts" className="home-section gifts">
      <p className="kicker">{t("home.gifts.kicker")}</p>
      <h2>{t("home.gifts.title")}</h2>
      <p className="section-lede">{t("home.gifts.lede")}</p>

      <ol className="gift-tickets">
        {TIERS.map((tier) => (
          <li key={tier.key} className={`gift-ticket is-${tier.key}`}>
            <div className="gift-main">
              <p className="gift-class">{t(`home.gifts.class.${tier.key}`)}</p>
              <p className="gift-ranks">{t("home.gifts.ranks", { from: n(tier.fromRank), to: n(tier.toRank) })}</p>
              <ul className="gift-items">
                <li className="gift-croq">
                  <strong>{t("home.gifts.croq", { min: n(tier.croqMin), max: n(tier.croqMax) })}</strong>
                  <small>{t("home.gifts.croqNote")}</small>
                </li>
                {tier.box && (
                  <li className="gift-box">
                    <strong>{t("home.gifts.box")}</strong>
                  </li>
                )}
                {tier.rat && (
                  <li className="gift-rat">
                    <strong>{t("home.gifts.rat")}</strong>
                  </li>
                )}
              </ul>
            </div>
            <div className="gift-stub" aria-hidden="true">
              <span>{t("home.gifts.seat")}</span>
              <b>{n(tier.fromRank)}</b>
              <i>↓</i>
              <b>{n(tier.toRank)}</b>
            </div>
          </li>
        ))}
      </ol>

      <p className="gifts-fine">{t("home.gifts.fine", { days: spec.whitelist.claimDays })}</p>
    </section>
  );
}
