import { useEffect, useRef, useState } from "react";
import { MockAdapter, type CollectionInfo } from "@dno/chain-adapter";
import { useLocale } from "../i18n/locale";
import { chainMode } from "../chain/mode";
import { useT } from "./i18n";
import { apiUrl } from "../apiUrl";

/**
 * How many box numbers exist, empty ones included, and what is known about how many hold a
 * cat: only the last sale milestone announced. Everything past it is fog, on purpose.
 */

type Shelf = Pick<CollectionInfo, "tokenCount" | "sale" | "maxPerTx">;

const REFRESH_MS = 60_000;
/** How many of the latest boxes ride the belt. */
const BELT = 8;
const WHISPERS = ["home.shipped.w1", "home.shipped.w2", "home.shipped.w3", "home.shipped.w4", "home.shipped.w5"] as const;

const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The live collection: the API on Sepolia, the in-memory game in the demo. Null when neither answers. */
function useShelf(): Shelf | null {
  const [shelf, setShelf] = useState<Shelf | null>(null);
  useEffect(() => {
    let live = true;
    const { mode } = chainMode();
    const api = apiUrl();
    const read = async (): Promise<Shelf | null> => {
      if (mode === "mock") return new MockAdapter().collection();
      if (!api) return null;
      const res = await fetch(`${api}/v1/collection`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      return ((await res.json()) as { data: Shelf }).data;
    };
    const tick = () =>
      read().then(
        (s) => live && s && setShelf(s),
        () => undefined,
      );
    void tick();
    const timer = mode === "mock" ? null : setInterval(tick, REFRESH_MS);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, []);
  return shelf;
}

/** True once the element has come into view. */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setSeen(true), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** A mechanical counter: each digit rolls up from 0 once the counter is in view. */
function Odometer({ value, label }: { value: number; label: string }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const digits = String(value).split("").map(Number);
  return (
    <div className="odometer" ref={ref} role="img" aria-label={label}>
      {digits.map((d, i) => (
        <span key={`${digits.length}-${i}`} className="odo-cell" aria-hidden="true">
          <span className="odo-strip" style={{ transform: `translateY(-${seen ? d : 0}0%)`, transitionDelay: `${(digits.length - i) * 0.12}s` }}>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <span key={n}>{n}</span>
            ))}
          </span>
        </span>
      ))}
    </div>
  );
}

/** A cardboard box on the belt, its serial stamped on, and maybe something to say. */
function BeltBox({ id, whisper }: { id: number; whisper: string | null }) {
  return (
    <li className={whisper ? "belt-box is-talking" : "belt-box"}>
      {whisper && <span className="belt-whisper">{whisper}</span>}
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <path d="M22 44 L60 30 L98 44 L98 92 L60 106 L22 92 Z" fill="#b8895a" stroke="#1c1814" strokeWidth={4} strokeLinejoin="round" />
        <path d="M60 58 L60 106 M22 44 L60 58 L98 44" fill="none" stroke="#1c1814" strokeWidth={4} strokeLinejoin="round" />
        <path d="M22 44 L60 30 L98 44 L60 58 Z" fill="#cda070" stroke="#1c1814" strokeWidth={4} strokeLinejoin="round" />
        <path d="M41 37 L79 51" stroke="#d9c28a" strokeWidth={9} />
        <text x="79" y="86" fontSize="30" fontWeight="700" fill="#c2261d" textAnchor="middle" transform="rotate(-8 79 86)">
          ?
        </text>
      </svg>
      <span className="belt-serial">#{String(id).padStart(4, "0")}</span>
    </li>
  );
}

export function Shipped() {
  const t = useT();
  const locale = useLocale();
  const shelf = useShelf();
  const [talking, setTalking] = useState<{ slot: number; line: number } | null>(null);

  // Every few seconds one box on the belt mutters something. Chosen at random: it gives nothing away.
  useEffect(() => {
    if (!shelf || calm()) return;
    const timer = setInterval(() => {
      // Any box of the belt, both rounds counted: only one of them speaks at a time.
      const boxes = 2 * Math.min(BELT, shelf.tokenCount);
      setTalking((now) => (now ? null : { slot: Math.floor(Math.random() * boxes), line: Math.floor(Math.random() * WHISPERS.length) }));
    }, 1800);
    return () => clearInterval(timer);
  }, [shelf]);

  if (!shelf || shelf.tokenCount === 0) return null;
  const n = (v: number) => v.toLocaleString(locale);
  const { tokenCount, sale } = shelf;
  // Real boxes known to exist: the last milestone the contract announced, never more.
  const known = Math.min(sale.reached > 0 ? sale.milestones[sale.reached - 1]! : 0, tokenCount);
  const fog = tokenCount - known;
  const knownPct = (known / tokenCount) * 100;
  const latest = Array.from({ length: Math.min(BELT, tokenCount) }, (_, i) => tokenCount - 1 - i);
  // Twice round, so the belt loops without a seam.
  const belt = [...latest, ...latest];

  return (
    <section id="shipped" className="home-section shipped">
      <h2>{t("home.shipped.title")}</h2>
      <div className="shipped-head">
        <p className="section-lede">{t("home.shipped.lede", { n: shelf.maxPerTx })}</p>
        <div className="shipped-count">
          <Odometer value={tokenCount} label={t("home.shipped.count", { n: n(tokenCount) })} />
          <p>{t("home.shipped.unit")}</p>
        </div>
      </div>

      <div className="fogbar" role="img" aria-label={`${known > 0 ? t("home.shipped.known", { n: n(known) }) : t("home.shipped.knownNone", { n: n(sale.milestones[0] ?? 0) })}. ${t(known > 0 ? "home.shipped.fog" : "home.shipped.fogAll", { n: n(fog) })}`}>
        <div className="fogbar-track" aria-hidden="true">
          {known > 0 && <span className="fogbar-known" style={{ width: `${knownPct}%` }} />}
          <span className="fogbar-fog" style={{ width: `${100 - knownPct}%` }}>
            {["?", "?", "?", "?", "?", "?"].map((q, i) => (
              <i key={i} style={{ left: `${8 + i * 16}%`, animationDelay: `${i * 0.7}s` }}>
                {q}
              </i>
            ))}
          </span>
        </div>
        <div className="fogbar-legend" aria-hidden="true">
          <span className={known > 0 ? "is-known" : "is-none"}>{known > 0 ? t("home.shipped.known", { n: n(known) }) : t("home.shipped.knownNone", { n: n(sale.milestones[0] ?? 0) })}</span>
          <span className="is-fog">{t(known > 0 ? "home.shipped.fog" : "home.shipped.fogAll", { n: n(fog) })}</span>
        </div>
      </div>

      <div className="belt" aria-label={t("home.shipped.belt")}>
        <ul className="belt-row">
          {belt.map((id, i) => (
            <BeltBox key={`${i}-${id}`} id={id} whisper={talking && talking.slot === i ? t(WHISPERS[talking.line]!) : null} />
          ))}
        </ul>
      </div>
      <p className="shipped-note">{t("home.shipped.note", { list: sale.milestones.map(n).join(", ") })}</p>
    </section>
  );
}
