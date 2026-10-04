import { useEffect, useId, useRef, useState } from "react";
import { spec } from "@dno/game-spec";
import type { CatSpec } from "@dno/generator";
import { CatParade } from "../docs/CatParade";
import { LangSwitch } from "../i18n/LangSwitch";
import { DISCORD, REPO } from "../links";
import { useLocale } from "../i18n/locale";
import { appPath, docsPath, homePath } from "../site";
import { buildName, catNames } from "../i18n/names";
import { ClerkBell } from "./ClerkBell";
import { Departures } from "./Departures";
import { useT } from "./i18n";
import { PopBoxScene, SHAKES_TO_OPEN } from "./popBox";
import { Shipped } from "./Shipped";
import { boxComplaint, pageSound, setMuted } from "./sound";

/**
 * The stamp, the site's links and languages, and the way into the game. On a phone the links
 * and languages fold into a menu, so the stamp, "Play" and the menu button share one line.
 */
function HomeTop() {
  const t = useT();
  const locale = useLocale();
  const APP = appPath(locale);
  const DOCS = docsPath(locale);
  const [open, setOpen] = useState(false);
  const navId = useId();
  const root = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A link followed from the menu folds it away.
  const close = () => setOpen(false);
  return (
    <header className="home-top" ref={root}>
      <a className="home-stamp" href={homePath(locale)}>
        Do not open
      </a>
      <nav id={navId} className={open ? "is-open" : undefined} aria-label={t("home.nav")}>
        <a href="#cats" onClick={close}>
          {t("home.nav.cats")}
        </a>
        <a href="#how" onClick={close}>
          {t("home.nav.how")}
        </a>
        <a href="#croquettes" onClick={close}>
          {t("home.nav.croq")}
        </a>
        <a href={DOCS}>{t("home.nav.docs")}</a>
        <LangSwitch label={t("home.nav")} />
      </nav>
      <div className="home-top-actions">
        <a className="btn btn-small" href={APP}>
          {t("home.nav.play")}
        </a>
        <button type="button" ref={toggle} className="btn btn-small btn-paper home-menu" aria-expanded={open} aria-controls={navId} onClick={() => setOpen((o) => !o)}>
          <span className="home-menu-bars" aria-hidden="true" />
          <span className="home-menu-label">{t("home.nav.menu")}</span>
        </button>
      </div>
    </header>
  );
}

