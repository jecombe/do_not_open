import { useEffect, useRef } from "react";
import { spec, studio } from "@dno/game-spec";
import { RatToy } from "../home/ratToy";
import { useLocale } from "../i18n/locale";
import { C } from "./croq";
import { useT } from "./i18n";

/**
 * The studio and rats chapter's figures: the studio's road from a prompt to a rat of your own,
 * a rat to click, a box and a rat side by side, and where a rat's croquettes come from.
 */

const { packs, rats } = studio;

type Lane = "browser" | "server" | "chain";
const LANES: Lane[] = ["browser", "server", "chain"];

/** The studio's steps, in order, and where each one happens. */
const STEPS = [
  { key: "s1", lane: "browser" },
  { key: "s2", lane: "chain" },
  { key: "s3", lane: "browser" },
  { key: "s4", lane: "server" },
  { key: "s5", lane: "server" },
  { key: "s6", lane: "chain" },
  { key: "s7", lane: "chain" },
] as const satisfies readonly { key: string; lane: Lane }[];

const LANE_COLOR: Record<Lane, string> = { browser: C.paper, server: C.sodium, chain: C.spectral };

/**
 * A swimlane: your browser, the studio's server with the AI behind it, and the chain. Each step
 * sits in its lane; on a phone the lanes fold into a tag on each step.
 */
export function StudioFigure() {
  const t = useT();
  const vars = {
    starter: packs[0]!.priceUsdc,
    litter: packs[1]!.priceUsdc,
    seed: rats.mint.seedPriceUsdc,
    model: rats.mint.modelPriceUsdc,
    perDay: rats.croquettes.perDay,
  };
  return (
    <figure className="diagram">
      <div className="lanes" role="img" aria-label={t("fig.studio.aria")}>
        {LANES.map((lane, i) => (
          <p key={lane} className="lanes-head" style={{ gridRow: i + 1 }}>
            {t(`fig.studio.lane.${lane}`)}
          </p>
        ))}
        {LANES.map((lane, i) => (
          <span key={lane} className="lanes-band" style={{ gridRow: i + 1 }} aria-hidden="true" />
        ))}
        <ol>
          {STEPS.map((s, i) => (
            <li key={s.key} style={{ gridColumn: i + 2, gridRow: LANES.indexOf(s.lane) + 1, background: LANE_COLOR[s.lane] }}>
              <b>{i + 1}</b>
              <strong>{t(`fig.studio.${s.key}`)}</strong>
              <span>{t(`fig.studio.${s.key}.v`, vars)}</span>
              <em>{t(`fig.studio.lane.${s.lane}`)}</em>
            </li>
          ))}
        </ol>
      </div>
      <figcaption>{t("fig.studio.caption")}</figcaption>
    </figure>
  );
}

/** One of the studio's free rats, on a little stage: click it and another one lands. */
export function RatFigure() {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    let toy: RatToy;
    try {
      toy = new RatToy(host.current);
    } catch {
      // No WebGL: the text around it says what a rat is.
      host.current.classList.add("no-webgl");
      return;
    }
    return () => toy.dispose();
  }, []);
  return (
    <figure className="rat-figure">
      <div ref={host} className="stage rat-stage" title={t("fig.rat.hint")} />
      <figcaption>{t("fig.rat.caption", { n: rats.mint.maxSeedRats })}</figcaption>
    </figure>
  );
}

const VERSUS = ["what", "holder", "inside", "price", "supply", "earns", "markets"] as const;

/** A box and a rat, line by line: everything one hides, the other shows. */
export function BoxVsRatTable() {
  const t = useT();
  const locale = useLocale();
  const vars = {
    supply: spec.collection.maxSupply.toLocaleString(locale),
    seed: rats.mint.seedPriceUsdc,
    model: rats.mint.modelPriceUsdc,
    maxSeed: rats.mint.maxSeedRats,
    maxModel: rats.mint.maxModelRats,
    perWallet: rats.mint.maxPerWallet,
    perDay: rats.croquettes.perDay,
    bag: spec.economy.welcomeBag.amount,
    max: spec.economy.purr.maxPerDay,
  };
  return (
    <div className="form versus">
      <table>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">{t("fig.vs.box")}</th>
            <th scope="col">{t("fig.vs.rat")}</th>
          </tr>
        </thead>
        <tbody>
          {VERSUS.map((k) => (
            <tr key={k}>
              <th scope="row">{t(`fig.vs.${k}`)}</th>
              <td>{t(`fig.vs.${k}.box`, vars)}</td>
              <td>{t(`fig.vs.${k}.rat`, vars)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A row of crates with labelled arrows between them; it stands up on a phone. */
export function Chain({ steps, arrows, aria }: { steps: { title: string; sub: string; fill: string; dashed?: boolean }[]; arrows: string[]; aria: string }) {
  return (
    <ol className="chain" role="img" aria-label={aria} style={{ gridTemplateColumns: steps.map((_, i) => (i ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)")).join(" ") }}>
      {steps.map((s, i) => (
        <li key={s.title} className="chain-item">
          {i > 0 && (
            <span className="chain-arrow" aria-hidden="true">
              <svg viewBox="0 0 44 16">
                <path d="M2 8 L34 8" strokeWidth={4} strokeLinecap="round" />
                <path d="M32 1 L43 8 L32 15 Z" />
              </svg>
              <small>{arrows[i - 1]}</small>
            </span>
          )}
          <div className={s.dashed ? "croq-box is-dashed" : "croq-box"} style={{ background: s.fill }}>
            <strong>{s.title}</strong>
            <span>{s.sub}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Where a rat's croquettes come from, and how they can end up in a cat. */
export function RatCroquettesFigure() {
  const t = useT();
  const locale = useLocale();
  const { croquettes } = rats;
  return (
    <figure className="diagram">
      <Chain
        aria={t("fig.ratcroq.aria")}
        steps={[
          { title: t("fig.ratcroq.treasury"), sub: t("fig.ratcroq.treasurySub", { fund: croquettes.fund.toLocaleString(locale) }), fill: C.kraft },
          { title: t("fig.ratcroq.pantry"), sub: t("fig.ratcroq.pantrySub", { perDay: croquettes.perDay }), fill: C.tape },
          { title: t("fig.ratcroq.you"), sub: t("fig.ratcroq.youSub"), fill: C.sodium },
          { title: t("fig.ratcroq.cat"), sub: t("fig.ratcroq.catSub"), fill: C.spectral, dashed: true },
        ]}
        arrows={[t("fig.ratcroq.fund"), t("fig.ratcroq.collect", { days: croquettes.maxDays }), t("fig.ratcroq.seal")]}
      />
      <figcaption>{t("fig.ratcroq.caption")}</figcaption>
    </figure>
  );
}
