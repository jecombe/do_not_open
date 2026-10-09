import { DEFAULT_ALLOW_LIST_PLACES, DISCORD_BONUS, REFERRAL_BONUS, REFERRAL_CAP, X_PASS_BONUS } from "@dno/chain-adapter/standings";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { spec, studio } from "@dno/game-spec";

/** The whitelist's three tiers, as the manual quotes them: from the spec, like the contract. */
const [first, business, economy] = spec.whitelist.tiers;
const whitelistGifts = {
  firstTo: first!.toRank,
  firstMin: first!.croqMin,
  firstMax: first!.croqMax,
  businessTo: business!.toRank,
  businessMin: business!.croqMin,
  businessMax: business!.croqMax,
  economyTo: economy!.toRank,
  economyMin: economy!.croqMin,
  economyMax: economy!.croqMax,
  days: spec.whitelist.claimDays,
};
import { LangSwitch } from "../i18n/LangSwitch";
import { useLocale } from "../i18n/locale";
import { BrandIcon } from "../brand/logos";
import { REPO, SOURCE, SOURCE_GAME } from "../links";
import { appPath, homePath } from "../site";
import { CatParade } from "./CatParade";
import { AllocationBar, BuildTable, LeakTable, TokenFlowFigure, TwoTokensFigure } from "./croq";
import { FeesFigure, FeeTable, FREE_PER_DAY, INPUT_UNITS, NEWCOMER_PER_DAY, PUBLIC_UNITS, RAMP_PCT } from "./fees";
import { BureauFigure } from "./bureau";
import { FlowFigure, HeroFigure, SeedFigure } from "./figures";
import { useT } from "./i18n";
import { MapFigure } from "./map";
import { MarketWaysTable } from "./market";
import { BoxVsRatTable, PowersTable, RatCroquettesFigure, RatFigure, StudioFigure, TricksTable } from "./rats";

const DOCS = `${REPO}/blob/dev/docs`;
const EXPLORER = "https://sepolia.etherscan.io/address/";

/**
 * Five parts for players and anyone curious, with no code in them: a start, the boxes, the money,
 * the studio and its rats, and the flea market (the sealed vault has docs of its own). Then two bare
 * chapters with no part title: the testnet, which goes away at mainnet, and the references.
 * `audience` is what the API's chatbot and lessons know a chapter by: "manual" for the players'
 * five parts.
 */
export const PARTS = [
  { key: "start", audience: "manual", sections: ["box", "map", "cats", "terms"] },
  { key: "boxes", audience: "manual", sections: ["seed", "holders", "privacy", "mechanics", "flows", "transfer"] },
  { key: "money", audience: "manual", sections: ["fees", "exchange", "croquettes"] },
  { key: "rats", audience: "manual", sections: ["studio", "rats"] },
  { key: "market", audience: "manual", sections: ["market", "stall"] },
  { key: "testnet", audience: "testnet", sections: ["testnet"], bare: true },
  { key: "dev", audience: "dev", sections: ["more"], bare: true },
] as const;
const SECTIONS = PARTS.flatMap((p) => p.sections);

/** The contracts on Sepolia, as `dno:export` last wrote them. */
const CONTRACTS = [
  { key: "collection", address: "0x6e3B93f16D108a6a4A415D119d8374C2490954d1" },
  { key: "pantry", address: "0xe867E3009C61B943776823a97b3C66A89Bb66a23" },
  { key: "croq", address: "0x765A56A1949baDd2Fc4c04c59c4eCfb464fFfB7C" },
  { key: "ccroq", address: "0xbC7704F737FC4492FC3964449c80b4D7c77479b9" },
  { key: "pool", address: "0x2A830D9F11D67B8Ac11Dc70AEbc34bEE750cC811" },
  { key: "locker", address: "0x704811b4091C6A7E37dAb7a104A80300986Bf058" },
  { key: "ramp", address: "0x02382AC8a24462FD830753Ca7e49E12486A65638" },
  { key: "credits", address: "0x1d1848a72Ffd06e71161537472BFD6D903616511" },
  { key: "studio", address: "0x41596e7311A7408BC1871B9b93be82ef6DDfB5f6" },
  { key: "rats", address: "0x441F9fe3B8333515Bc7B295E06C14948057b2cF6" },
  { key: "ratPantry", address: "0xa8C6850eB99f89aB1DA9714Cd073B454Bb6E1850" },
  { key: "ratTricks", address: "0x1E722B5d8581AA71DE6bAf523a95FDB3917B765f" },
  { key: "market", address: "0xF16bEF038c27C4cE9E7469500B46e1CA60E76F92" },
  { key: "whitelistGifts", address: "0x09D2382E4E6d15Efa324d89f8c5E39437e0e405a" },
] as const;

