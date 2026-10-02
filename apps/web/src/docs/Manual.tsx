import { useEffect, useState } from "react";
import { spec } from "@dno/game-spec";
import { LangSwitch } from "../i18n/LangSwitch";
import { useLocale } from "../i18n/locale";
import { CatParade } from "./CatParade";
import { AllocationBar, BuildTable, LeakTable, TokenFlowFigure, TwoTokensFigure } from "./croq";
import { FeesFigure, FeeTable, FREE_PER_DAY, INPUT_UNITS, NEWCOMER_PER_DAY } from "./fees";
import { ArchFigure, FlowFigure, HeroFigure, SeedFigure } from "./figures";
import { useT } from "./i18n";

const REPO = "https://github.com/jecombe/do_not_open";
const DOCS = `${REPO}/blob/dev/docs`;
const EXPLORER = "https://sepolia.etherscan.io/address/";

/**
 * Three parts: the manual itself, for players and anyone curious, with no code in it; a short
 * part about the testnet, which goes away at mainnet; and the part for developers.
 */
const PARTS = [
  { key: "manual", sections: ["box", "cats", "seed", "holders", "privacy", "flows", "mechanics", "fees", "transfer", "croquettes"] },
  { key: "testnet", sections: ["testnet"] },
  { key: "dev", sections: ["code", "solana", "more"] },
] as const;
const SECTIONS = PARTS.flatMap((p) => p.sections);

/** The contracts on Sepolia, as `dno:export` last wrote them. */
const CONTRACTS = [
  { key: "collection", address: "0xB8e3b2238eF5D5782A661c406acc928895938fBa" },
  { key: "pantry", address: "0x28aC2bc964AfAAa10f51bf485C59D2C9CF6bC8Ed" },
  { key: "croq", address: "0xF4d9CE55b52417e503617186e923E1c0713c53b5" },
  { key: "ccroq", address: "0x4f7415781ceef5C6A0C036A7B8813B7F49634bF9" },
  { key: "ramp", address: "0x2754B8568a3402f828DDAa1715F8290CDa498aAb" },
  { key: "credits", address: "0xfBF4E4bC2558Be1227d6feBbE80299064291d3B1" },
] as const;

/** Highlights the section being read in the routing slip. */
function useCurrentSection(): string {
  const [current, setCurrent] = useState<string>(SECTIONS[0]!);
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
  { key: "r9", holder: "docs.privacy.r9.holder", others: "docs.no" },
  { key: "r10", holder: "docs.privacy.r10.holder", others: "docs.no" },
  { key: "r11", both: "docs.privacy.r11.v" },
  { key: "r1", holder: "docs.no", others: "docs.no" },
  { key: "r2", holder: "docs.privacy.r2.holder", others: "docs.privacy.r2.others" },
  { key: "r3", both: "docs.privacy.r3.v" },
  { key: "r4", both: "docs.privacy.r4.v" },
  { key: "r5", both: "docs.everyone" },
  { key: "r6", holder: "docs.no", others: "docs.no" },
  { key: "r7", both: "docs.privacy.r7.v" },
  { key: "r8", holder: "docs.no", others: "docs.no" },
] as const;

/** Rows of the mechanics table. A missing `who` or `cost` reuses the row above's words. */
const MECHANICS = [
  { key: "m1", cost: "docs.mech.m1.cost" },
  { key: "m2", cost: "docs.gasOnly" },
  { key: "m3", cost: "docs.mech.m3.cost" },
  { key: "m12", cost: "docs.gasOnly" },
  { key: "m4", cost: "0.5 cUSDC" },
  { key: "m5", cost: "docs.gasOnly" },
  { key: "m6", cost: "docs.gasOnly" },
  { key: "m7", who: "docs.mech.m7.who", cost: "docs.gasOnly" },
  { key: "m8", who: "docs.mech.m2.who", cost: "1 cUSDC" },
  { key: "m9", who: "docs.mech.m2.who", cost: "docs.mech.m9.cost" },
  { key: "m10", who: "docs.mech.m4.who", cost: "docs.gasOnly" },
  { key: "m11", who: "docs.mech.m4.who", cost: "docs.gasOnly" },
] as const;

const REFS = [
  { key: "r1", href: `${DOCS}/ARCHITECTURE.md` },
  { key: "r2", href: `${DOCS}/DATA_MODEL.md` },
  { key: "r3", href: `${DOCS}/FLOWS.md` },
  { key: "r4", href: `${DOCS}/ZAMA_NOTES.md` },
  { key: "r5", href: `${DOCS}/DESIGN.md` },
  { key: "r6", href: `${REPO}/blob/dev/packages/contracts-evm/README.md` },
  { key: "r7", href: `${DOCS}/CROQ.md` },
  { key: "r8", href: `${DOCS}/HIDDEN_OWNERS.md` },
  { key: "r9", href: `${REPO}/blob/dev/apps/api/README.md#relayer-proxy` },
] as const;

