import { useEffect, useId, useRef, useState } from "react";
import { LangSwitch } from "../i18n/LangSwitch";
import { useLocale } from "../i18n/locale";
import { applyPath, homePath, projectDocsPath, vaultDocsPath, vaultPath } from "../site";
import { useT } from "./i18n";

/**
 * The bar of the secure theme: the stamp, the links of the part the page belongs to, the network,
 * the languages. The home page leads to its anchors, the docs, boarding and the vault; the vault's
 * page to what leaks, its docs and home, never to the game. Below a laptop's width the home page's
 * links fold into a menu; the vault's three stay in the bar.
 */
export function SecureTop({ here = "home" }: { here?: "home" | "vault" }) {
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
            <a href={projectDocsPath(locale)}>{t("secure.nav.docs")}</a>
            <a href={applyPath(locale)}>{t("secure.nav.apply")}</a>
            {/* On a phone the bar has no room for the languages: they come with the menu. */}
            <div className="sec-nav-lang">
              <LangSwitch label={t("secure.nav")} />
            </div>
          </>
        ) : (
          <>
            <a href="#leaks">{t("secure.nav.leaks")}</a>
            <a href={vaultDocsPath(locale)}>{t("secure.nav.docs")}</a>
            <a href={homePath(locale)}>{t("secure.nav.home")}</a>
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
        {here === "home" && (
          <button type="button" className="sec-menu" aria-expanded={open} aria-controls={navId} aria-label={t("secure.nav.menu")} onClick={() => setOpen((o) => !o)}>
            <span aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  );
}
