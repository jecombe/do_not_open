import { useEffect, useId, useRef, useState } from "react";
import { LangSwitch } from "../i18n/LangSwitch";
import { useLocale } from "../i18n/locale";
import { applyPath, homePath, vaultDocsPath, vaultPath } from "../site";
import { TxDock } from "../vault/tx/VaultTx";
import { useT } from "./i18n";

/**
 * The bar of the secure theme: the stamp, the links of the part the page belongs to, the network,
 * the languages. The home page leads to its anchors, the vault's docs, boarding, the vault, and quietly to
 * the game's corner ("for fun"); the vault's
 * page to what leaks, its docs, home and its guided tour, never to the game; the boarding page to its own parts and
 * home. Below a laptop's width the home page's and boarding's links fold into a menu; the vault's
 * three stay in the bar.
 */
export function SecureTop({ here = "home", onTour }: { here?: "home" | "vault" | "apply"; onTour?: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const navId = useId();
  const root = useRef<HTMLElement>(null);

  // A tap outside or Escape folds the menu away.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <header className="sec-top" ref={root}>
        <a className="sec-stamp" href={here === "home" ? "#top" : homePath(locale)}>
          Do not open
        </a>
        <nav id={navId} className={open ? "is-open" : undefined} aria-label={t("secure.nav")} onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
          {here === "home" ? (
            <>
              <a href="#protocol">{t("secure.nav.protocol")}</a>
              <a href="#ledger">{t("secure.nav.ledger")}</a>
              <a href="#leaks">{t("secure.nav.leaks")}</a>
              <a href={vaultDocsPath(locale)}>{t("secure.nav.docs")}</a>
              <a href={applyPath(locale)}>{t("secure.nav.apply")}</a>
              {/* The game, kept apart: a quiet link at the end down to its corner of the page, the vault comes first. */}
              <a className="sec-nav-fun" href="#game">
                {t("secure.nav.fun")}
              </a>
              {/* On a phone the bar has no room for the languages: they come with the menu. */}
              <div className="sec-nav-lang">
                <LangSwitch label={t("secure.nav")} />
              </div>
            </>
          ) : here === "apply" ? (
            <>
              <a href="#boarding">{t("secure.nav.boarding")}</a>
              <a href="#gifts">{t("secure.nav.gifts")}</a>
              <a href="#pass">{t("secure.nav.list")}</a>
              <a href={homePath(locale)}>{t("secure.nav.home")}</a>
              <div className="sec-nav-lang">
                <LangSwitch label={t("secure.nav")} />
              </div>
            </>
          ) : (
            <>
              <a href="#leaks">{t("secure.nav.leaks")}</a>
              <a href={vaultDocsPath(locale)}>{t("secure.nav.docs")}</a>
              <a href={homePath(locale)}>{t("secure.nav.home")}</a>
              {/* The vault's walkthrough, played again: a "?" small enough to stay in a phone's bar. */}
              {onTour && (
                <button type="button" className="sec-nav-tour" data-tour="tour-replay" onClick={onTour} aria-label={t("secure.nav.tour")} title={t("secure.nav.tour")}>
                  ?
                </button>
              )}
            </>
          )}
        </nav>
        <div className="sec-top-end">
          <span className="sec-status">
            <i aria-hidden="true" />
            {t("secure.status")}
          </span>
          <LangSwitch label={t("secure.nav")} />
          {here === "home" && (
            <a className="sec-btn sec-btn-small" href={vaultPath(locale)}>
              {t("secure.nav.open")}
            </a>
          )}
          {here !== "vault" && (
            <button type="button" className="sec-menu" aria-expanded={open} aria-controls={navId} aria-label={t("secure.nav.menu")} onClick={() => setOpen((o) => !o)}>
              <span aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      {/* The vault's page shows its own; every other page of the theme shows an action left on the vault. */}
      {here !== "vault" && <TxDock />}
    </>
  );
}
