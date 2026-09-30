import { useEffect, useRef, useState } from "react";
import { spec } from "@dno/game-spec";
import type { CatSpec } from "@dno/generator";
import { CatParade } from "../docs/CatParade";
import { LangSwitch } from "../i18n/LangSwitch";
import { useLocale } from "../i18n/locale";
import { catNames } from "../i18n/names";
import { useT } from "./i18n";
import { PopBoxScene, SHAKES_TO_OPEN } from "./popBox";

const REPO = "https://github.com/jecombe/do_not_open";
const APP = "/app.html";
const DOCS = "/docs.html";

export function Home() {
  const t = useT();
  const locale = useLocale();
  const supply = spec.collection.maxSupply.toLocaleString(locale);

  useEffect(() => {
    document.title = t("home.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("home.description", { supply }));
  }, [t, supply]);

  return (
    <div className="home">
      <header className="home-top">
        <a className="home-stamp" href="/">
          Do not open
        </a>
        <nav aria-label={t("home.nav")}>
          <a href="#cats">{t("home.nav.cats")}</a>
          <a href="#how">{t("home.nav.how")}</a>
          <a href={DOCS}>{t("home.nav.docs")}</a>
          <LangSwitch label={t("home.nav")} />
          <a className="btn btn-small" href={APP}>
            {t("home.nav.play")}
          </a>
        </nav>
      </header>

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
        <Toy />
      </section>

      <div className="ticker" aria-hidden="true">
        <div>
          <span>{t("home.ticker")}</span>
          <span>{t("home.ticker")}</span>
        </div>
      </div>

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
          <a className="btn btn-paper" href={`${DOCS}#privacy`}>
            {t("home.secret.link")} →
          </a>
        </div>
      </section>

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
        <a href={REPO}>{t("home.foot.source")}</a>
      </footer>
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
