import { spec, type AllocationKey } from "@dno/game-spec";
import { useLocale } from "../i18n/locale";
import { buildName } from "../i18n/names";
import { useT } from "./i18n";

/**
 * The croquette chapter's figures. Hand-drawn SVG, like the paper slips elsewhere in the
 * manual: no three.js here, the point is the plumbing, not the cardboard.
 * Every number comes from the economy section of the game spec.
 */

const { economy } = spec;
const BPS = 10_000;
const pct = (bps: number) => bps / 100;

// Drawing palette, the manual's colours (see docs.css).
export const C = {
  ink: "#1c1814",
  paper: "#e9dfc8",
  tape: "#d9c28a",
  sodium: "#ffb454",
  spectral: "#7de3d0",
  red: "#e0473c",
  kraft: "#b8895a",
  pink: "#e85d9c",
};

/**
 * Squeezes a line that would overflow its crate (a long word in another language) into the
 * room there is. `perChar` is a rough width per character at the class's font size.
 */
function squeeze(text: string, room: number, perChar: number): { textLength?: number; lengthAdjust?: "spacingAndGlyphs" } {
  return text.length * perChar > room ? { textLength: room, lengthAdjust: "spacingAndGlyphs" } : {};
}

/** A labelled crate: a title in stencil and one line underneath. */
export function Crate({ x, y, w, h, title, sub, fill, dashed, symbol }: { x: number; y: number; w: number; h: number; title: string; sub: string; fill: string; dashed?: boolean; symbol?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill={fill} stroke={C.ink} strokeWidth={3} strokeDasharray={dashed ? "8 6" : undefined} />
      <text x={x + w / 2} y={y + h / 2 - 6} textAnchor="middle" className="croq-svg-title" style={symbol ? { textTransform: "none" } : undefined} {...squeeze(title, w - 24, 15)}>
        {title}
      </text>
      <text x={x + w / 2} y={y + h / 2 + 20} textAnchor="middle" className="croq-svg-sub" {...squeeze(sub, w - 20, 8.6)}>
        {sub}
      </text>
    </g>
  );
}

/** An arrow along a path, with its label at (lx, ly). */
export function Pipe({ d, label, lx, ly, color = C.tape, anchor = "middle" }: { d: string; label: string; lx: number; ly: number; color?: string; anchor?: "start" | "middle" | "end" }) {
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth={4} markerEnd={`url(#croq-head-${color.slice(1)})`} strokeLinecap="round" />
      <text x={lx} y={ly} textAnchor={anchor} className="croq-svg-label" fill={color}>
        {label}
      </text>
    </g>
  );
}

/** A crate for the phone versions: the same box, drawn in HTML so its words wrap. */
export function Box({ title, sub, fill, dashed, symbol }: { title: string; sub: string; fill: string; dashed?: boolean; symbol?: boolean }) {
  return (
    <div className={dashed ? "croq-box is-dashed" : "croq-box"} style={{ background: fill }}>
      <strong style={symbol ? { textTransform: "none" } : undefined}>{title}</strong>
      <span>{sub}</span>
    </div>
  );
}

/** One vertical pipe between two stacked crates, its label beside it. */
export function Lane({ label, note, color, up, side = "right" }: { label: string; note?: string; color: string; up?: boolean; side?: "left" | "right" }) {
  return (
    <div className={`croq-lane is-${side}`} style={{ color }}>
      <svg viewBox="0 0 16 56" aria-hidden="true">
        <path d={up ? "M8 54 L8 8" : "M8 2 L8 48"} stroke={color} strokeWidth={4} strokeLinecap="round" />
        <path d={up ? "M1 12 L8 1 L15 12 Z" : "M1 44 L8 55 L15 44 Z"} fill={color} />
      </svg>
      <p>
        {label}
        {note && <small>{note}</small>}
      </p>
    </div>
  );
}

