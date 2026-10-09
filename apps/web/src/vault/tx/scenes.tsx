import { useEffect, useState } from "react";
import { tokenLogoUrl } from "../../brand/logos";

/**
 * A small animated scene for each kind of vault action, drawn in SVG and moved by CSS (tx.css):
 * it loops while the action runs and freezes under a stamp when it ends. Each action names its
 * scene in `SCENE_OF`; an unknown one gets the vault door.
 */
export type SceneKind = "press" | "seal" | "door" | "ship" | "trade" | "badge" | "shuffle" | "envelope" | "scan" | "key" | "pouch" | "pouches";

export const SCENE_OF: Record<string, SceneKind> = {
  mint: "press",
  deposit: "seal",
  withdraw: "door",
  claim: "door",
  list: "ship",
  unlist: "ship",
  buy: "trade",
  offer: "trade",
  cancelOffer: "trade",
  acceptOffer: "trade",
  delegate: "badge",
  send: "shuffle",
  adopt: "key",
  sell: "envelope",
  cancelSale: "envelope",
  accept: "envelope",
  prices: "envelope",
  find: "scan",
  faucet: "press",
  pocketOpen: "pouch",
  pocketDeposit: "pouch",
  pocketWithdraw: "pouch",
  pocketSend: "pouches",
  pocketBuy: "trade",
  pocketOffer: "envelope",
};

/** Actions whose scene runs backwards: the listing sails home, the offer comes back. */
const REVERSED = new Set(["unlist", "cancelOffer", "cancelSale", "pocketWithdraw"]);
/** The pouch opening, rather than a coin going in or out. */
const SEWING = new Set(["pocketOpen"]);

const GLYPHS = "0123456789abcdef#%&@$*+=<>";

/** A line of glyphs that keeps changing: something encrypted, never readable. */
export function CipherLine({ length, live = true }: { length: number; live?: boolean }) {
  const roll = () => Array.from({ length }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join("");
  const [text, setText] = useState(roll);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setText(roll()), 90);
    return () => clearInterval(id);
  }, [live, length]);
  return <>{text}</>;
}

/** An NFT as a little framed card, drawn at the origin: 30 wide, 38 tall. */
function Card({ className }: { className?: string }) {
  return (
    <g className={className}>
      <rect x="0" y="0" width="30" height="38" rx="4" fill="url(#vx-art)" stroke="#e6edf3" strokeWidth="1.5" />
      <circle cx="15" cy="15" r="6" fill="#07090c" opacity="0.55" />
      <rect x="6" y="27" width="18" height="3" rx="1.5" fill="#07090c" opacity="0.55" />
    </g>
  );
}

/** A taped kraft box, drawn at the origin: 44 wide, 34 tall. */
function Box({ className, tape = true }: { className?: string; tape?: boolean }) {
  return (
    <g className={className}>
      <rect x="0" y="0" width="44" height="34" rx="3" fill="#c99a63" stroke="#07090c" strokeWidth="1.5" />
      {tape && <rect x="0" y="13" width="44" height="8" fill="#e8d3a2" opacity="0.9" />}
      <rect x="10" y="6" width="24" height="22" fill="none" stroke="#ff4d3d" strokeWidth="2" opacity="0.85" />
    </g>
  );
}

/** An ETH coin, centred on the origin. */
function Coin({ className }: { className?: string }) {
  return (
    <g className={className}>
      <circle r="11" fill="#5be3c2" stroke="#07090c" strokeWidth="1.5" />
      <path d="M0 -7 L5 0 L0 3 L-5 0 Z M0 4.5 L5 1.5 L0 8 L-5 1.5 Z" fill="#07090c" />
    </g>
  );
}

/** A token's coin, centred on the origin: its logo when it has one (cZAMA, cUSDT…), else the ETH coin. */
function TokenCoin({ token, className }: { token?: string | null; className?: string }) {
  const src = token ? tokenLogoUrl(token) : null;
  if (!src) return <Coin className={className} />;
  return (
    <g className={className}>
      <circle r="11.5" fill="#07090c" />
      <image href={src} x="-11" y="-11" width="22" height="22" />
    </g>
  );
}

function Defs() {
  return (
    <defs>
      <linearGradient id="vx-art" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#5be3c2" />
        <stop offset="1" stopColor="#c99a63" />
      </linearGradient>
    </defs>
  );
}

