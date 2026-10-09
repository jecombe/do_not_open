import { useEffect, useState } from "react";
import { spec, studio } from "@dno/game-spec";
import { Box, C, Crate, Heads, Lane, Pipe } from "./croq";
import { useT } from "./i18n";

/**
 * The fees chapter: where the dollars go, as plumbing with coins running through it, and the
 * same thing as a table. Prices are the deployment's, not the spec's: kept here, next to the
 * words that quote them.
 */

/** Plain USDC per decryption credit (DecryptionCredits.price). */
export const CREDIT_PRICE = "0.01";
/** Free units a player gets each UTC day (the API's RELAYER_FREE_PER_DAY): Sepolia's, from its
 *  FREE_UNITS. Mainnet's are fewer (25 planned): change these with it (AUDIT_CHECKLIST O48). */
export const FREE_PER_DAY = 200;
/** Free units a day for a wallet that has not played yet (RELAYER_NEWCOMER_PER_DAY): Sepolia's (16, one 10-id mint, planned for mainnet). */
export const NEWCOMER_PER_DAY = 100;
/** Units an encrypted input costs (RELAYER_INPUT_UNITS): Zama charges an input five times a decryption. */
export const INPUT_UNITS = 5;
/** Units a value made public costs the wallet that asks first (RELAYER_PUBLIC_UNITS). */
export const PUBLIC_UNITS = 1;
/** The ramp's fee on ETH, in percent. */
export const RAMP_PCT = 0.3;

const { meal } = spec.economy;