export function Heads() {
  return (
    <defs>
      {[C.tape, C.sodium, C.spectral, C.red, C.kraft, C.pink].map((color) => (
        <marker key={color} id={`croq-head-${color.slice(1)}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" fill={color} />
        </marker>
      ))}
    </defs>
  );
}

/** Public CROQ on the market, the wrapper in the middle, confidential cCROQ in the game. */
export function TwoTokensFigure() {
  const t = useT();
  const { symbol, confidentialSymbol } = economy.token;
  return (
    <figure className="diagram">
      <div className="diagram-scroll">
        <svg viewBox="0 0 960 330" role="img" aria-label={t("fig.croq.two.aria")}>
          <Heads />
          {/* The public side, in the light. */}
          <rect x={6} y={6} width={560} height={318} rx={14} fill="rgb(255 180 84 / 0.08)" stroke={C.sodium} strokeDasharray="4 8" />
          <text x={22} y={34} className="croq-svg-zone" fill={C.sodium}>
            {t("fig.croq.two.public")}
          </text>
          {/* The confidential side, in the dark. */}
          <rect x={590} y={6} width={364} height={318} rx={14} fill="rgb(125 227 208 / 0.07)" stroke={C.spectral} strokeDasharray="4 8" />
          <text x={606} y={34} className="croq-svg-zone" fill={C.spectral}>
            {t("fig.croq.two.secret")}
          </text>

          <Crate x={30} y={110} w={210} h={96} fill={C.sodium} title={t("fig.croq.two.market")} sub={t("fig.croq.two.marketSub")} />
          <Crate x={330} y={110} w={210} h={96} fill={C.paper} title={symbol} sub={t("fig.croq.two.plainSub")} />
          <Crate x={690} y={110} w={210} h={96} fill={C.spectral} title={confidentialSymbol} sub={t("fig.croq.two.confSub")} symbol />

          <Pipe d="M244 142 L326 142" label={t("fig.croq.two.buy")} lx={285} ly={130} color={C.sodium} />
          <Pipe d="M326 176 L244 176" label={t("fig.croq.two.sell")} lx={285} ly={200} color={C.sodium} />
          <Pipe d="M544 142 L686 142" label={t("fig.croq.two.wrap")} lx={615} ly={130} />
          <Pipe d="M686 176 L544 176" label={t("fig.croq.two.unwrap")} lx={615} ly={200} />
          <text x={615} y={226} textAnchor="middle" className="croq-svg-note">
            {t("fig.croq.two.edgeNote")}
          </text>

          <Pipe d="M795 210 L795 262" label="" lx={795} ly={0} color={C.spectral} />
          <text x={795} y={290} textAnchor="middle" className="croq-svg-label" fill={C.spectral}>
            {t("fig.croq.two.game")}
          </text>
          <text x={285} y={290} textAnchor="middle" className="croq-svg-note">
            {t("fig.croq.two.marketNote")}
          </text>
        </svg>
      </div>
      <div className="diagram-phone" role="img" aria-label={t("fig.croq.two.aria")}>
        <div className="croq-zone" style={{ borderColor: C.sodium, background: "rgb(255 180 84 / 0.08)" }}>
          <p className="croq-zone-head" style={{ color: C.sodium }}>
            {t("fig.croq.two.public")}
            <small>{t("fig.croq.two.marketNote")}</small>
          </p>
          <Box fill={C.sodium} title={t("fig.croq.two.market")} sub={t("fig.croq.two.marketSub")} />
          <div className="croq-lanes">
            <Lane side="left" color={C.sodium} label={t("fig.croq.two.buy")} />
            <Lane up color={C.sodium} label={t("fig.croq.two.sell")} />
          </div>
          <Box fill={C.paper} title={symbol} sub={t("fig.croq.two.plainSub")} />
        </div>
        <div className="croq-lanes">
          <Lane side="left" color={C.tape} label={t("fig.croq.two.wrap")} />
          <Lane up color={C.tape} label={t("fig.croq.two.unwrap")} />
        </div>
        <p className="croq-note">{t("fig.croq.two.edgeNote")}</p>
        <div className="croq-zone" style={{ borderColor: C.spectral, background: "rgb(125 227 208 / 0.07)" }}>
          <p className="croq-zone-head" style={{ color: C.spectral }}>
            {t("fig.croq.two.secret")}
          </p>
          <Box fill={C.spectral} title={confidentialSymbol} sub={t("fig.croq.two.confSub")} symbol />
          <div className="croq-lanes is-single">
            <Lane color={C.spectral} label={t("fig.croq.two.game")} />
          </div>
        </div>
      </div>
      <figcaption>{t("fig.croq.two.caption", { symbol, csymbol: confidentialSymbol })}</figcaption>
    </figure>
  );
}

const ALLOCATION_COLORS: Record<AllocationKey, string> = {
  gameReserve: C.spectral,
  welcomeBags: C.tape,
  liquidity: C.sodium,
  treasury: C.kraft,
};

/** The whole supply, split the way it was at deployment. */
export function AllocationBar() {
  const t = useT();
  const locale = useLocale();
  const total = economy.token.totalSupply;
  return (
    <figure className="allocation">
      <div className="allocation-bar" role="img" aria-label={t("fig.croq.alloc.aria", { total: total.toLocaleString(locale) })}>
        {economy.allocation.map((a) => (
          <span key={a.key} style={{ flexGrow: a.amount, background: ALLOCATION_COLORS[a.key] }}>
            {Math.round((a.amount / total) * 100)}%
          </span>
        ))}
      </div>
      <ul className="allocation-legend">
        {economy.allocation.map((a) => (
          <li key={a.key}>
            <i style={{ background: ALLOCATION_COLORS[a.key] }} />
            <strong>{t(`fig.croq.alloc.${a.key}`)}</strong> {a.amount.toLocaleString(locale)}
            <span>{t(`fig.croq.alloc.${a.key}.v`)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Where croquettes go: reserve to players, players into their cat, and every meal split three ways. */
export function TokenFlowFigure() {
  const t = useT();
  const locale = useLocale();
  const reserve = economy.allocation.filter((a) => a.key === "gameReserve" || a.key === "welcomeBags").reduce((n, a) => n + a.amount, 0);
  const treasury = pct(economy.meal.treasuryBps);
  const burn = pct(economy.meal.burnBps);
  const back = pct(BPS - economy.meal.treasuryBps - economy.meal.burnBps);
  return (
    <figure className="diagram">
      <div className="diagram-scroll">
        <svg viewBox="0 0 960 420" role="img" aria-label={t("fig.croq.flow.aria")}>
          <Heads />
          <Crate x={20} y={50} w={230} h={100} fill={C.tape} title={t("fig.croq.flow.reserve")} sub={t("fig.croq.flow.reserveSub", { n: reserve.toLocaleString(locale) })} />
          <Crate x={365} y={50} w={230} h={100} fill={C.spectral} title={t("fig.croq.flow.balance")} sub={t("fig.croq.flow.balanceSub")} />
          <Crate x={710} y={50} w={230} h={100} fill={C.paper} dashed title={t("fig.croq.flow.cat")} sub={t("fig.croq.flow.catSub")} />
          <Crate x={710} y={300} w={230} h={100} fill={C.kraft} title={t("fig.croq.flow.treasury")} sub={t("fig.croq.flow.treasurySub")} />
          <Crate x={365} y={300} w={230} h={100} fill={C.red} title={t("fig.croq.flow.burnt")} sub={t("fig.croq.flow.burntSub")} />

          <Pipe d="M254 92 L361 92" label={t("fig.croq.flow.claim")} lx={307} ly={36} />
          <text x={135} y={176} textAnchor="middle" className="croq-svg-note">
            {t("fig.croq.flow.claimNote", { bag: economy.welcomeBag.amount, max: economy.purr.maxPerDay })}
          </text>
          <Pipe d="M599 100 L706 100" label={t("fig.croq.flow.meal", { cap: economy.meal.maxEatenPerDay.toLocaleString(locale) })} lx={652} ly={36} color={C.spectral} />
          <text x={825} y={176} textAnchor="middle" className="croq-svg-note">
            {t("fig.croq.flow.weightNote")}
          </text>
          <Pipe d="M560 154 L760 296" label={t("fig.croq.flow.toTreasury", { pct: treasury })} lx={690} ly={240} color={C.kraft} anchor="start" />
          <Pipe d="M480 154 L480 296" label={t("fig.croq.flow.mealBurn", { burn })} lx={470} ly={232} color={C.red} anchor="end" />
          <Pipe d="M400 154 Q300 250 135 154" label={t("fig.croq.flow.back", { pct: back })} lx={250} ly={262} color={C.tape} />
        </svg>
      </div>
      <div className="diagram-phone" role="img" aria-label={t("fig.croq.flow.aria")}>
        <Box fill={C.tape} title={t("fig.croq.flow.reserve")} sub={t("fig.croq.flow.reserveSub", { n: reserve.toLocaleString(locale) })} />
        <div className="croq-lanes">
          <Lane side="left" color={C.tape} label={t("fig.croq.flow.claim")} note={t("fig.croq.flow.claimNote", { bag: economy.welcomeBag.amount, max: economy.purr.maxPerDay })} />
          <Lane up color={C.tape} label={t("fig.croq.flow.back", { pct: back })} />
        </div>
        <Box fill={C.spectral} title={t("fig.croq.flow.balance")} sub={t("fig.croq.flow.balanceSub")} />
        <div className="croq-lanes is-single">
          <Lane color={C.spectral} label={t("fig.croq.flow.meal", { cap: economy.meal.maxEatenPerDay.toLocaleString(locale) })} />
        </div>
        <Box fill={C.paper} dashed title={t("fig.croq.flow.cat")} sub={t("fig.croq.flow.catSub")} />
        <p className="croq-note">{t("fig.croq.flow.weightNote")}</p>
        <div className="croq-split">
          <div>
            <Lane color={C.kraft} label={t("fig.croq.flow.toTreasury", { pct: treasury })} />
            <Box fill={C.kraft} title={t("fig.croq.flow.treasury")} sub={t("fig.croq.flow.treasurySub")} />
          </div>
          <div>
            <Lane color={C.red} label={t("fig.croq.flow.mealBurn", { burn })} />
            <Box fill={C.red} title={t("fig.croq.flow.burnt")} sub={t("fig.croq.flow.burntSub")} />
          </div>
        </div>
      </div>
      <figcaption>{t("fig.croq.flow.caption")}</figcaption>
    </figure>
  );
}

/** One row per build: how much a cat must have eaten, and how long that takes at the daily cap. */
export function BuildTable() {
  const t = useT();
  const locale = useLocale();
  const { weight, meal } = economy;
  const days = (n: number) => Math.ceil(n / meal.maxEatenPerDay);
  const heaviest = weight.sick.minWeight + weight.sick.weightSpread;
  return (
    <div className="form">
      <table>
        <thead>
          <tr>
            <th scope="col">{t("fig.croq.build.h.build")}</th>
            <th scope="col">{t("fig.croq.build.h.weight")}</th>
            <th scope="col">{t("fig.croq.build.h.days")}</th>
            <th scope="col">{t("fig.croq.build.h.bonus")}</th>
          </tr>
        </thead>
        <tbody>
          {weight.builds.map((b, i) => {
            const next = weight.builds[i + 1];
            return (
              <tr key={b.key}>
                <th scope="row">{buildName(b.key)}</th>
                <td>{next ? `${b.minWeight.toLocaleString(locale)} – ${(next.minWeight - 1).toLocaleString(locale)}` : `${b.minWeight.toLocaleString(locale)}+`}</td>
                <td>{b.minWeight === 0 ? "–" : days(b.minWeight)}</td>
                <td>+{b.scoreBonus}</td>
              </tr>
            );
          })}
          <tr>
            <th scope="row">{t("fig.croq.build.sick")}</th>
            <td>{`${weight.sick.minWeight.toLocaleString(locale)} – ${heaviest.toLocaleString(locale)}`}</td>
            <td>{`${days(weight.sick.minWeight)} – ${days(heaviest)}`}</td>
            <td>+{weight.sick.scoreBonus}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const LEAKS = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"] as const;

/** What the economy keeps secret, and what it cannot. */
export function LeakTable() {
  const t = useT();
  return (
    <div className="form">
      <table>
        <thead>
          <tr>
            <th scope="col">{t("docs.privacy.h.fact")}</th>
            <th scope="col">{t("fig.croq.leak.h.who")}</th>
          </tr>
        </thead>
        <tbody>
          {LEAKS.map((k) => (
            <tr key={k}>
              <th scope="row">{t(`fig.croq.leak.${k}`)}</th>
              <td>{t(`fig.croq.leak.${k}.v`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