function Press() {
  return (
    <>
      <rect x="40" y="118" width="160" height="6" rx="3" fill="#2a3644" />
      <g transform="translate(105 78)">
        <Card className="vx-pop" />
      </g>
      <g className="vx-press">
        <rect x="117" y="0" width="6" height="44" fill="#2a3644" />
        <rect x="96" y="40" width="48" height="16" rx="3" fill="#ff4d3d" />
        <text x="120" y="52" textAnchor="middle" className="vx-stencil" fontSize="9" fill="#07090c">
          NFT
        </text>
      </g>
      <g className="vx-sparks">
        <path d="M80 92 l-10 -6 M160 92 l10 -6 M84 108 l-12 2 M156 108 l12 2" stroke="#5be3c2" strokeWidth="2" strokeLinecap="round" />
      </g>
    </>
  );
}

function Seal({ decoys }: { decoys: number }) {
  const ghosts = Math.min(decoys, 4);
  return (
    <>
      {Array.from({ length: ghosts }, (_, i) => {
        const x = [50, 146, 4, 192][i]!;
        return (
          <g key={i} transform={`translate(${x} 86)`} className={`vx-decoy vx-decoy-${i}`}>
            <Box tape={false} className="vx-ghost" />
          </g>
        );
      })}
      <g transform="translate(105 18)">
        <Card className="vx-drop" />
      </g>
      <g transform="translate(98 86)">
        <Box tape={false} />
        <rect className="vx-lid vx-lid-l" x="0" y="-2" width="22" height="5" fill="#b88a55" stroke="#07090c" strokeWidth="1" />
        <rect className="vx-lid vx-lid-r" x="22" y="-2" width="22" height="5" fill="#b88a55" stroke="#07090c" strokeWidth="1" />
        <g className="vx-tape">
          <rect x="-6" y="12" width="56" height="10" fill="#e8d3a2" />
          <text x="22" y="20" textAnchor="middle" className="vx-stencil" fontSize="6.5" fill="#ff4d3d">
            DO NOT OPEN
          </text>
        </g>
      </g>
    </>
  );
}

function Door({ coin }: { coin: boolean }) {
  return (
    <>
      <g transform="translate(130 52)">
        <g className="vx-out">{coin ? <Coin /> : <Card />}</g>
      </g>
      <rect x="62" y="16" width="108" height="108" rx="12" fill="#111821" stroke="#2a3644" strokeWidth="2" />
      <g className="vx-door">
        <circle cx="116" cy="70" r="44" fill="#1c2530" stroke="#5be3c2" strokeWidth="2" />
        <circle cx="116" cy="70" r="34" fill="none" stroke="#2a3644" strokeWidth="3" strokeDasharray="4 6" />
        <g className="vx-wheel">
          {[0, 60, 120].map((a) => (
            <rect key={a} x="113" y="44" width="6" height="52" rx="3" fill="#8b97a6" transform={`rotate(${a} 116 70)`} />
          ))}
          <circle cx="116" cy="70" r="9" fill="#ff4d3d" />
        </g>
      </g>
    </>
  );
}

function Ship() {
  return (
    <>
      <g className="vx-sail">
        <g className="vx-bob">
          <path d="M-34 0 L34 0 L24 16 L-24 16 Z" fill="#c99a63" stroke="#07090c" strokeWidth="1.5" />
          <rect x="-1.5" y="-46" width="3" height="46" fill="#8b97a6" />
          <path d="M2 -44 L30 -8 L2 -8 Z" fill="#e6edf3" />
          <path d="M-2 -40 L-24 -8 L-2 -8 Z" fill="#5be3c2" />
          <g transform="translate(-12 -26) scale(0.62)">
            <Card />
          </g>
        </g>
      </g>
      <g className="vx-waves">
        <path d="M-40 112 q15 -8 30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0" fill="none" stroke="#5be3c2" strokeWidth="2.5" opacity="0.8" />
        <path d="M-55 124 q15 -8 30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0" fill="none" stroke="#2a3644" strokeWidth="2.5" />
      </g>
    </>
  );
}