/** `part-boxes` reads as that part's first chapter; a chapter as itself. */
const firstOf = (id: string): string => PARTS.find((p) => `part-${p.key}` === id)?.sections[0] ?? id;

/** Highlights the section being read in the routing slip. */
function useCurrentSection(): string {
  const [current, setCurrent] = useState<string>(SECTIONS[0]!);
  useEffect(() => {
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setCurrent(firstOf(e.target.id));
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    for (const id of SECTIONS) {
      const el = document.getElementById(id);
      if (el) seen.observe(el);
    }
    // A part's title page counts as its first chapter: the slip opens that part as soon as it shows.
    for (const part of PARTS) {
      const el = document.getElementById(`part-${part.key}`);
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
  { key: "code", href: SOURCE_GAME },
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

type PartKey = Exclude<(typeof PARTS)[number], { bare: true }>["key"];

/** The title page of a part: its number, its name, what is in it, and its chapters. */
function PartHead({ part }: { part: PartKey }) {
  const t = useT();
  const index = PARTS.findIndex((p) => p.key === part);
  return (
    <div className="part" id={`part-${part}`}>
      <p className="part-no">{t("docs.part", { n: index + 1 })}</p>
      <h2>{t(`docs.group.${part}`)}</h2>
      <p>{t(`docs.group.${part}.v`)}</p>
      <ol className="part-contents">
        {PARTS[index]!.sections.map((id) => (
          <li key={id}>
            <a href={`#${id}`}>{t(`docs.section.${id}`)}</a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The routing slip. On a wide screen, the five parts and the bare chapters stay listed and only the one being read
 * shows its chapters, so the slip never needs scrolling. On a phone, one bar names the chapter
 * being read and unfolds the whole list.
 */
function Contents({ current }: { current: string }) {
  const t = useT();
  const fold = useRef<HTMLDetailsElement>(null);
  // A link followed from the unfolded list folds it back. Folding it hides the link before the
  // browser scrolls, which then stays put: the scroll is done here instead.
  const follow = (e: MouseEvent<HTMLDetailsElement>) => {
    const id = (e.target as HTMLElement).closest("a")?.getAttribute("href")?.slice(1);
    if (!id) return;
    e.preventDefault();
    fold.current?.removeAttribute("open");
    document.getElementById(id)?.scrollIntoView();
    history.replaceState(history.state, "", `#${id}`);
  };
  const reading = PARTS.find((p) => (p.sections as readonly string[]).includes(current)) ?? PARTS[0];
  const list = (
    <ol className="toc-parts">
      {PARTS.map((part) => {
        if ("bare" in part)
          return part.sections.map((id) => (
            <li key={id}>
              <a className="toc-group" href={`#${id}`} aria-current={current === id ? "true" : undefined}>
                {t(`docs.section.${id}`)}
              </a>
            </li>
          ));
        const open = part.key === reading.key;
        return (
          <li key={part.key} className={open ? "is-open" : undefined}>
            <a className="toc-group" href={`#part-${part.key}`} aria-current={open ? "true" : undefined}>
              {t(`docs.group.${part.key}`)}
            </a>
            <ol>
              {part.sections.map((id) => (
                <li key={id}>
                  <a href={`#${id}`} aria-current={current === id ? "true" : undefined}>
                    {t(`docs.section.${id}`)}
                  </a>
                </li>
              ))}
            </ol>
          </li>
        );
      })}
    </ol>
  );
  return (
    <nav className="toc" aria-label={t("docs.contents")}>
      <div className="toc-wide">{list}</div>
      <details className="toc-narrow" ref={fold} onClick={follow}>
        <summary>
          <span className="toc-label">{t("docs.contents")}</span>
          <span className="toc-now">{t(`docs.section.${current as (typeof SECTIONS)[number]}`)}</span>
        </summary>
        {list}
      </details>
    </nav>
  );
}

export function Manual() {
  const t = useT();
  const locale = useLocale();
  const current = useCurrentSection();
  const supply = spec.collection.maxSupply.toLocaleString(locale);
  const { economy } = spec;
  const maxPerTx = Number(spec.mechanics.mint?.maxPerTx ?? 10);
  const tricks = { days: studio.rats.powers.trickDays, rest: studio.rats.powers.rechargeDays };
  const rats = { seed: studio.rats.mint.seedPriceUsdc, model: studio.rats.mint.modelPriceUsdc, perDay: studio.rats.croquettes.perDay, maxDays: studio.rats.croquettes.maxDays, maxSeed: studio.rats.mint.maxSeedRats, maxModel: studio.rats.mint.maxModelRats, perWallet: studio.rats.mint.maxPerWallet, fund: studio.rats.croquettes.fund.toLocaleString(locale) };
  const market = { fee: spec.market.feeBps / 100, max: spec.market.maxFeeBps / 100, pct: 70 };
  const milestones = spec.collection.milestones.map((m) => m.toLocaleString(locale)).join(", ");
  // The sale stops at its last milestone; the rest of the supply is the whitelist's gift boxes.
  const saleCapNumber = spec.collection.milestones[spec.collection.milestones.length - 1]!;
  const saleCap = saleCapNumber.toLocaleString(locale);
  const giftBoxes = (spec.collection.maxSupply - saleCapNumber).toLocaleString(locale);

  // The tab title and description follow the language too.
  useEffect(() => {
    document.title = t("docs.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("docs.description", { supply }));
  }, [t, supply]);

  return (
    <div className="manual">
      <header className="top">
        <a className="wordmark" href={homePath(locale)} aria-label={t("docs.homeAria")}>
          Do not open
        </a>
        <nav className="views" aria-label={t("docs.site")}>
          <a href={homePath(locale)}>{t("docs.home")}</a>
          <a href={appPath(locale)}>{t("docs.back")}</a>
          <LangSwitch label={t("nav.language")} />
        </nav>
      </header>

      <section className="hero">
        <h1>{t("docs.hero.title")}</h1>
        <div>
          <p className="lede">{t("docs.hero.lede", { supply })}</p>
          <p className="hero-links">
            <a className="stamp-link" href="#map">
              {t("docs.hero.seed")}
            </a>
            <a href={appPath(locale)}>{t("docs.hero.shake")}</a>
          </p>
        </div>
        <HeroFigure />
      </section>

      <div className="layout">
        <Contents current={current} />

        <main>
          <PartHead part="start" />

          <section id="box">
            <h2>{t("docs.section.box")}</h2>
            <div className="prose">
              <p>{t("docs.box.p1", { supply })}</p>
              <p>{t("docs.box.p2")}</p>
              <p>{t("docs.box.p3")}</p>
            </div>
          </section>

          <section id="map">
            <h2>{t("docs.section.map")}</h2>
            <div className="prose">
              <p>{t("docs.map.p1")}</p>
            </div>
            <MapFigure />
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

          <section id="terms">
            <h2>{t("docs.section.terms")}</h2>
            <div className="prose">
              <p>{t("docs.terms.p1")}</p>
              <p>{t("docs.terms.p2")}</p>
              <p>{t("docs.terms.p3")}</p>
            </div>
          </section>

          <PartHead part="boxes" />

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
              <p>{t("docs.holders.p4", { supply, saleCap, gifts: giftBoxes, list: milestones })}</p>
              <p>{t("docs.holders.p5")}</p>
              <p>{t("docs.holders.p6")}</p>
              <p>{t("docs.holders.p7")}</p>
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
              <p>{t("docs.mech.p3")}</p>
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

          <PartHead part="money" />

          <section id="fees">
            <h2>{t("docs.section.fees")}</h2>
            <div className="prose">
              <p>{t("docs.fees.p1")}</p>
            </div>
            <FeesFigure />
            <FeeTable />
            <div className="prose">
              <p>{t("docs.fees.p2")}</p>
              <p>{t("docs.fees.p3", { free: FREE_PER_DAY, newcomer: NEWCOMER_PER_DAY, input: INPUT_UNITS, public: PUBLIC_UNITS })}</p>
              <p>{t("docs.fees.p4")}</p>
            </div>
          </section>

          <section id="exchange">
            <h2>{t("docs.section.exchange")}</h2>
            <div className="prose">
              <p>{t("docs.exchange.p1")}</p>
            </div>
            <BureauFigure />
            <div className="prose">
              <p>{t("docs.exchange.p2")}</p>
              <p>{t("docs.exchange.p3", { pct: RAMP_PCT })}</p>
              <p>{t("docs.exchange.p4")}</p>
              <p>{t("docs.exchange.p5")}</p>
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
            <div className="prose">
              <p>
                {t("docs.croq.rats", {
                  perDay: studio.rats.croquettes.perDay,
                  maxDays: studio.rats.croquettes.maxDays,
                  fund: studio.rats.croquettes.fund.toLocaleString(locale),
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
              <p>{t("docs.croq.p9", { symbol: economy.token.symbol })}</p>
            </div>
          </section>

          <PartHead part="rats" />

          <section id="studio">
            <h2>{t("docs.section.studio")}</h2>
            <div className="prose">
              <p>{t("docs.studio.p1")}</p>
            </div>
            <StudioFigure />
            <div className="prose">
              <p>{t("docs.studio.p2", { starter: studio.packs[0]!.priceUsdc, litter: studio.packs[1]!.priceUsdc })}</p>
              <p>{t("docs.studio.p3")}</p>
              <p>{t("docs.studio.p4", { min: studio.prompt.minLength, max: studio.prompt.maxLength })}</p>
              <p>{t("docs.studio.p5")}</p>
            </div>
          </section>

          <section id="rats">
            <h2>{t("docs.section.rats")}</h2>
            <div className="prose">
              <p>{t("docs.rats.p1", rats)}</p>
              <p>{t("docs.rats.p2", rats)}</p>
            </div>
            <RatFigure />
            <div className="prose">
              <p>{t("docs.rats.p3")}</p>
            </div>
            <BoxVsRatTable />
            <h3>{t("docs.rats.h.croq")}</h3>
            <div className="prose">
              <p>{t("docs.rats.p4", rats)}</p>
            </div>
            <RatCroquettesFigure />
            <h3>{t("docs.rats.h.power")}</h3>
            <div className="prose">
              <p>{t("docs.rats.p7")}</p>
            </div>
            <PowersTable />
            <h3>{t("docs.rats.h.sniff")}</h3>
            <div className="prose">
              <p>{t("docs.rats.p5")}</p>
              <p>{t("docs.rats.p6")}</p>
            </div>
            <h3>{t("docs.rats.h.tricks")}</h3>
            <div className="prose">
              <p>{t("docs.rats.p8", tricks)}</p>
            </div>
            <TricksTable />
            <div className="prose">
              <p>{t("docs.rats.p9")}</p>
              <p>{t("docs.rats.p10", tricks)}</p>
              <p>{t("docs.rats.p11", tricks)}</p>
            </div>
          </section>

          <PartHead part="market" />

          <section id="market">
            <h2>{t("docs.section.market")}</h2>
            <div className="prose">
              <p>{t("docs.market.p1")}</p>
              <p>{t("docs.market.p2")}</p>
              <p>{t("docs.market.p3")}</p>
            </div>
            <MarketWaysTable />
            <div className="prose">
              <p>{t("docs.market.p4", market)}</p>
            </div>
            <h3>{t("docs.market.h.state")}</h3>
            <div className="prose">
              <p>{t("docs.market.p5")}</p>
              <p>{t("docs.market.p6")}</p>
            </div>
          </section>

          <section id="stall">
            <h2>{t("docs.section.stall")}</h2>
            <div className="prose">
              <p>{t("docs.stall.p1", market)}</p>
              <p>{t("docs.stall.p2")}</p>
              <p>{t("docs.stall.p3")}</p>
              <p>{t("docs.stall.p4")}</p>
              <p>{t("docs.stall.p5", market)}</p>
            </div>
          </section>

          <section id="testnet">
            <h2>{t("docs.section.testnet")}</h2>
            <p className="testnet-note">{t("docs.testnet.note")}</p>
            <div className="prose">
              <p>{t("docs.testnet.p1")}</p>
              <p>{t("docs.testnet.allowList", { places: DEFAULT_ALLOW_LIST_PLACES ?? 0, xBonus: X_PASS_BONUS, discordBonus: DISCORD_BONUS, refBonus: REFERRAL_BONUS, refCap: REFERRAL_CAP })}</p>
              <p>{t("docs.testnet.gifts", whitelistGifts)}</p>
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
          </section>

          <section id="more">
            <h2>{t("docs.section.more")}</h2>
            <ul className="refs">
              {REFS.map((r) => (
                <li key={r.key}>
                  <a href={r.href} className={r.href.startsWith(SOURCE) ? "with-logo" : undefined}>
                    {r.href.startsWith(SOURCE) && <BrandIcon brand="gitlab" size={16} />}
                    {t(`docs.more.${r.key}`)}
                  </a>
                  <span>{t(`docs.more.${r.key}.v`)}</span>
                </li>
              ))}
            </ul>
          </section>

        </main>
      </div>

      <footer className="foot">
        <span>{t("docs.foot")}</span>
        <a href={appPath(locale)}>{t("docs.back")}</a>
      </footer>
    </div>
  );
}
