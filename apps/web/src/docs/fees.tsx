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
/** Free units a player gets each UTC day (the API's RELAYER_FREE_PER_DAY). */
export const FREE_PER_DAY = 25;
/** Free units a day for a wallet that has not played yet (RELAYER_NEWCOMER_PER_DAY): one 10-id mint. */
export const NEWCOMER_PER_DAY = 16;
/** Units an encrypted input costs (RELAYER_INPUT_UNITS): Zama charges an input five times a decryption. */
export const INPUT_UNITS = 5;
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
  { d: "M222 230 L326 230 L554 235 L676 235 L805 240 L700 490", color: C.sodium, begin: 0 },
  // A paid shake: 70% to the box's holder...
  { d: "M222 205 C270 205 270 85 326 85 L554 75 L800 75", color: C.spectral, begin: 1.2 },
  // ...and 30% to the treasury, which pays the servers.
  { d: "M222 205 C270 205 270 85 326 85 L554 100 C615 100 615 205 676 205 L805 250 L870 490", color: C.sodium, begin: 2.4 },
  // Credits: to the treasury, which pays Zama.
  { d: "M222 255 C270 255 270 375 326 375 L554 375 C615 375 615 265 676 265 L805 260 L700 490", color: C.tape, begin: 3.6 },
];
const TRIP_SECONDS = 4.8;

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
        <svg viewBox="0 0 960 560" role="img" aria-label={t("fig.fees.aria")}>
          <Heads />
          <Pipe d="M222 205 C270 205 270 85 322 85" label="" lx={0} ly={0} color={C.spectral} />
          <Pipe d="M222 230 L322 230" label="" lx={0} ly={0} color={C.sodium} />
          <Pipe d="M222 255 C270 255 270 375 322 375" label="" lx={0} ly={0} color={C.tape} />
          <Pipe d="M554 72 L672 72" label={t("fig.fees.share70")} lx={613} ly={60} color={C.spectral} />
          <Pipe d="M554 100 C615 100 615 205 672 205" label={t("fig.fees.share30")} lx={622} ly={150} color={C.spectral} anchor="start" />
          <Pipe d="M554 235 L672 235" label="" lx={0} ly={0} color={C.sodium} />
          <Pipe d="M554 375 C615 375 615 265 672 265" label="" lx={0} ly={0} color={C.tape} />
          <Pipe d="M760 300 C740 360 700 400 695 426" label={t("fig.fees.pays")} lx={716} ly={372} color={C.kraft} anchor="end" />
          <Pipe d="M850 300 L862 426" label={t("fig.fees.pays")} lx={872} ly={372} color={C.kraft} anchor="start" />

          {!calm && TRIPS.map((trip) => <Coin key={trip.d} {...trip} />)}

          <Crate x={20} y={175} w={200} h={110} fill={C.spectral} title={t("fig.fees.you")} sub={t("fig.fees.youSub")} />
          <Crate x={326} y={35} w={228} h={100} fill={C.spectral} title={t("fig.fees.shake")} sub={t("fig.fees.shakeSub")} />
          <Crate x={326} y={180} w={228} h={100} fill={C.sodium} title={t("fig.fees.paid")} sub={t("fig.fees.paidSub")} />
          <Crate x={326} y={325} w={228} h={100} fill={C.tape} title={t("fig.fees.credits")} sub={t("fig.fees.creditsSub", free)} />
          <Crate x={676} y={35} w={250} h={100} fill={C.paper} dashed title={t("fig.fees.holder")} sub={t("fig.fees.holderSub")} />
          <Crate x={676} y={180} w={250} h={120} fill={C.kraft} title={t("fig.fees.treasury")} sub={t("fig.fees.treasurySub")} />
          <Crate x={600} y={430} w={180} h={100} fill={C.paper} title={t("fig.fees.zama")} sub={t("fig.fees.zamaSub")} />
          <Crate x={790} y={430} w={150} h={100} fill={C.paper} title={t("fig.fees.servers")} sub={t("fig.fees.serversSub")} />
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
        </div>
        <FlowLane color={C.kraft} delay={0.3} />
        <Box fill={C.kraft} title={t("fig.fees.treasury")} sub={t("fig.fees.treasurySub")} />
        <FlowLane color={C.kraft} delay={0.9} label={t("fig.fees.pays")} />
        <div className="fees-split">
          <Box fill={C.paper} title={t("fig.fees.zama")} sub={t("fig.fees.zamaSub")} />
          <Box fill={C.paper} title={t("fig.fees.servers")} sub={t("fig.fees.serversSub")} />
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