export function Home() {
  const t = useT();
  const locale = useLocale();
  const supply = spec.collection.maxSupply.toLocaleString(locale);
  const APP = appPath(locale);
  const DOCS = docsPath(locale);

  useEffect(() => {
    document.title = t("home.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("home.description", { supply }));
  }, [t, supply]);

  return (
    <div className="home">
      <HomeTop />

      <section className="home-hero">
        <div className="hero-text">
          <p className="kicker">{t("home.hero.kicker", { supply })}</p>
          <h1>{t("home.hero.title")}</h1>
          <p className="hero-lede">{t("home.hero.lede")}</p>
          <p className="hero-ctas">
            <a className="btn" href={APP}>
              {t("home.hero.play")}
            </a>
            <a className="btn btn-paper" href={`${DOCS}#box`}>
              {t("home.hero.docs")}
            </a>
          </p>
        </div>
        <Departures />
        <Toy />
      </section>

      <div className="ticker" aria-hidden="true">
        <div>
          <span>{t("home.ticker")}</span>
          <span>{t("home.ticker")}</span>
        </div>
      </div>

      <Shipped />

      <section id="how" className="home-section">
        <h2>{t("home.how.title")}</h2>
        <p className="section-lede">{t("home.how.lede")}</p>
        <ol className="panels">
          {STEPS.map(({ key, doodle, more }, i) => (
            <li key={key} className="panel">
              <span className="panel-n">{i + 1}</span>
              {doodle}
              <h3>{t(`home.how.${key}`)}</h3>
              <p>{t(`home.how.${key}.v`)}</p>
              <a href={`${DOCS}#${more}`}>{t("home.how.more")} →</a>
            </li>
          ))}
        </ol>
      </section>

      <section className="home-section secret">
        <div className="secret-doodle" aria-hidden="true">
          <span className="speech">{t("home.secret.bubble")}</span>
          <VetDoodle />
        </div>
        <div>
          <h2>{t("home.secret.title")}</h2>
          <p>{t("home.secret.p1")}</p>
          <p>{t("home.secret.p2")}</p>
          <p>{t("home.secret.p3")}</p>
          <a className="btn btn-paper" href={`${DOCS}#privacy`}>
            {t("home.secret.link")} →
          </a>
        </div>
      </section>

      <Croquettes />

      <section id="cats" className="home-section">
        <h2>{t("home.cats.title")}</h2>
        <p className="section-lede">{t("home.cats.lede")}</p>
        <div className="parade-frame">
          <CatParade />
        </div>
      </section>

      <section className="home-section home-end">
        <h2>{t("home.end.title")}</h2>
        <p className="section-lede">{t("home.end.lede")}</p>
        <p className="hero-ctas">
          <a className="btn" href={APP}>
            {t("home.end.play")}
          </a>
          <a className="btn btn-paper" href={DOCS}>
            {t("home.end.docs")}
          </a>
        </p>
      </section>

      <footer className="home-foot">
        <span>{t("home.foot")}</span>
        <a href={DISCORD} target="_blank" rel="noreferrer">
          {t("home.foot.discord")}
        </a>
        <a href={REPO}>{t("home.foot.source")}</a>
      </footer>

      <ClerkBell />
    </div>
  );
}

const { weight: WEIGHT, meal: MEAL } = spec.economy;
const HEAVIEST = WEIGHT.sick.minWeight + WEIGHT.sick.weightSpread;
/** What the scales can say once a box is opened. The gauge is a square root, or chubby would not show. */
const BUILDS = WEIGHT.builds.slice(2).map((b) => ({ key: b.key, from: b.minWeight, fill: Math.round(Math.sqrt(b.minWeight / HEAVIEST) * 100) }));

/** The croquette economy in one panel: hidden meals, the scales at the end, the market. */
function Croquettes() {
  const t = useT();
  const locale = useLocale();
  const { token, welcomeBag } = spec.economy;
  const DOCS = docsPath(locale);

  return (
    <section id="croquettes" className="home-section croq">
      <div>
        <h2>{t("home.croq.title")}</h2>
        <p className="section-lede">{t("home.croq.p1", { total: token.totalSupply.toLocaleString(locale) })}</p>
        <div className="croq-board">
          <div className="croq-doodle" aria-hidden="true">
            <span className="speech">{t("home.croq.bubble")}</span>
            <KibbleDoodle />
          </div>
          <div className="croq-card">
            <h3>{t("home.croq.outcomes")}</h3>
            <ul className="outcomes">
              {BUILDS.map(({ key, from, fill }) => (
                <li key={key} className={`outcome outcome-${key}`}>
                  <span className="outcome-state">{buildName(key)}</span>
                  <span className="outcome-bar outcome-scale" aria-hidden="true">
                    <i style={{ width: `${fill}%` }} />
                  </span>
                  <span className="outcome-text">{t("home.croq.from", { n: from.toLocaleString(locale), days: Math.ceil(from / MEAL.maxEatenPerDay) })}</span>
                </li>
              ))}
              <li className="outcome outcome-sick">
                <span className="outcome-state">{t("home.croq.sick")}</span>
                <span className="outcome-bar outcome-scale" aria-hidden="true">
                  <i style={{ width: "100%" }} />
                </span>
                <span className="outcome-text">{t("home.croq.sickText", { min: WEIGHT.sick.minWeight.toLocaleString(locale), max: HEAVIEST.toLocaleString(locale) })}</span>
              </li>
            </ul>
            <p>{t("home.croq.p2", { cap: MEAL.maxEatenPerDay.toLocaleString(locale), meals: MEAL.mealsPerDay, treasury: MEAL.treasuryBps / 100, reserve: (10_000 - MEAL.treasuryBps - MEAL.burnBps) / 100, burn: MEAL.burnBps / 100 })}</p>
            <p>{t("home.croq.p3", { bag: welcomeBag.amount })}</p>
            <a className="btn btn-paper" href={`${DOCS}#croquettes`}>
              {t("home.croq.link")} →
            </a>
          </div>
        </div>
      </div>
    </section>
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
  const [muted, setMutedState] = useState(pageSound.muted);
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
            setMutedState(!muted);
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

// ------------------------------------------------------------------ doodles

const INK = "#1c1814";
const stroke = { stroke: INK, strokeWidth: 4, strokeLinejoin: "round", strokeLinecap: "round" } as const;

function BoxShape({ lid = true }: { lid?: boolean }) {
  return (
    <>
      <path d="M22 44 L60 30 L98 44 L98 92 L60 106 L22 92 Z" fill="#b8895a" {...stroke} />
      <path d="M60 58 L60 106 M22 44 L60 58 L98 44" fill="none" {...stroke} />
      {lid && <path d="M22 44 L60 30 L98 44 L60 58 Z" fill="#cda070" {...stroke} />}
      {lid && <path d="M41 37 L79 51" stroke="#d9c28a" strokeWidth="9" />}
      <path d="M33 70 L50 76 L50 88 L33 82 Z" fill="#e9dfc8" stroke={INK} strokeWidth="2.5" />
    </>
  );
}

const STEPS = [
  {
    key: "s1",
    more: "box",
    doodle: (
      <svg className="doodle" viewBox="0 0 120 120" aria-hidden="true">
        <BoxShape />
        <text x="78" y="28" fontSize="30" fontWeight="700" fill="#c2261d" transform="rotate(14 78 28)">?</text>
      </svg>
    ),
  },
  {
    key: "s2",
    more: "mechanics",
    doodle: (
      <svg className="doodle wobble" viewBox="0 0 120 120" aria-hidden="true">
        <g transform="rotate(-10 60 70)">
          <BoxShape />
        </g>
        <path d="M8 50 q6 8 0 16 M14 40 q8 12 0 26 M108 58 q6 8 0 16 M114 48 q8 12 0 26" fill="none" {...stroke} strokeWidth={3} />
      </svg>
    ),
  },
  {
    key: "s3",
    more: "flows",
    doodle: (
      <svg className="doodle" viewBox="0 0 120 120" aria-hidden="true">
        <path d="M40 46 L46 22 L56 40 M64 40 L74 22 L80 46" fill="#e8893a" {...stroke} />
        <ellipse cx="60" cy="50" rx="24" ry="16" fill="#e8893a" {...stroke} />
        <circle cx="52" cy="48" r="4" fill={INK} />
        <circle cx="68" cy="48" r="4" fill={INK} />
        <path d="M22 50 L60 64 L98 50 L98 96 L60 110 L22 96 Z" fill="#b8895a" {...stroke} />
        <path d="M22 50 L6 36 M98 50 L114 36" {...stroke} />
        <path d="M60 64 L60 110" {...stroke} />
        <path d="M14 18 l4 6 M104 12 l-3 7 M60 6 l0 8" {...stroke} stroke="#c2261d" />
      </svg>
    ),
  },
  {
    key: "s4",
    more: "mechanics",
    doodle: (
      <svg className="doodle" viewBox="0 0 120 120" aria-hidden="true">
        <g transform="translate(-22 16) scale(0.62)">
          <BoxShape />
        </g>
        <g transform="translate(52 16) scale(0.62)">
          <BoxShape />
        </g>
        <path d="M62 30 L54 50 L66 50 L56 74" fill="none" {...stroke} stroke="#ffb454" strokeWidth={6} />
        <path d="M62 30 L54 50 L66 50 L56 74" fill="none" {...stroke} strokeWidth={2} />
        <path d="M30 104 q30 12 60 0" fill="none" {...stroke} strokeDasharray="2 8" />
      </svg>
    ),
  },
] as const;

/** Croquettes raining into a sealed box, and a padlock on what piles up inside. */
function KibbleDoodle() {
  const kibble = [
    [44, 30, 20],
    [70, 20, -30],
    [92, 36, 40],
    [58, 46, 10],
    [80, 54, -15],
  ] as const;
  return (
    <svg className="doodle big kibble" viewBox="0 0 160 160" aria-hidden="true">
      <g transform="translate(20 44)">
        <BoxShape />
      </g>
      {kibble.map(([x, y, r], i) => (
        <g key={i} transform={`translate(${x} ${y}) rotate(${r})`}>
          <path d="M-7 -4 Q0 -10 7 -4 Q10 2 4 6 Q0 8 -4 6 Q-10 2 -7 -4 Z" fill="#a0612c" {...stroke} strokeWidth={3} />
        </g>
      ))}
      <g transform="translate(116 104)">
        <path d="M-9 -2 L-9 -10 Q0 -22 9 -10 L9 -2" fill="none" {...stroke} />
        <rect x="-14" y="-3" width="28" height="22" rx="4" fill="#ffd66b" {...stroke} />
        <text x="0" y="14" fontSize="15" fontWeight="700" textAnchor="middle" fill={INK}>?</text>
      </g>
    </svg>
  );
}

function VetDoodle() {
  return (
    <svg className="doodle big" viewBox="0 0 160 150" aria-hidden="true">
      <g transform="translate(20 30)">
        <BoxShape />
      </g>
      {/* X-ray specs peering at the box */}
      <circle cx="60" cy="26" r="17" fill="#7de3d0" {...stroke} />
      <circle cx="100" cy="26" r="17" fill="#7de3d0" {...stroke} />
      <path d="M77 26 L83 26 M43 22 L28 16 M117 22 L132 16" {...stroke} />
      <circle cx="62" cy="28" r="5" fill={INK} />
      <circle cx="102" cy="28" r="5" fill={INK} />
      <path d="M52 8 l4 6 M108 6 l-4 7" {...stroke} strokeWidth={3} />
    </svg>
  );
}
