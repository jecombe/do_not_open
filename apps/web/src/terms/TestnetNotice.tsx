import { useEffect, useRef, useState } from "react";
import { useChain } from "../chain/ChainProvider";
import { useT } from "../i18n/app";
import { useLocale } from "../i18n/locale";
import { applyPath } from "../site";
import { setGateUp } from "./terms";

// Read once per browser; a new version of the notice (a new key) shows again.
const SEEN = "dno:testnet-notice:v1";

const seen = () => {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
};

/**
 * What the test network keeps and what it does not, said once when the game opens on Sepolia:
 * the contracts can be redeployed and the boxes, cats and tokens start over, but the points, the
 * seat on the whitelist and the X pass are kept apart and survive it. It stands in for the
 * release form, which is signed on mainnet only.
 */
export function TestnetNotice() {
  const { mode } = useChain();
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(() => mode === "sepolia" && !seen());
  const ok = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setGateUp(open, "testnet");
    if (open) ok.current?.focus();
    return () => setGateUp(false, "testnet");
  }, [open]);

  if (!open) return null;
  const close = () => {
    try {
      localStorage.setItem(SEEN, "1");
    } catch {
      // A private window: the notice comes back next time, which does no harm.
    }
    setOpen(false);
  };

  return (
    <div className="terms-backdrop" role="presentation">
      <section className="terms-form testnet-notice" role="dialog" aria-modal="true" aria-labelledby="testnet-title">
        <header className="terms-head">
          <p className="terms-formno">{t("notice.kicker")}</p>
          <h2 id="testnet-title" className="terms-title">
            {t("notice.title")}
          </h2>
          <span className="testnet-stamp" aria-hidden="true">
            Sepolia
          </span>
        </header>
        <div className="testnet-body">
          <p className="testnet-lede">{t("notice.lede")}</p>
          <div className="testnet-cols">
            <div className="testnet-col is-lost">
              <h3>{t("notice.reset.title")}</h3>
              <p>{t("notice.reset.body")}</p>
            </div>
            <div className="testnet-col is-kept">
              <h3>{t("notice.kept.title")}</h3>
              <p>{t("notice.kept.body")}</p>
            </div>
          </div>
          <p className="testnet-actions">
            <button ref={ok} type="button" className="stamp-button" onClick={close}>
              {t("notice.ok")}
            </button>
            <a className="link" href={applyPath(locale)}>
              {t("notice.board")}&nbsp;→
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}
