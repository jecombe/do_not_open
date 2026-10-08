import { useEffect, useMemo, useRef, useState } from "react";
import { spec } from "@dno/game-spec";
import { DISCORD } from "../links";
import { useLocale } from "../i18n/locale";
import { applyPath, appPath, docsPath, projectDocsPath, vaultDocsPath, vaultPath } from "../site";
import { useT as useHomeT } from "../home/i18n";
import { PopBoxScene, SHAKES_TO_OPEN } from "../home/popBox";
import { useT } from "./i18n";
import { Icon } from "./Icon";
import { SecureTop } from "./SecureTop";
import { ShieldScene } from "./shieldScene";

const GLYPHS = "0123456789abcdef▓▒░█";
const glyphs = (n: number) => Array.from({ length: n }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join("");
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Text that resolves out of ciphertext, left to right, when it first shows or changes. Screen
 * readers get the plain text from the caller's aria-label.
 */
function useDecrypt(text: string, ms = 1100): string {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (reduced()) return setShown(text);
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const k = Math.min(1, (performance.now() - start) / ms);
      const fixed = Math.floor(text.length * k);
      setShown(text.slice(0, fixed) + [...text.slice(fixed)].map((c) => (c === " " ? " " : glyphs(1))).join(""));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [text, ms]);
  return shown;
}

/** Ciphertext that never settles. */
function Cipher({ length = 10 }: { length?: number }) {
  const [text, setText] = useState(() => glyphs(length));
  useEffect(() => {
    if (reduced()) return;
    const id = setInterval(() => setText(glyphs(length)), 110);
    return () => clearInterval(id);
  }, [length]);
  return <span className="sec-cipher">{text}</span>;
}

