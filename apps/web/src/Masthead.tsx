import { useEffect, useId, useRef, useState } from "react";
import { shortAddress } from "@dno/chain-adapter";
import { useChain } from "./chain/ChainProvider";
import { useT, type AppKey } from "./i18n/app";
import { LangSwitch } from "./i18n/LangSwitch";

export const VIEWS = [
  { key: "shelf", label: "nav.shelf" },
  { key: "box", label: "nav.box" },
  { key: "pair", label: "nav.pair" },
  { key: "leaderboard", label: "nav.leaderboard" },
  { key: "specimens", label: "nav.specimens" },
] as const satisfies readonly { key: string; label: AppKey }[];
export type View = (typeof VIEWS)[number]["key"];

/**
 * The stamp on the left; on the right, a small wallet tag and one manila tag
 * naming the current view. The tag opens a packing list with the other views,
 * the manual and the languages.
 */
export function Masthead({ view, onView }: { view: View; onView: (v: View) => void }) {
  const chain = useChain();
  const t = useT();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = VIEWS.find((v) => v.key === view)!;
  const { account, mode } = chain;

  return (
    <header className="masthead">
      <h1 className="wordmark">Do not open</h1>
      <div className="controls" ref={root}>
        {mode !== "mock" &&
          (account ? (
            <button type="button" className="wallet" onClick={() => void chain.disconnect()} title={t("nav.disconnect")}>
              {shortAddress(account)}
            </button>
          ) : (
            <button type="button" className="wallet" onClick={() => void chain.connect()} title={t("nav.connect")}>
              {t("nav.connectShort")}
            </button>
          ))}
        <button
          type="button"
          ref={toggle}
          className="menu-toggle"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((o) => !o)}
        >
          {t(current.label)}
          <span className="caret" aria-hidden="true" />
        </button>
        {open && (
          <nav className="menu" id={menuId} aria-label={t("nav.views")}>
            <ul>
              {VIEWS.map((v) => (
                <li key={v.key}>
                  <button
                    type="button"
                    aria-current={view === v.key ? "page" : undefined}
                    onClick={() => {
                      onView(v.key);
                      setOpen(false);
                    }}
                  >
                    {t(v.label)}
                  </button>
                </li>
              ))}
              <li className="menu-rule">
                <a href="/docs.html">{t("nav.manual")}</a>
              </li>
            </ul>
            <LangSwitch label={t("nav.language")} />
          </nav>
        )}
      </div>
    </header>
  );
}
