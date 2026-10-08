import { useEffect, useId, useRef, useState } from "react";
import { LangSwitch } from "../i18n/LangSwitch";
import { useLocale } from "../i18n/locale";
import { applyPath, appPath, docsPath, homePath, marketPath, studioPath, vaultPath } from "../site";
import { useT } from "./i18n";
import { SoundControl } from "./SoundControl";

/**
 * The stamp, the site's links, the sound and the languages, and the way into the game. On a
 * phone the links, the sound and the languages fold into a menu, so the stamp, "Play" and the menu button share one line.
 */
export function HomeTop({ here = "home" }: { here?: "home" | "apply" | "vault" }) {
  const t = useT();
  const locale = useLocale();
  const APP = appPath(locale);
  const DOCS = docsPath(locale);
  const [open, setOpen] = useState(false);
  const navId = useId();
  const root = useRef<HTMLElement>(null);
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

  // A link followed from the menu folds it away.
  const close = () => setOpen(false);
  return (
    <header className="home-top" ref={root}>
      <a className="home-stamp" href={homePath(locale)}>
        Do not open
      </a>
      <nav id={navId} className={open ? "is-open" : undefined} aria-label={t("home.nav")}>
        <a href={`${here === "home" ? "" : homePath(locale)}#how`} onClick={close}>
          {t("home.nav.how")}
        </a>
        <a href={`${here === "home" ? "" : homePath(locale)}#croquettes`} onClick={close}>
          {t("home.nav.croq")}
        </a>
        <a href={studioPath(locale)}>{t("home.nav.studio")}</a>
        <a href={marketPath(locale)}>{t("home.nav.market")}</a>
        <a href={vaultPath(locale)} aria-current={here === "vault" ? "page" : undefined}>
          {t("home.nav.vault")}
        </a>
        <a href={DOCS}>{t("home.nav.docs")}</a>
        <a href={applyPath(locale)} className="home-nav-apply" aria-current={here === "apply" ? "page" : undefined}>
          {t("home.nav.apply")}
        </a>
        <SoundControl labels={{ group: t("home.nav.sound"), mute: t("home.nav.soundMute"), unmute: t("home.nav.soundUnmute"), volume: t("home.nav.musicVolume") }} />
        <LangSwitch label={t("home.nav")} />
      </nav>
      <div className="home-top-actions">
        <a className="btn btn-small" href={APP}>
          {t("home.nav.play")}
        </a>
        <button type="button" ref={toggle} className="btn btn-small btn-paper home-menu" aria-expanded={open} aria-controls={navId} onClick={() => setOpen((o) => !o)}>
          <span className="home-menu-bars" aria-hidden="true" />
          <span className="home-menu-label">{t("home.nav.menu")}</span>
        </button>
      </div>
    </header>
  );
}