function Decrypted({ text, className }: { text: string; className?: string }) {
  const shown = useDecrypt(text, 700);
  return (
    <span className={className} aria-label={text}>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}

/** The box in its shield, with the holder's tag that never resolves. */
function Shield() {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ShieldScene | null>(null);
  const [webgl, setWebgl] = useState(true);
  const labels = useRef({
    holder: t("secure.scene.holder"),
    denied: t("secure.scene.denied"),
  });

  useEffect(() => {
    if (!host.current) return;
    try {
      scene.current = new ShieldScene(host.current, labels.current);
    } catch {
      setWebgl(false);
    }
    return () => {
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  return (
    <figure className="sec-shield">
      {webgl && (
        <div
          ref={host}
          className="stage sec-shield-stage"
          role="button"
          tabIndex={0}
          aria-label={t("secure.scene.aria")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              scene.current?.probe();
            }
          }}
        />
      )}
      <figcaption>
        <span>{t("secure.scene.caption")}</span>
        <span className="sec-hint">{t("secure.scene.hint")}</span>
      </figcaption>
    </figure>
  );
}

type Row = {
  block: number;
  event: "seal" | "transfer" | "list" | "sale";
  box: string;
  mine: boolean;
};
const ROWS: Row[] = [
  { block: 7_412_908, event: "seal", box: "#0412", mine: true },
  { block: 7_412_951, event: "transfer", box: "#0388", mine: false },
  { block: 7_413_066, event: "list", box: "#0412", mine: true },
  { block: 7_413_120, event: "sale", box: "#0731", mine: true },
];

/** The same rows twice: as the chain shows them, and as their holder reads them. */
function Ledger() {
  const t = useT();
  const locale = useLocale();
  const [yours, setYours] = useState(false);
  return (
    <section id="ledger" className="sec-section">
      <p className="sec-kicker">{t("secure.ledger.kicker")}</p>
      <h2>{t("secure.ledger.title")}</h2>
      <p className="sec-lede">{t("secure.ledger.lede")}</p>
      <div className="sec-ledger">
        <div className="sec-toggle" role="group">
          <button type="button" aria-pressed={!yours} onClick={() => setYours(false)}>
            <Icon name="eye" />
            {t("secure.ledger.public")}
          </button>
          <button type="button" aria-pressed={yours} onClick={() => setYours(true)}>
            <Icon name="key" />
            {t("secure.ledger.yours")}
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>{t("secure.ledger.block")}</th>
              <th>{t("secure.ledger.event")}</th>
              <th>{t("secure.ledger.box")}</th>
              <th>{t("secure.ledger.holder")}</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.block}>
                <td className="sec-mono">{r.block.toLocaleString(locale)}</td>
                <td>{t(`secure.ledger.ev.${r.event}`)}</td>
                <td className="sec-mono">{r.box}</td>
                <td>{yours && r.mine ? <Decrypted className="sec-you" text={t("secure.ledger.you")} /> : <Cipher />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="sec-note">
          <Icon name="lock" />
          {t("secure.ledger.note")}
        </p>
      </div>
    </section>
  );
}

/** The game, small and at the end: the same encryption, for fun, with its box to shake. */
function GameCorner() {
  const t = useT();
  const h = useHomeT();
  const locale = useLocale();
  const supply = spec.collection.maxSupply.toLocaleString(locale);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<PopBoxScene | null>(null);
  const [shakes, setShakes] = useState(0);
  const [out, setOut] = useState(false);
  const [webgl, setWebgl] = useState(true);
  const lines = useRef<string[]>([]);
  lines.current = [h("home.toy.say1"), h("home.toy.say2"), h("home.toy.opening")];

  useEffect(() => {
    if (!host.current) return;
    let made: PopBoxScene;
    try {
      made = new PopBoxScene(host.current);
    } catch {
      setWebgl(false);
      return;
    }
    made.onShake = (n) => {
      setShakes(n);
      made.say(lines.current[Math.min(n, lines.current.length) - 1] ?? null, n >= SHAKES_TO_OPEN ? 2.4 : 1.4);
    };
    made.onOpened = () => setOut(true);
    scene.current = made;
    return () => {
      made.dispose();
      scene.current = null;
    };
  }, []);

  const left = SHAKES_TO_OPEN - shakes;
  return (
    <section id="game" className="sec-section">
      <div className="sec-game">
        <div className="sec-game-text">
          <p className="sec-kicker">{t("secure.game.kicker")}</p>
          <h2>{h("home.game.title")}</h2>
          <p className="sec-lede">{h("home.game.lede")}</p>
          <p className="sec-meta">{h("home.game.kicker", { supply })}</p>
          <p className="sec-ctas">
            <a className="sec-btn sec-btn-ghost" href={appPath(locale)}>
              {h("home.game.play")}
            </a>
            <a className="sec-link" href={docsPath(locale)}>
              {h("home.game.docs")}&nbsp;→
            </a>
          </p>
        </div>
        {webgl && (
          <div className="sec-game-toy">
            <div
              ref={host}
              className="stage sec-game-stage"
              role="button"
              tabIndex={0}
              aria-label={h("home.toy.aria")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  scene.current?.poke();
                }
              }}
            />
            {out ? (
              <button
                type="button"
                className="sec-link"
                onClick={() => {
                  setOut(false);
                  setShakes(0);
                  scene.current?.next();
                }}
              >
                {h("home.toy.again")}
              </button>
            ) : (
              <p className="sec-hint">{shakes === 0 ? h("home.toy.hint") : left > 0 ? h("home.toy.left", { count: left }) : "…"}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * A proposal for the home page, in a security mood rather than a cartoon one: the vault first
 * (a box in an encryption shield that probes bounce off, a ledger seen by the public and by the
 * holder, why, the protocol, what leaks, what nobody can do), the game small at the end.
 */
export function SecureHome() {
  const t = useT();
  const h = useHomeT();
  const locale = useLocale();
  const title = useDecrypt(t("secure.h1"), 1400);
  // Handles to stream along the band: random, but fixed for the visit.
  const band = useMemo(() => Array.from({ length: 14 }, (_, i) => (i % 3 === 1 ? "euint64" : i % 3 === 2 ? "ebool" : `0x${hex(4)}…${hex(4)}`)).join("  ·  "), []);

  useEffect(() => {
    document.title = t("secure.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("secure.description"));
  }, [t]);

  return (
    <div className="sec" id="top">
      <SecureTop />

      <section className="sec-hero">
        <div className="sec-hero-text">
          <p className="sec-kicker">
            <Icon name="shield" />
            {t("secure.eyebrow")}
          </p>
          <h1 aria-label={t("secure.h1")}>
            <span aria-hidden="true">{title}</span>
          </h1>
          <p className="sec-lede">{t("secure.lede")}</p>
          <p className="sec-ctas">
            <a className="sec-btn" href={vaultPath(locale)}>
              {t("secure.cta.open")}
            </a>
            <a className="sec-btn sec-btn-ghost" href="#protocol">
              {t("secure.cta.protocol")}
            </a>
          </p>
          <dl className="sec-specs">
            {(["1", "2", "3"] as const).map((n) => (
              <div key={n}>
                <dt>{t(`secure.spec.${n}.k`)}</dt>
                <dd>{t(`secure.spec.${n}.v`)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Shield />
      </section>

      <div className="sec-band" aria-hidden="true">
        <div>
          <span>{band}</span>
          <span>{band}</span>
        </div>
      </div>

      <section id="why" className="sec-section">
        <p className="sec-kicker">{t("secure.why.kicker")}</p>
        <h2>{h("home.why.title")}</h2>
        <ul className="sec-cards">
          {(
            [
              ["1", "eyeOff"],
              ["2", "shield"],
              ["3", "lock"],
              ["4", "exit"],
            ] as const
          ).map(([n, icon]) => (
            <li key={n}>
              <Icon name={icon} />
              <h3>{h(`home.why.${n}.title`)}</h3>
              <p>{h(`home.why.${n}.body`)}</p>
            </li>
          ))}
        </ul>
      </section>

      <Ledger />

      <section id="protocol" className="sec-section">
        <p className="sec-kicker">{t("secure.protocol.kicker")}</p>
        <h2>{h("home.steps.title")}</h2>
        <p className="sec-lede">{h("home.steps.lede")}</p>
        <ol className="sec-steps">
          {(["1", "2", "3", "4"] as const).map((n) => (
            <li key={n}>
              <span className="sec-mono">0{n}</span>
              <div>
                <h3>{h(`home.steps.${n}`)}</h3>
                <p>{h(`home.steps.${n}.v`)}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="sec-ctas">
          <a className="sec-btn" href={vaultPath(locale)}>
            {t("secure.cta.open")}
          </a>
          <a className="sec-link" href={vaultDocsPath(locale)}>
            {h("home.steps.docs")}&nbsp;→
          </a>
        </p>
      </section>

      <section id="leaks" className="sec-section">
        <p className="sec-kicker">{t("secure.leaks.kicker")}</p>
        <h2>{h("home.leaks.title")}</h2>
        <div className="sec-leaks">
          <div>
            <h3>
              <Icon name="eye" />
              {h("home.leaks.public")}
            </h3>
            <ul>
              {(["1", "2", "3"] as const).map((n) => (
                <li key={n}>{h(`home.leaks.public${n}`)}</li>
              ))}
            </ul>
          </div>
          <div className="sec-leaks-hidden">
            <h3>
              <Icon name="lock" />
              {h("home.leaks.hidden")}
            </h3>
            <ul>
              {(["1", "2", "3"] as const).map((n) => (
                <li key={n}>{h(`home.leaks.hidden${n}`)}</li>
              ))}
            </ul>
          </div>
        </div>
        <a className="sec-link" href={`${vaultDocsPath(locale)}#leaks`}>
          {h("home.leaks.more")}&nbsp;→
        </a>
      </section>

      <section className="sec-section sec-trust">
        {(["1", "2", "3"] as const).map((n) => (
          <div key={n}>
            <strong>{t(`secure.trust.${n}.k`)}</strong>
            <p>{t(`secure.trust.${n}.v`)}</p>
          </div>
        ))}
      </section>

      <GameCorner />

      <footer className="sec-foot">
        <span>{t("secure.foot")}</span>
        <a href={DISCORD} target="_blank" rel="noreferrer">
          Discord
        </a>
      </footer>
    </div>
  );
}
