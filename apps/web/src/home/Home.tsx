import { DEFAULT_ALLOW_LIST_PLACES } from "@dno/chain-adapter/standings";
import { useEffect, useRef, useState } from "react";
import { spec } from "@dno/game-spec";
import type { CatSpec } from "@dno/generator";
import { DISCORD } from "../links";
import { useLocale } from "../i18n/locale";
import { applyPath, appPath, docsPath, vaultDocsPath, vaultPath } from "../site";
import { catNames } from "../i18n/names";
import { ClerkBell } from "./ClerkBell";
import { Departures } from "./Departures";
import { FloatApply } from "./floatApply";
import { HomeTop } from "./HomeTop";
import { useT } from "./i18n";
import { PopBoxScene, SHAKES_TO_OPEN } from "./popBox";
import { boxComplaint, pageSound, setMuted, startMusicOnFirstGesture, useSoundSettings } from "./sound";
import { VaultBoxScene, type VaultStep } from "./vaultBox";

const VAULT_STEPS: readonly VaultStep[] = ["deposit", "seal", "encrypt", "shuffle", "list"];
const WHY = ["1", "2", "3", "4"] as const;
const STEPS = ["1", "2", "3", "4"] as const;
const PUBLIC = ["1", "2", "3"] as const;

const INK = "#1c1814";
const stroke = { stroke: INK, strokeWidth: 4, strokeLinejoin: "round", strokeLinecap: "round" } as const;

/** The way to the boarding page, floating weightless in the hero with croquettes in orbit. */
function FloatingApply() {
  const t = useT();
  const locale = useLocale();
  const host = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!host.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const float = new FloatApply(host.current);
    return () => float.dispose();
  }, []);

  return (
    <span ref={host} className="apply-float">
      <span className="apply-shadow" aria-hidden="true" />
      <span className="apply-body">
        <a className="btn btn-x btn-apply" href={applyPath(locale)}>
          <svg className="x-logo" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
          </svg>
          {t("home.hero.apply")}
        </a>
        {[0, 1, 2].map((i) => (
          <svg key={i} className="apply-kibble" viewBox="-12 -12 24 24" aria-hidden="true">
            <path d="M-7 -4 Q0 -10 7 -4 Q10 2 4 6 Q0 8 -4 6 Q-10 2 -7 -4 Z" fill="#a0612c" {...stroke} strokeWidth={3} />
          </svg>
        ))}
      </span>
    </span>
  );
}

/**
 * The home page is the sealed vault's: what it does (the scene, why, how, what shows), then the
 * game, the same encryption for fun, in one section with its toy box. The game's own corners (the
 * studio, the flea market, the manual) are on game., the details of the vault in its docs.
 */