export function Manual() {
  const t = useT();
  const locale = useLocale();
  const current = useCurrentSection();
  const supply = spec.collection.maxSupply.toLocaleString(locale);
  const { economy } = spec;
  const maxPerTx = Number(spec.mechanics.mint?.maxPerTx ?? 10);
  const milestones = spec.collection.milestones.map((m) => m.toLocaleString(locale)).join(", ");

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
          {PARTS.map((part) => (
            <div key={part.key}>
              <p className="toc-group">{t(`docs.group.${part.key}`)}</p>
              <ol>
                {part.sections.map((id) => (
                  <li key={id}>
                    <a href={`#${id}`} aria-current={current === id ? "true" : undefined}>
                      {t(`docs.section.${id}`)}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          ))}
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

          <section id="holders">
            <h2>{t("docs.section.holders")}</h2>
            <div className="prose">
              <p>{t("docs.holders.p1")}</p>
              <p>{t("docs.holders.p2")}</p>
              <p>{t("docs.holders.p3", { n: maxPerTx })}</p>
              <p>{t("docs.holders.p4", { supply, list: milestones })}</p>
              <p>{t("docs.holders.p5")}</p>
              <p>{t("docs.holders.p6")}</p>
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
                      <td>{"who" in row ? t(row.who) : t(`docs.mech.${row.key}.who`, { n: maxPerTx })}</td>
                      <td>{row.cost.startsWith("docs.") ? t(row.cost as "docs.gasOnly", { cap: economy.meal.maxEatenPerDay.toLocaleString(locale), burn: economy.meal.burnBps / 100 }) : row.cost}</td>
                      <td>{t(`docs.mech.${row.key}.public`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="prose">
              <p>{t("docs.mech.p1", { min: spec.affection.perFeedMin, max: spec.affection.perFeedMax, threshold: spec.affection.goldenThreshold })}</p>
              <p>{t("docs.mech.p2")}</p>
            </div>
          </section>

          <section id="fees">
            <h2>{t("docs.section.fees")}</h2>
            <div className="prose">
              <p>{t("docs.fees.p1")}</p>
            </div>
            <FeesFigure />
            <FeeTable />
            <div className="prose">
              <p>{t("docs.fees.p2")}</p>
              <p>{t("docs.fees.p3", { free: FREE_PER_DAY, newcomer: NEWCOMER_PER_DAY, input: INPUT_UNITS })}</p>
              <p>{t("docs.fees.p4")}</p>
            </div>
          </section>

          <section id="transfer">
            <h2>{t("docs.section.transfer")}</h2>
            <div className="prose">
              <p>{t("docs.transfer.p1")}</p>
            </div>
            <ol className="timeline">
              {(["t1", "t2", "t3", "t4", "t5", "t6"] as const).map((k) => (
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

          <section id="croquettes">
            <h2>{t("docs.section.croquettes")}</h2>
            <div className="prose">
              <p>{t("docs.croq.p1", { symbol: economy.token.symbol, csymbol: economy.token.confidentialSymbol, total: economy.token.totalSupply.toLocaleString(locale) })}</p>
            </div>
            <TwoTokensFigure />
            <div className="prose">
              <p>{t("docs.croq.p2")}</p>
            </div>
            <AllocationBar />
            <div className="prose">
              <p>
                {t("docs.croq.p3", {
                  bag: economy.welcomeBag.amount,
                  max: economy.purr.maxPerDay,
                  vet: economy.purr.vetMultiplier,
                  days: economy.purr.maxDays,
                })}
              </p>
            </div>
            <TokenFlowFigure />
            <div className="prose">
              <p>
                {t("docs.croq.p4", {
                  meals: economy.meal.mealsPerDay,
                  cap: economy.meal.maxEatenPerDay.toLocaleString(locale),
                  treasury: economy.meal.treasuryBps / 100,
                  reserve: (10_000 - economy.meal.treasuryBps - economy.meal.burnBps) / 100,
                  burn: economy.meal.burnBps / 100,
                })}
              </p>
              <p>{t("docs.croq.p5")}</p>
            </div>
            <BuildTable />
            <div className="prose">
              <p>{t("docs.croq.p6")}</p>
              <p>{t("docs.croq.p7")}</p>
            </div>
            <LeakTable />
            <div className="prose">
              <p>{t("docs.croq.p8")}</p>
            </div>
          </section>

          <div className="part" id="part-testnet">
            <h2>{t("docs.group.testnet")}</h2>
          </div>

          <section id="testnet">
            <h2>{t("docs.section.testnet")}</h2>
            <p className="testnet-note">{t("docs.testnet.note")}</p>
            <div className="prose">
              <p>{t("docs.testnet.p1")}</p>
              <p>{t("docs.testnet.contracts")}</p>
            </div>
            <ul className="addresses">
              {CONTRACTS.map((c) => (
                <li key={c.key}>
                  <span>{t(`docs.testnet.c.${c.key}`)}</span>
                  <a href={`${EXPLORER}${c.address}`}>
                    {c.address.slice(0, 6)}…{c.address.slice(-4)}
                  </a>
                </li>
              ))}
            </ul>
            <h3>{t("docs.section.mainnet")}</h3>
            <div className="prose">
              <p>{t("docs.mainnet.intro.before")}</p>
            </div>
            <ul className="findings">
              {(["f1", "f2", "f3", "f4", "f5", "f6", "f8"] as const).map((k) => (
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

          <div className="part" id="part-dev">
            <h2>{t("docs.group.dev")}</h2>
            <p>{t("docs.group.dev.v")}</p>
          </div>

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