/** True when the reader asked for less motion: the coins then stay home. */
function useCalm(): boolean {
  const [calm, setCalm] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setCalm(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return calm;
}

/**
 * Each coin's whole trip, from you to where the money ends up. Coins are drawn under the
 * crates, so they vanish into one and come out the other side.
 */
const TRIPS: { d: string; color: string; begin: number }[] = [
  // A mint, an opening or a pet: to the treasury, which pays Zama.
  { d: "M222 295 C270 295 270 185 326 185 L554 190 C610 190 615 230 676 230 L805 245 L605 560", color: C.sodium, begin: 0 },
  // A paid shake: 70% to the box's holder...
  { d: "M222 280 C270 280 270 65 326 65 L554 55 L800 55", color: C.spectral, begin: 1 },
  // ...and 30% to the treasury, which pays the servers.
  { d: "M222 280 C270 280 270 65 326 65 L554 80 C615 80 615 195 676 195 L805 250 L745 560", color: C.spectral, begin: 2 },
  // Credits: to the treasury, which pays Zama.
  { d: "M222 305 L326 305 L554 305 C615 305 615 265 676 265 L805 255 L605 560", color: C.tape, begin: 3 },
  // The studio: packs and adoptions, to the treasury, which pays the AI.
  { d: "M222 325 C270 325 270 425 326 425 L554 425 C640 425 640 300 676 300 L805 260 L885 560", color: C.pink, begin: 4 },
];
const TRIP_SECONDS = 5;

function Coin({ d, color, begin }: { d: string; color: string; begin: number }) {
  return (
    <g>
      <circle r={11} fill={color} stroke={C.ink} strokeWidth={2.5} />
      <text textAnchor="middle" dy={5} className="fees-coin-mark">
        $
      </text>
      <animateMotion dur={`${TRIP_SECONDS}s`} begin={`${begin}s`} repeatCount="indefinite" path={d} keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
    </g>
  );
}

export function FeesFigure() {
  const t = useT();
  const calm = useCalm();
  const free = { free: FREE_PER_DAY };
  return (
    <figure className="diagram">
      <div className="diagram-scroll">
        <svg viewBox="0 0 960 620" role="img" aria-label={t("fig.fees.aria")}>
          <Heads />
          <Pipe d="M222 280 C270 280 270 65 322 65" label="" lx={0} ly={0} color={C.spectral} />
          <Pipe d="M222 295 C270 295 270 185 322 185" label="" lx={0} ly={0} color={C.sodium} />
          <Pipe d="M222 305 L322 305" label="" lx={0} ly={0} color={C.tape} />
          <Pipe d="M222 325 C270 325 270 425 322 425" label="" lx={0} ly={0} color={C.pink} />
          <Pipe d="M554 55 L672 55" label={t("fig.fees.share70")} lx={613} ly={43} color={C.spectral} />
          <Pipe d="M554 80 C615 80 615 195 672 195" label={t("fig.fees.share30")} lx={622} ly={130} color={C.spectral} anchor="start" />
          <Pipe d="M554 190 C610 190 615 230 672 230" label="" lx={0} ly={0} color={C.sodium} />
          <Pipe d="M554 305 C615 305 615 265 672 265" label="" lx={0} ly={0} color={C.tape} />
          <Pipe d="M554 425 C640 425 640 300 672 300" label="" lx={0} ly={0} color={C.pink} />
          <Pipe d="M730 324 C700 400 615 440 605 506" label={t("fig.fees.pays")} lx={650} ly={420} color={C.kraft} anchor="end" />
          <Pipe d="M795 324 L748 506" label="" lx={0} ly={0} color={C.kraft} />
          <Pipe d="M860 324 L885 506" label="" lx={0} ly={0} color={C.kraft} />

          {!calm && TRIPS.map((trip) => <Coin key={trip.d} {...trip} />)}

          <Crate x={20} y={250} w={200} h={110} fill={C.spectral} title={t("fig.fees.you")} sub={t("fig.fees.youSub")} />
          <Crate x={326} y={20} w={228} h={90} fill={C.spectral} title={t("fig.fees.shake")} sub={t("fig.fees.shakeSub")} />
          <Crate x={326} y={140} w={228} h={90} fill={C.sodium} title={t("fig.fees.paid")} sub={t("fig.fees.paidSub")} />
          <Crate x={326} y={260} w={228} h={90} fill={C.tape} title={t("fig.fees.credits")} sub={t("fig.fees.creditsSub", free)} />
          <Crate x={326} y={380} w={228} h={90} fill={C.pink} title={t("fig.fees.studio")} sub={t("fig.fees.studioSub")} />
          <Crate x={676} y={10} w={250} h={90} fill={C.paper} dashed title={t("fig.fees.holder")} sub={t("fig.fees.holderSub")} />
          <Crate x={676} y={170} w={250} h={150} fill={C.kraft} title={t("fig.fees.treasury")} sub={t("fig.fees.treasurySub")} />
          <Crate x={540} y={510} w={130} h={96} fill={C.paper} title={t("fig.fees.zama")} sub={t("fig.fees.zamaSub")} />
          <Crate x={680} y={510} w={130} h={96} fill={C.paper} title={t("fig.fees.servers")} sub={t("fig.fees.serversSub")} />
          <Crate x={820} y={510} w={130} h={96} fill={C.paper} title={t("fig.fees.ai")} sub={t("fig.fees.aiSub")} />
        </svg>
      </div>
      <div className={calm ? "diagram-phone fees-phone" : "diagram-phone fees-phone is-moving"} role="img" aria-label={t("fig.fees.aria")}>
        <Box fill={C.spectral} title={t("fig.fees.you")} sub={t("fig.fees.youSub")} />
        <FlowLane color={C.sodium} />
        <div className="fees-rows">
          <Box fill={C.sodium} title={t("fig.fees.paid")} sub={t("fig.fees.paidSub")} />
          <Dest color={C.sodium} lines={[t("fig.fees.treasury")]} />
          <Box fill={C.spectral} title={t("fig.fees.shake")} sub={t("fig.fees.shakeSub")} />
          <Dest color={C.spectral} delay={0.6} lines={[`${t("fig.fees.share70")} ${t("fig.fees.holder")}`, `${t("fig.fees.share30")} ${t("fig.fees.treasury")}`]} />
          <Box fill={C.tape} title={t("fig.fees.credits")} sub={t("fig.fees.creditsSub", free)} />
          <Dest color={C.tape} delay={1.2} lines={[t("fig.fees.treasury")]} />
          <Box fill={C.pink} title={t("fig.fees.studio")} sub={t("fig.fees.studioSub")} />
          <Dest color={C.pink} delay={1.8} lines={[t("fig.fees.treasury")]} />
        </div>
        <FlowLane color={C.kraft} delay={0.3} />
        <Box fill={C.kraft} title={t("fig.fees.treasury")} sub={t("fig.fees.treasurySub")} />
        <FlowLane color={C.kraft} delay={0.9} label={t("fig.fees.pays")} />
        <div className="fees-split">
          <Box fill={C.paper} title={t("fig.fees.zama")} sub={t("fig.fees.zamaSub")} />
          <Box fill={C.paper} title={t("fig.fees.servers")} sub={t("fig.fees.serversSub")} />
          <Box fill={C.paper} title={t("fig.fees.ai")} sub={t("fig.fees.aiSub")} />
        </div>
      </div>
      <figcaption>{t("fig.fees.caption")}</figcaption>
    </figure>
  );
}

/** On a phone, where one kind of payment goes: an arrow to the right, and the names. */
function Dest({ color, lines, delay = 0 }: { color: string; lines: string[]; delay?: number }) {
  return (
    <div className="fees-dest" style={{ color }}>
      <span className="fees-dest-pipe" aria-hidden="true">
        <svg viewBox="0 0 44 16">
          <path d="M2 8 L34 8" stroke={color} strokeWidth={4} strokeLinecap="round" />
          <path d="M32 1 L43 8 L32 15 Z" fill={color} />
        </svg>
        <span className="fees-slide" style={{ background: color, animationDelay: `${delay}s` }} />
      </span>
      <p>
        {lines.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </p>
    </div>
  );
}

/** A short downward pipe for the phone version, with a coin dropping through it. */
function FlowLane({ color, delay = 0, label }: { color: string; delay?: number; label?: string }) {
  return (
    <div className="fees-lane" style={{ color }}>
      <svg viewBox="0 0 16 44" aria-hidden="true">
        <path d="M8 2 L8 36" stroke={color} strokeWidth={4} strokeLinecap="round" />
        <path d="M1 32 L8 43 L15 32 Z" fill={color} />
      </svg>
      <span className="fees-drop" style={{ background: color, animationDelay: `${delay}s` }} aria-hidden="true" />
      {label && <p>{label}</p>}
    </div>
  );
}

const FEES = [
  { key: "f1", to: "docs.fees.treasury" },
  { key: "f2", to: "docs.fees.treasury" },
  { key: "f3", to: "docs.fees.treasury" },
  { key: "f4", to: "docs.fees.f4.to" },
  { key: "f5", to: "docs.fees.treasury" },
  { key: "f6", to: "docs.fees.treasury" },
  { key: "f9", to: "docs.fees.f9.to" },
  { key: "f10", to: "docs.fees.f10.to" },
  { key: "f7", to: "docs.fees.f7.to" },
  { key: "f8", to: "docs.fees.f8.to" },
] as const;

/** Every fee in one table: what you pay for, how much, and who receives it. */
export function FeeTable() {
  const t = useT();
  const vars = {
    price: CREDIT_PRICE,
    pct: RAMP_PCT,
    treasury: meal.treasuryBps / 100,
    burn: meal.burnBps / 100,
    reserve: (10_000 - meal.treasuryBps - meal.burnBps) / 100,
    starter: studio.packs[0]!.priceUsdc,
    litter: studio.packs[1]!.priceUsdc,
    seedRat: studio.rats.mint.seedPriceUsdc,
    modelRat: studio.rats.mint.modelPriceUsdc,
  };
  return (
    <div className="form">
      <table>
        <thead>
          <tr>
            <th scope="col">{t("docs.fees.h.fee")}</th>
            <th scope="col">{t("docs.fees.h.price")}</th>
            <th scope="col">{t("docs.fees.h.to")}</th>
          </tr>
        </thead>
        <tbody>
          {FEES.map((row) => (
            <tr key={row.key}>
              <th scope="row">{t(`docs.fees.${row.key}`)}</th>
              <td>{t(`docs.fees.${row.key}.price`, vars)}</td>
              <td>{t(row.to, vars)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