export function Home() {
  const t = useT();
  const locale = useLocale();
  const supply = spec.collection.maxSupply.toLocaleString(locale);
  const VAULT = vaultPath(locale);
  const VAULT_DOCS = vaultDocsPath(locale);
  const APP = appPath(locale);

  useEffect(() => {
    document.title = t("home.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("home.description", { supply }));
  }, [t, supply]);
  useEffect(() => startMusicOnFirstGesture(), []);

  return (
    <div className="home">
      <HomeTop />

      <section className="home-hero">
        <div className="hero-text">
          <p className="kicker">{t("home.vault.kicker")}</p>
          <h1>{t("home.vault.title")}</h1>
          <p className="hero-lede">{t("home.vault.lede")}</p>
          <p className="hero-ctas">
            <a className="btn" href={VAULT}>
              {t("home.vault.open")}
            </a>
            <a className="btn btn-paper" href="#how">
              {t("home.vault.how")}
            </a>
          </p>
          <a className="hero-allow" href={VAULT}>
            {t("home.vault.testnet")}&nbsp;→
          </a>
        </div>
        <Departures />
        <VaultToy />
      </section>

      <div className="ticker" aria-hidden="true">
        <div>
          <span>{t("home.ticker")}</span>
          <span>{t("home.ticker")}</span>
        </div>
      </div>

      <section id="why" className="home-section">
        <h2>{t("home.why.title")}</h2>
        <ul className="why-cards">
          {WHY.map((n) => (
            <li key={n} className="why-card">
              <h3>{t(`home.why.${n}.title`)}</h3>
              <p>{t(`home.why.${n}.body`)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="how" className="home-section">
        <h2>{t("home.steps.title")}</h2>
        <p className="section-lede">{t("home.steps.lede")}</p>
        <ol className="panels">
          {STEPS.map((n, i) => (
            <li key={n} className="panel">
              <span className="panel-n">{i + 1}</span>
              <h3>{t(`home.steps.${n}`)}</h3>
              <p>{t(`home.steps.${n}.v`)}</p>
            </li>
          ))}
        </ol>
        <p className="hero-ctas home-more">
          <a className="btn" href={VAULT}>
            {t("home.vault.open")}
          </a>
          <a className="btn btn-paper" href={VAULT_DOCS}>
            {t("home.steps.docs")}
          </a>
        </p>
      </section>

      <section id="leaks" className="home-section leaks">
        <h2>{t("home.leaks.title")}</h2>
        <div className="leaks-cols">
          <div className="leaks-card">
            <h3>{t("home.leaks.public")}</h3>
            <ul>
              {PUBLIC.map((n) => (
                <li key={n}>{t(`home.leaks.public${n}`)}</li>
              ))}
            </ul>
          </div>
          <div className="leaks-card leaks-hidden">
            <h3>{t("home.leaks.hidden")}</h3>
            <ul>
              {PUBLIC.map((n) => (
                <li key={n}>{t(`home.leaks.hidden${n}`)}</li>
              ))}
            </ul>
          </div>
        </div>
        <a className="hero-allow" href={`${VAULT_DOCS}#leaks`}>
          {t("home.leaks.more")}&nbsp;→
        </a>
      </section>

      <section id="game" className="home-section game-corner">
        <div className="game-card">
          <p className="kicker">{t("home.game.kicker", { supply })}</p>
          <h2>{t("home.game.title")}</h2>
          <p className="section-lede">{t("home.game.lede")}</p>
          <p className="hero-ctas">
            <a className="btn" href={APP}>
              {t("home.game.play")}
            </a>
            <a className="btn btn-paper" href={docsPath(locale)}>
              {t("home.game.docs")}
            </a>
            <FloatingApply />
          </p>
          {/* Until mainnet: the testnet's best players get a place there. Goes with the testnet. */}
          <a className="hero-allow" href={applyPath(locale)}>
            {t("home.game.allowList", { places: (DEFAULT_ALLOW_LIST_PLACES ?? 0).toLocaleString(locale) })}&nbsp;→
          </a>
        </div>
        <Toy />
      </section>

      <footer className="home-foot">
        <span>{t("home.foot")}</span>
        <a href={DISCORD} target="_blank" rel="noreferrer">
          {t("home.foot.discord")}
        </a>
      </footer>

      <ClerkBell />
    </div>
  );
}

/** The vault at work, on a loop, with a line under it for each step. A click starts it again. */
function VaultToy() {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<VaultBoxScene | null>(null);
  const [step, setStep] = useState<VaultStep>("deposit");
  const [webgl, setWebgl] = useState(true);
  const labels = { holder: t("home.vault.scene.holder"), price: t("home.vault.scene.price", { price: "0.42" }), seller: t("home.vault.scene.seller") };
  const first = useRef(labels);

  useEffect(() => {
    if (!host.current) return;
    let made: VaultBoxScene;
    try {
      made = new VaultBoxScene(host.current, first.current);
    } catch {
      setWebgl(false);
      return;
    }
    made.onStep = setStep;
    scene.current = made;
    return () => {
      made.dispose();
      scene.current = null;
    };
  }, []);

  if (!webgl) return null;
  return (
    <div className="toy vault-toy">
      <div
        ref={host}
        className="stage vault-toy-stage"
        role="button"
        tabIndex={0}
        aria-label={t("home.vault.scene.aria")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            scene.current?.restart();
          }
        }}
      />
      <p className="vault-toy-caption" aria-live="polite">
        {t(`home.vault.step.${step}`)}
      </p>
      <ol className="vault-toy-steps" aria-hidden="true">
        {VAULT_STEPS.map((s) => (
          <li key={s} aria-current={s === step ? "step" : undefined} />
        ))}
      </ol>
    </div>
  );
}

/** The box in the hero: shake it twice, the third time a random cat jumps out. */
function Toy() {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<PopBoxScene | null>(null);
  const [shakes, setShakes] = useState(0);
  const [cat, setCat] = useState<CatSpec | null>(null);
  const [webgl, setWebgl] = useState(true);
  // Follows the menu's speaker too.
  const { muted } = useSoundSettings();
  const lines = useRef<string[]>([]);
  lines.current = [t("home.toy.say1"), t("home.toy.say2"), t("home.toy.opening")];

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
    made.onOpened = setCat;
    scene.current = made;
    return () => {
      made.dispose();
      scene.current = null;
    };
  }, []);

  const again = () => {
    setCat(null);
    setShakes(0);
    scene.current?.next();
  };

  if (!webgl) return null;
  const names = cat && catNames(cat);
  const left = SHAKES_TO_OPEN - shakes;

  return (
    <div className="toy">
      <div ref={host} className="stage toy-stage" role="button" tabIndex={0} aria-label={t("home.toy.aria")} onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          scene.current?.poke();
        }
      }} />
      <div className="toy-caption" aria-live="polite">
        {names ? (
          <>
            <p className="toy-out">{t("home.toy.out", { state: names.state.toLowerCase(), breed: names.breed.toLowerCase(), mood: names.mood.toLowerCase() })}</p>
            <button type="button" className="btn btn-small" onClick={again}>
              {t("home.toy.again")}
            </button>
          </>
        ) : (
          <p className="toy-hint">{shakes === 0 ? t("home.toy.hint") : left > 0 ? t("home.toy.left", { count: left }) : "…"}</p>
        )}
        <p className="toy-note">{t("home.toy.note")}</p>
        <button
          type="button"
          className="toy-sound"
          aria-pressed={!muted}
          onClick={() => {
            setMuted(!muted);
            if (muted) {
              pageSound.resume();
              boxComplaint();
            }
          }}
        >
          {muted ? t("home.toy.soundOff") : t("home.toy.soundOn")}
        </button>
      </div>
    </div>
  );
}