function Trade() {
  return (
    <>
      <path d="M60 96 Q120 20 180 96" fill="none" stroke="#2a3644" strokeWidth="2" strokeDasharray="4 6" className="vx-dash" />
      <path d="M60 110 Q120 130 180 110" fill="none" stroke="#2a3644" strokeWidth="2" strokeDasharray="4 6" className="vx-dash" />
      <g className="vx-swap-a">
        <g transform="translate(-15 -19)">
          <Card />
        </g>
      </g>
      <g className="vx-swap-b">
        <Coin />
      </g>
    </>
  );
}

function Badge() {
  return (
    <>
      <g transform="translate(28 74)">
        <Box />
      </g>
      <g transform="translate(166 70)">
        <g className="vx-wallet">
          <rect x="0" y="0" width="48" height="36" rx="6" fill="#111821" stroke="#5be3c2" strokeWidth="2" />
          <rect x="30" y="12" width="18" height="12" rx="3" fill="#1c2530" stroke="#5be3c2" strokeWidth="1.5" />
          <circle cx="38" cy="18" r="2.5" fill="#5be3c2" />
        </g>
      </g>
      <g className="vx-fly">
        <rect x="-14" y="-10" width="28" height="20" rx="3" fill="#e6edf3" stroke="#07090c" strokeWidth="1.5" />
        <circle cx="-6" cy="-1" r="4" fill="#5be3c2" />
        <rect x="1" y="-4" width="9" height="2.5" fill="#07090c" />
        <rect x="1" y="1" width="7" height="2.5" fill="#07090c" opacity="0.6" />
        <rect x="-4" y="-15" width="8" height="5" rx="1" fill="#ff4d3d" />
      </g>
    </>
  );
}

function Shuffle() {
  return (
    <>
      <rect x="30" y="122" width="180" height="4" rx="2" fill="#2a3644" />
      {[0, 1, 2].map((i) => (
        <g key={i} className={`vx-shell vx-shell-${i}`}>
          <Box tape={i === 1} />
        </g>
      ))}
      <text x="120" y="30" textAnchor="middle" className="vx-stencil vx-q" fontSize="22" fill="#ff4d3d">
        ?
      </text>
    </>
  );
}

function Envelope() {
  return (
    <>
      <g className="vx-env">
        <rect x="60" y="34" width="120" height="76" rx="4" fill="#e6edf3" stroke="#07090c" strokeWidth="1.5" />
        <path d="M60 34 L120 78 L180 34" fill="none" stroke="#8b97a6" strokeWidth="1.5" />
        <circle cx="120" cy="78" r="12" fill="#ff4d3d" className="vx-wax" />
        <text x="120" y="82" textAnchor="middle" className="vx-stencil" fontSize="9" fill="#07090c">
          DNO
        </text>
      </g>
    </>
  );
}

