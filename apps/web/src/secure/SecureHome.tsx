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
import { Warden } from "./Warden";
import { LockCursor } from "./LockCursor";
import { CipherField } from "./cipherField";
import { STEPS, VaultStoryScene, type StoryLabels } from "./vaultStory";
import { glyphs, hex, reduced, useDecrypt } from "./cipher";

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

/** The vault's four steps, played on a loop by a 3D scene, with the step under way spelled out below. */
function Story() {
  const t = useT();
  const h = useHomeT();
  const host = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const scene = useRef<VaultStoryScene | null>(null);
  const [webgl, setWebgl] = useState(true);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const labels = useRef<StoryLabels>({
    public: t("secure.story.public"),
    publicTokens: t("secure.story.publicTokens"),
    toPocket: t("secure.story.toPocket"),
    payBox: t("secure.story.payBox"),
    paidIn: t("secure.story.paidIn"),
    saleCash: t("secure.story.saleCash"),
    hiddenBalance: t("secure.story.hiddenBalance"),
    holder: t("secure.story.holder"),
    denied: t("secure.story.denied"),
    signature: t("secure.story.signature"),
    key: t("secure.story.key"),
    keyOk: t("secure.story.keyOk"),
    seaport: t("secure.story.seaport"),
    offer: t("secure.story.offer"),
    private: t("secure.story.private"),
    gift: t("secure.story.gift"),
    delegate: t("secure.story.delegate"),
    fresh: t("secure.story.fresh"),
  });

  useEffect(() => {
    if (!host.current) return;
    let made: VaultStoryScene;
    try {
      made = new VaultStoryScene(host.current, labels.current);
    } catch {
      setWebgl(false);
      return;
    }
    made.onStep = setStep;
    // Straight to the element: a state update every frame would re-render the page.
    made.onProgress = (p) => bar.current?.style.setProperty("--p", p.toFixed(3));
    scene.current = made;
    return () => {
      made.dispose();
      scene.current = null;
    };
  }, []);

  const n = String(step + 1) as "1" | "2" | "3" | "4";
  return (
    <figure className="sec-shield sec-story">
      {webgl && (
        <div
          ref={host}
          className="stage sec-shield-stage"
          role="button"
          tabIndex={0}
          aria-label={t("secure.story.aria")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              scene.current?.go((step + 1) % STEPS);
            }
          }}
        />
      )}
      {webgl && (
        <button
          type="button"
          className="sec-story-pause"
          aria-label={paused ? t("secure.story.play") : t("secure.story.pause")}
          onClick={() => {
            scene.current?.pause(!paused);
            setPaused(!paused);
          }}
        >
          {paused ? "▶" : "❚❚"}
        </button>
      )}
      <ol className="sec-story-steps" aria-label={t("secure.story.steps")}>
        {(["1", "2", "3", "4"] as const).map((k, i) => (
          <li key={k}>
            <button type="button" aria-current={i === step ? "step" : undefined} onClick={() => scene.current?.go(i)}>
              <span className="sec-mono">0{k}</span>
              {h(`home.steps.${k}`)}
              {i === step && <span ref={bar} className="sec-story-bar" aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ol>
      <figcaption aria-live="polite">{h(`home.steps.${n}.v`)}</figcaption>
    </figure>
  );
}

type Row = {
  block: number;
  event: "seal" | "transfer" | "list" | "sale" | "pocket";
  box: string;
  mine: boolean;
};
const ROWS: Row[] = [
  { block: 7_412_908, event: "seal", box: "#0412", mine: true },
  { block: 7_412_951, event: "transfer", box: "#0388", mine: false },
  { block: 7_413_066, event: "list", box: "#0412", mine: true },
  { block: 7_413_120, event: "sale", box: "#0731", mine: true },
  // A pocket's payment names a few pockets: which one paid, and how much, stays encrypted.
  { block: 7_413_207, event: "pocket", box: "P-04 · P-17 · P-22", mine: true },
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
          <p className="sec-experimental">{t("secure.game.experimental")}</p>
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

/** Cards that catch the pointer's light, and sections that come up as they reach the screen. */
const GLOWING = ".sec-cards li, .sec-steps li, .sec-leaks > div, .sec-trust > div, .sec-ledger, .sec-specs";

/**
 * The page's ambience: the cipher field behind everything, the pointer's light on the cards,
 * and the sections below the fold rising into view.
 */
function useAmbience(root: React.RefObject<HTMLDivElement | null>, field: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const page = root.current;
    if (!page) return;
    let cipher: CipherField | null = null;
    try {
      if (field.current) cipher = new CipherField(field.current);
    } catch {
      cipher = null;
    }

    for (const el of page.querySelectorAll(GLOWING)) el.classList.add("sec-glow");
    const light = (e: PointerEvent) => {
      const card = e.target instanceof Element ? e.target.closest<HTMLElement>(".sec-glow") : null;
      if (!card) return;
      const box = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - box.left}px`);
      card.style.setProperty("--my", `${e.clientY - box.top}px`);
    };
    page.addEventListener("pointermove", light, { passive: true });

    // Only what starts below the fold: what is already in view stays put.
    const below = [...page.querySelectorAll<HTMLElement>(".sec-section")].filter((el) => el.getBoundingClientRect().top > window.innerHeight);
    const watch = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          watch.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" }
    );
    for (const el of below) {
      el.classList.add("sec-reveal");
      watch.observe(el);
    }

    return () => {
      cipher?.dispose();
      page.removeEventListener("pointermove", light);
      watch.disconnect();
    };
  }, [root, field]);
}

/**
 * A proposal for the home page, in a security mood rather than a cartoon one: the vault first
 * (its four steps played by a sealed box in an encryption shield, a ledger seen by the public and by the
 * holder, why, the protocol, what leaks, what nobody can do), the game small at the end.
 */
export function SecureHome() {
  const t = useT();
  const h = useHomeT();
  const locale = useLocale();
  const title = useDecrypt(t("secure.h1"), 1400);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLCanvasElement>(null);
  useAmbience(root, field);
  // Handles to stream along the band: random, but fixed for the visit.
  const band = useMemo(() => Array.from({ length: 14 }, (_, i) => (i % 3 === 1 ? "euint64" : i % 3 === 2 ? "ebool" : `0x${hex(4)}…${hex(4)}`)).join("  ·  "), []);

  useEffect(() => {
    document.title = t("secure.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("secure.description"));
  }, [t]);

  return (
    <div className="sec" id="top" ref={root}>
      <canvas ref={field} className="sec-field" aria-hidden="true" />
      <LockCursor />
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
        <Story />
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
              ["5", "coins"],
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
              {(["1", "2", "3", "4"] as const).map((n) => (
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
              {(["1", "2", "3", "4"] as const).map((n) => (
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
      <Warden />
    </div>
  );
}
