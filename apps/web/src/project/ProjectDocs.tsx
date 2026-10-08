import { useEffect, type ReactNode } from "react";
import { spec } from "@dno/game-spec";
import { DocShell, Prose } from "../docs/DocShell";
import { useLocale } from "../i18n/locale";
import { REPO } from "../links";
import { appPath, docsPath, homePath, vaultDocsPath, vaultPath } from "../site";
import { useT } from "./i18n";

/** The chapters, in order: what the anchors are, and what an old link's anchor is checked against. */
export const PROJECT_SECTIONS = ["what", "fhe", "vault", "game", "leaks", "trust", "status", "more"] as const;

const ZAMA = "https://docs.zama.ai/protocol";

/**
 * The project's documentation, at `/docs` on the bare domain: what DO NOT OPEN is, how a box
 * stays sealed, the vault and the game in a few lines each, what leaks and who is trusted. The
 * details are in the vault's docs and the game's manual.
 */
export function ProjectDocs() {
  const t = useT();
  const locale = useLocale();
  const supply = spec.collection.maxSupply.toLocaleString(locale);

  useEffect(() => {
    document.title = t("project.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("project.description", { supply }));
  }, [t, supply]);

  const links = (...l: { href: string; label: string }[]) => (
    <p className="hero-links">
      {l.map((x, i) => (
        <a key={x.href} className={i === 0 ? "stamp-link" : undefined} href={x.href}>
          {x.label}
        </a>
      ))}
    </p>
  );

  const refs = [
    { key: "vault", href: vaultDocsPath(locale) },
    { key: "game", href: docsPath(locale) },
    { key: "repo", href: REPO },
    { key: "zama", href: ZAMA },
  ] as const;

  const body: Record<(typeof PROJECT_SECTIONS)[number], ReactNode> = {
    what: <Prose>{[t("project.what.p1"), t("project.what.p2"), t("project.what.p3")]}</Prose>,
    fhe: <Prose>{[t("project.fhe.p1"), t("project.fhe.p2"), t("project.fhe.p3")]}</Prose>,
    vault: (
      <>
        <Prose>{[t("project.vault.p1"), t("project.vault.p2")]}</Prose>
        {links({ href: vaultDocsPath(locale), label: t("project.vault.docs") }, { href: vaultPath(locale), label: t("project.vault.open") })}
      </>
    ),
    game: (
      <>
        <Prose>{[t("project.game.p1", { supply }), t("project.game.p2")]}</Prose>
        {links({ href: docsPath(locale), label: t("project.game.docs") }, { href: appPath(locale), label: t("project.game.open") })}
      </>
    ),
    leaks: <Prose>{[t("project.leaks.p1"), t("project.leaks.p2"), t("project.leaks.p3")]}</Prose>,
    trust: <Prose>{[t("project.trust.p1"), t("project.trust.p2"), t("project.trust.p3")]}</Prose>,
    status: <Prose>{[t("project.status.p1"), t("project.status.p2")]}</Prose>,
    more: (
      <ul className="refs">
        {refs.map((r) => (
          <li key={r.key}>
            <a href={r.href}>{t(`project.more.${r.key}`)}</a>
            <span>{t(`project.more.${r.key}.v`)}</span>
          </li>
        ))}
      </ul>
    ),
  };

  return (
    <DocShell
      home={homePath(locale)}
      homeAria={t("project.homeAria")}
      navLabel={t("project.site")}
      languageLabel={t("project.language")}
      contentsLabel={t("project.contents")}
      nav={[
        { href: homePath(locale), label: t("project.nav.home") },
        { href: vaultPath(locale), label: t("project.nav.vault") },
        { href: appPath(locale), label: t("project.nav.game") },
      ]}
      title={t("project.h1")}
      lede={t("project.lede")}
      heroLinks={[
        { href: vaultDocsPath(locale), label: t("project.hero.vault") },
        { href: docsPath(locale), label: t("project.hero.game") },
      ]}
      sections={PROJECT_SECTIONS.map((id) => ({ id, title: t(`project.section.${id}`), body: body[id] }))}
      foot={<span>{t("project.foot")}</span>}
    />
  );
}