function Scan() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(${56 + i * 46} ${30 + (i % 2) * 8})`}>
          <rect width="38" height="70" rx="3" fill="#111821" stroke="#2a3644" strokeWidth="1.5" />
          {[12, 22, 32, 42, 52].map((y) => (
            <rect key={y} x="6" y={y} width={y === 32 ? 18 : 26} height="3" rx="1.5" fill="#2a3644" />
          ))}
          <rect className={`vx-hit vx-hit-${i}`} x="4" y="28" width="30" height="11" rx="2" fill="none" stroke="#5be3c2" strokeWidth="2" />
        </g>
      ))}
      <g className="vx-lens">
        <circle r="18" fill="rgb(91 227 194 / 0.12)" stroke="#e6edf3" strokeWidth="3" />
        <rect x="11" y="11" width="6" height="22" rx="3" fill="#e6edf3" transform="rotate(-45 14 14)" />
      </g>
    </>
  );
}

function KeyLock() {
  return (
    <>
      <path className="vx-shackle" d="M98 66 V46 a22 22 0 0 1 44 0 V66" fill="none" stroke="#8b97a6" strokeWidth="7" strokeLinecap="round" />
      <rect x="84" y="62" width="72" height="56" rx="8" fill="#c99a63" stroke="#07090c" strokeWidth="1.5" />
      <circle cx="120" cy="84" r="6" fill="#07090c" />
      <rect x="117" y="86" width="6" height="16" fill="#07090c" />
      <g className="vx-key">
        <circle cx="120" cy="128" r="8" fill="none" stroke="#5be3c2" strokeWidth="3.5" />
        <rect x="118.5" y="96" width="3" height="24" fill="#5be3c2" />
        <rect x="121" y="100" width="5" height="3" fill="#5be3c2" />
      </g>
    </>
  );
}

/** A drawstring pouch, centred on the origin, about 60 wide. */
function PouchShape({ className, mark = true, token }: { className?: string; mark?: boolean; token?: string | null }) {
  const logo = token ? tokenLogoUrl(token) : null;
  return (
    <g className={className}>
      <path d="M-26 -10 Q-30 30 0 34 Q30 30 26 -10 Z" fill="#c99a63" stroke="#07090c" strokeWidth="1.5" />
      <path d="M-20 -10 Q0 -24 20 -10" fill="none" stroke="#07090c" strokeWidth="1.5" />
      <rect x="-28" y="-15" width="56" height="9" rx="4" fill="#e8d3a2" stroke="#07090c" strokeWidth="1.2" />
      {mark && (logo ? <image href={logo} x="-9" y="3" width="18" height="18" /> : <circle cx="0" cy="12" r="8" fill="#ff4d3d" />)}
    </g>
  );
}

/** Coins drop into the pouch (out of it, reversed); opening, its seam is stitched and it locks. */
function Pouch({ sewing, token }: { sewing: boolean; token?: string | null }) {
  return (
    <>
      <rect x="40" y="122" width="160" height="4" rx="2" fill="#2a3644" />
      <g transform="translate(120 84)">
        <PouchShape className="vx-pouch" token={token} />
      </g>
      {sewing ? (
        <g className="vx-stitch">
          <path d="M92 70 L100 64 L108 70 L116 64 L124 70 L132 64 L140 70 L148 64" fill="none" stroke="#5be3c2" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="6 4" />
        </g>
      ) : (
        [0, 1, 2].map((i) => (
          <g key={i} transform={`translate(${112 + i * 8} 0)`}>
            <g className={`vx-coin vx-coin-${i}`}>
              <TokenCoin token={token} />
            </g>
          </g>
        ))
      )}
    </>
  );
}

/** A coin hops from one pouch to another among four, the others twitching: which one paid? */
function Pouches({ token }: { token?: string | null }) {
  return (
    <>
      <rect x="10" y="122" width="220" height="4" rx="2" fill="#2a3644" />
      {[34, 92, 150, 208].map((x, i) => (
        <g key={x} transform={`translate(${x} 96) scale(0.72)`}>
          <PouchShape className={`vx-twitch vx-twitch-${i}`} mark={i === 0 || i === 2} token={token} />
        </g>
      ))}
      <g className="vx-hop">
        <TokenCoin token={token} />
      </g>
    </>
  );
}

/** The scene of an action, looping while `live`, frozen under `stamp` once it ended. A pocket's
 *  scenes wear `token`'s logo: on the pouch, and on the coins going in, out or across. */
export function TxScene({
  name,
  decoys = 0,
  token = null,
  live,
  stamp,
  failed = false,
  small = false,
}: {
  name: string;
  decoys?: number;
  token?: string | null;
  live: boolean;
  stamp?: string | null;
  failed?: boolean;
  small?: boolean;
}) {
  const kind = SCENE_OF[name] ?? "door";
  const classes = ["vx-scene", `vx-${kind}`, live ? "is-live" : "is-still", REVERSED.has(name) && "is-reversed", failed && "is-failed", small && "is-small"].filter(Boolean).join(" ");
  return (
    <div className={classes} aria-hidden="true">
      <svg viewBox="0 0 240 140">
        <Defs />
        {kind === "press" && <Press />}
        {kind === "seal" && <Seal decoys={decoys} />}
        {kind === "door" && <Door coin={name === "claim"} />}
        {kind === "ship" && <Ship />}
        {kind === "trade" && <Trade />}
        {kind === "badge" && <Badge />}
        {kind === "shuffle" && <Shuffle />}
        {kind === "envelope" && <Envelope />}
        {kind === "scan" && <Scan />}
        {kind === "key" && <KeyLock />}
        {kind === "pouch" && <Pouch sewing={SEWING.has(name)} token={token} />}
        {kind === "pouches" && <Pouches token={token} />}
      </svg>
      {stamp && !small && <span className="vx-stamp">{stamp}</span>}
    </div>
  );
}
