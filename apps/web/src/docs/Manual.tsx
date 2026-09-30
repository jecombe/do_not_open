import { useEffect, useState } from "react";
import { spec } from "@dno/game-spec";
import { LangSwitch } from "../i18n/LangSwitch";
import { useLocale } from "../i18n/locale";
import { CatParade } from "./CatParade";
import { ArchFigure, FlowFigure, HeroFigure, SeedFigure } from "./figures";
import { useT } from "./i18n";

const REPO = "https://github.com/jecombe/do_not_open";
const DOCS = `${REPO}/blob/dev/docs`;
const CONTRACT = "0x6C6210E9CB6CC5218F479806258E86B176aA5BD0";

const SECTIONS = ["box", "cats", "seed", "privacy", "flows", "mechanics", "transfer", "code", "solana", "mainnet", "more"] as const;

/** Highlights the section being read in the routing slip. */
function useCurrentSection(): string {
  const [current, setCurrent] = useState<string>(SECTIONS[0]);
  useEffect(() => {
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setCurrent(e.target.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    for (const id of SECTIONS) {
      const el = document.getElementById(id);
      if (el) seen.observe(el);
    }
    return () => seen.disconnect();
  }, []);
  return current;
}

/** Rows of the privacy table: a fact, then either one cell per column or one cell spanning both. */
const PRIVACY = [
  { key: "r1", holder: "docs.no", others: "docs.no" },
  { key: "r2", holder: "docs.privacy.r2.holder", others: "docs.privacy.r2.others" },
  { key: "r3", both: "docs.privacy.r3.v" },
  { key: "r4", both: "docs.privacy.r4.v" },
  { key: "r5", both: "docs.everyone" },
  { key: "r6", holder: "docs.no", others: "docs.no" },
  { key: "r7", both: "docs.everyone" },
  { key: "r8", holder: "docs.no", others: "docs.no" },
] as const;

/** Rows of the mechanics table. A missing `who` or `cost` reuses the row above's words. */
const MECHANICS = [
  { key: "m1", cost: "0.002 ETH" },
  { key: "m2", cost: "docs.gasOnly" },
  { key: "m3", cost: "docs.mech.m3.cost" },
  { key: "m4", cost: "0.0002 ETH" },
  { key: "m5", cost: "docs.gasOnly" },
  { key: "m6", cost: "docs.gasOnly" },
  { key: "m7", who: "docs.mech.m6.who", cost: "docs.gasOnly" },
  { key: "m8", who: "docs.mech.m2.who", cost: "0.0005 ETH" },
] as const;

const REFS = [
  { key: "r1", href: `${DOCS}/ARCHITECTURE.md` },
  { key: "r2", href: `${DOCS}/DATA_MODEL.md` },
  { key: "r3", href: `${DOCS}/FLOWS.md` },
  { key: "r4", href: `${DOCS}/ZAMA_NOTES.md` },
  { key: "r5", href: `${DOCS}/DESIGN.md` },
  { key: "r6", href: `${REPO}/blob/dev/packages/contracts-evm/README.md` },
] as const;

export function Manual() {
  const t = useT();
  const locale = useLocale();
  const current = useCurrentSection();
  const supply = spec.collection.maxSupply.toLocaleString(locale);

  // The tab title and description follow the language too.
  useEffect(() => {
    document.title = t("docs.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("docs.description", { supply }));
  }, [t, supply]);

  return (
    <div className="manual">
      <header className="top">
        <a className="wordmark" href="/" aria-label={t("docs.homeAria")}>
          Do not open
        </a>
        <nav className="views" aria-label={t("docs.site")}>
          <a href="/">{t("docs.home")}</a>
          <a href="/app.html">{t("docs.back")}</a>
          <a href={REPO}>{t("docs.source")}</a>
          <LangSwitch label={t("nav.language")} />
        </nav>
      </header>

      <section className="hero">
        <h1>{t("docs.hero.title")}</h1>
        <div>
          <p className="lede">{t("docs.hero.lede", { supply })}</p>
          <p className="hero-links">
            <a className="stamp-link" href="#seed">
              {t("docs.hero.seed")}
            </a>
            <a href="/app.html">{t("docs.hero.shake")}</a>
          </p>
        </div>
        <HeroFigure />
      </section>

      <div className="layout">
        <nav className="toc" aria-label={t("docs.contents")}>
          <ol>
            {SECTIONS.map((id) => (
              <li key={id}>
                <a href={`#${id}`} aria-current={current === id ? "true" : undefined}>
                  {t(`docs.section.${id}`)}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <main>
          <section id="box">
            <h2>{t("docs.section.box")}</h2>
            <div className="prose">
              <p>{t("docs.box.p1", { supply })}</p>
              <p>{t("docs.box.p2")}</p>
              <p>{t("docs.box.p3")}</p>
            </div>
          </section>

          <section id="cats">
            <h2>{t("docs.section.cats")}</h2>
            <div className="prose">
              <p>{t("docs.cats.p1")}</p>
            </div>
            <CatParade />
            <div className="prose">
              <p>{t("docs.cats.p2")}</p>
            </div>
          </section>

          <section id="seed">
            <h2>{t("docs.section.seed")}</h2>
            <div className="prose">
              <p>{t("docs.seed.p1")}</p>
            </div>
            <SeedFigure />
            <div className="prose">
              <p>{t("docs.seed.p2")}</p>
              <p>{t("docs.seed.p3", { max: spec.rarity.maxScore })}</p>
            </div>
          </section>

          <section id="privacy">
            <h2>{t("docs.section.privacy")}</h2>
            <div className="prose">
              <p>{t("docs.privacy.p1")}</p>
            </div>
            <div className="form">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("docs.privacy.h.fact")}</th>
                    <th scope="col">{t("docs.privacy.h.holder")}</th>
                    <th scope="col">{t("docs.privacy.h.others")}</th>
                  </tr>
                </thead>
                <tbody>
                  {PRIVACY.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{t(`docs.privacy.${row.key}`)}</th>
                      {"both" in row ? (
                        <td colSpan={2}>{t(row.both)}</td>
                      ) : (
                        <>
                          <td>{t(row.holder)}</td>
                          <td>{t(row.others)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="prose">
              <p>{t("docs.privacy.p2")}</p>
            </div>
          </section>

          <section id="flows">
            <h2>{t("docs.section.flows")}</h2>
            <div className="prose">
              <p>{t("docs.flows.p1")}</p>
              <p>{t("docs.flows.p2")}</p>
            </div>
            <FlowFigure />
          </section>

          <section id="mechanics">
            <h2>{t("docs.section.mechanics")}</h2>
            <div className="form">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("docs.mech.h.action")}</th>
                    <th scope="col">{t("docs.mech.h.who")}</th>
                    <th scope="col">{t("docs.mech.h.cost")}</th>
                    <th scope="col">{t("docs.mech.h.public")}</th>
                  </tr>
                </thead>
                <tbody>
                  {MECHANICS.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{t(`docs.mech.${row.key}`)}</th>
                      <td>{"who" in row ? t(row.who) : t(`docs.mech.${row.key}.who`, { n: Number(spec.mechanics.mint?.maxPerTx ?? 10) })}</td>
                      <td>{row.cost.startsWith("docs.") ? t(row.cost as "docs.gasOnly") : row.cost}</td>
                      <td>{t(`docs.mech.${row.key}.public`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="prose">
              <p>{t("docs.mech.p1", { min: spec.affection.perFeedMin, max: spec.affection.perFeedMax, threshold: spec.affection.goldenThreshold })}</p>
            </div>
          </section>

          <section id="transfer">
            <h2>{t("docs.section.transfer")}</h2>
            <div className="prose">
              <p>{t("docs.transfer.p1")}</p>
            </div>
            <ol className="timeline">
              {(["t1", "t2", "t3", "t4", "t5"] as const).map((k) => (
                <li key={k}>
                  <strong>{t(`docs.transfer.${k}`)}</strong>
                  <span>{t(`docs.transfer.${k}.v`)}</span>
                </li>
              ))}
            </ol>
            <div className="prose">
              <p>{t("docs.transfer.p2")}</p>
            </div>
          </section>

          <section id="code">
            <h2>{t("docs.section.code")}</h2>
            <div className="prose">
              <p>{t("docs.code.p1")}</p>
            </div>
            <ArchFigure />
            <div className="prose">
              <p>{t("docs.code.p2")}</p>
            </div>
          </section>

          <section id="solana">
            <h2>{t("docs.section.solana")}</h2>
            <div className="prose">
              <p>{t("docs.solana.p1")}</p>
            </div>
            <div className="form">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("docs.solana.h.eth")}</th>
                    <th scope="col">{t("docs.solana.h.sol")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(["s1", "s2", "s3", "s4", "s5"] as const).map((k) => (
                    <tr key={k}>
                      <td>{t(`docs.solana.${k}.a`)}</td>
                      <td>{t(`docs.solana.${k}.b`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="prose">
              <p>
                {t("docs.solana.check.before")}
                <a href={`${DOCS}/SOLANA_PORTING.md`}>{t("docs.solana.check.link")}</a>
                {t("docs.solana.check.after")}
              </p>
            </div>
          </section>

          <section id="mainnet">
            <h2>{t("docs.section.mainnet")}</h2>
            <div className="prose">
              <p>
                {t("docs.mainnet.intro.before")}
                <a href={`https://sepolia.etherscan.io/address/${CONTRACT}`}>
                  {CONTRACT.slice(0, 6)}…{CONTRACT.slice(-4)}
                </a>
                {t("docs.mainnet.intro.after")}
              </p>
            </div>
            <ul className="findings">
              {(["f1", "f2", "f3", "f4", "f5", "f6"] as const).map((k) => (
                <li key={k}>
                  <strong>{t(`docs.mainnet.${k}`)}</strong> {t(`docs.mainnet.${k}.v`)}
                </li>
              ))}
              <li>
                <strong>{t("docs.mainnet.f7")}</strong>
              </li>
            </ul>
            <div className="prose">
              <p>
                <a href={`${DOCS}/AUDIT_CHECKLIST.md`}>{t("docs.mainnet.checklist.link")}</a>
                {t("docs.mainnet.checklist.after")}
              </p>
            </div>
          </section>

          <section id="more">
            <h2>{t("docs.section.more")}</h2>
            <ul className="refs">
              {REFS.map((r) => (
                <li key={r.key}>
                  <a href={r.href}>{t(`docs.more.${r.key}`)}</a>
                  <span>{t(`docs.more.${r.key}.v`)}</span>
                </li>
              ))}
            </ul>
          </section>
        </main>
      </div>

      <footer className="foot">
        <span>{t("docs.foot")}</span>
        <a href="/app.html">{t("docs.back")}</a>
      </footer>
    </div>
  );
}
