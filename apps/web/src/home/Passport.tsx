import { useEffect, useState, type FormEvent } from "react";
import { ALLOW_LIST_POINTS, DEFAULT_ALLOW_LIST_PLACES } from "@dno/chain-adapter/standings";
import { chainMode } from "../chain/mode";
import { useLocale } from "../i18n/locale";
import { appPath, duelRankingPath } from "../site";
import { useXPass } from "../xpass";
import { useT } from "./i18n";

/** What the API says about one address on the mainnet allow list (`GET /v1/allowlist/:address`). */
interface PassStatus {
  live: { points: number; beaten: number; faced: number; opened: number };
  points: number;
  claimedAt: number | null;
  rank: number | null;
  claimants: number;
  places: number;
}

// Any address answers with the list's size: this one has never played.
const PROBE = "0x0000000000000000000000000000000000000000";
const REMEMBER = "dno:pass:address";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const api = () => (chainMode().mode === "mock" ? null : (import.meta.env.VITE_API_URL?.replace(/\/$/, "") || null));

async function readPass(address: string): Promise<PassStatus> {
  const res = await fetch(`${api()}/v1/allowlist/${address}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return ((await res.json()) as { data: PassStatus }).data;
}

const recall = (): string => {
  try {
    return localStorage.getItem(REMEMBER) ?? "";
  } catch {
    return "";
  }
};

type Check = { state: "idle" } | { state: "busy" } | { state: "bad" } | { state: "down" } | { state: "done"; pass: PassStatus };

/**
 * The mainnet allow list as a customs laissez-passer: three stamps (the X quest, play, sign),
 * an address to check, and how many passes are signed. The forms open in a new tab.
 */
type Count = { claimants: number; places: number };

/** How many passes are signed, out of how many places. Null without the API, or until it answers. */
export function usePassCount(): [Count | null, (c: Count) => void] {
  const [count, setCount] = useState<Count | null>(null);
  useEffect(() => {
    if (api() === null) return;
    let on = true;
    readPass(PROBE).then(
      (p) => on && setCount({ claimants: p.claimants, places: p.places }),
      () => undefined,
    );
    return () => {
      on = false;
    };
  }, []);
  return [count, setCount];
}

export function Passport() {
  const t = useT();
  const locale = useLocale();
  const [address, setAddress] = useState(recall);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [count, setCount] = usePassCount();
  const live = api() !== null;
  const { pass: xPass } = useXPass();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const a = address.trim();
    if (!ADDRESS.test(a)) return setCheck({ state: "bad" });
    setCheck({ state: "busy" });
    try {
      const pass = await readPass(a);
      setCheck({ state: "done", pass });
      setCount({ claimants: pass.claimants, places: pass.places });
      try {
        localStorage.setItem(REMEMBER, a);
      } catch {
        // A private window keeps nothing: the field is simply empty next time.
      }
    } catch {
      setCheck({ state: "down" });
    }
  };

  const pass = check.state === "done" ? check.pass : null;
  const places = count?.places ?? DEFAULT_ALLOW_LIST_PLACES;
  const stamps = [
    { key: "quest", done: !!xPass?.handle, href: "#boarding", newTab: false, chips: [] },
    {
      key: "play",
      done: pass ? pass.live.points > 0 : false,
      href: appPath(locale),
      newTab: false,
      chips: [t("home.pass.play.beaten", { n: ALLOW_LIST_POINTS.beaten }), t("home.pass.play.faced", { n: ALLOW_LIST_POINTS.faced }), t("home.pass.play.opened", { n: ALLOW_LIST_POINTS.opened, max: ALLOW_LIST_POINTS.maxOpened })],
    },
    { key: "sign", done: pass ? pass.claimedAt !== null : false, href: duelRankingPath(locale), newTab: true, chips: [] },
  ] as const;

  return (
    <section id="pass" className="home-section pass">
      <div className="pass-book">
        <header className="pass-cover">
          <p className="kicker">{t("home.pass.kicker")}</p>
          <h2>{t("home.pass.title")}</h2>
          <p className="section-lede">{t("home.pass.lede", { places })}</p>
          <div className="pass-photo" aria-hidden="true">
            <PassPhoto />
            <span className="speech">{t("home.pass.bubble")}</span>
          </div>
          {count && (
            <div className="pass-meter" role="img" aria-label={t("home.pass.meter", { count: count.claimants, places: count.places })}>
              <span className="pass-meter-bar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (count.claimants / Math.max(1, count.places)) * 100)}%` }} />
              </span>
              <span>{t("home.pass.meter", { count: count.claimants, places: count.places })}</span>
            </div>
          )}
        </header>

        <ol className="pass-stamps">
          {stamps.map((s, i) => (
            <li key={s.key} className={`pass-slot${s.done ? " is-stamped" : ""}`}>
              <span className="pass-n">{i + 1}</span>
              <h3>{t(`home.pass.${s.key}.title`)}</h3>
              <p>{t(`home.pass.${s.key}.body`)}</p>
              {s.chips.length > 0 && (
                <ul className="pass-chips">
                  {s.chips.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
              {s.href ? (
                <a className="btn btn-small" href={s.href} {...(s.newTab ? { target: "_blank", rel: "noreferrer" } : {})}>
                  {t(`home.pass.${s.key}.cta`)}
                  {s.newTab ? " ↗" : s.key === "quest" ? " ↑" : " →"}
                </a>
              ) : (
                <span className="btn btn-small btn-paper is-soon" aria-disabled="true">
                  {t("home.pass.soon")}
                </span>
              )}
              <span className="pass-ink" aria-hidden="true">
                {t(`home.pass.${s.key}.stamp`)}
              </span>
            </li>
          ))}
        </ol>

        {live && (
          <form className="pass-check" onSubmit={(e) => void submit(e)}>
            <label htmlFor="pass-address">{t("home.pass.check.label")}</label>
            <div className="pass-check-row">
              <input
                id="pass-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={t("home.pass.check.placeholder")}
                spellCheck={false}
                autoComplete="off"
                inputMode="text"
              />
              <button type="submit" className="btn btn-small" disabled={check.state === "busy"} aria-busy={check.state === "busy"}>
                {check.state === "busy" ? t("home.pass.check.busy") : t("home.pass.check.cta")}
              </button>
            </div>
            <p className="pass-check-out" aria-live="polite">
              {check.state === "bad" && t("home.pass.check.bad")}
              {check.state === "down" && t("home.pass.check.down")}
              {pass &&
                (pass.rank !== null
                  ? t(pass.rank <= pass.places ? "home.pass.check.in" : "home.pass.check.queue", { points: pass.points, rank: pass.rank, places: pass.places })
                  : pass.live.points > 0
                    ? t("home.pass.check.unsigned", { points: pass.points })
                    : t("home.pass.check.none"))}
            </p>
          </form>
        )}

        <p className="pass-fine">{t("home.pass.fine")}</p>
      </div>
    </section>
  );
}

/** A box's passport photo: two ears, two eyes, and nothing else anybody can tell. */
function PassPhoto() {
  return (
    <svg className="doodle pass-photo-art" viewBox="0 0 120 120">
      <rect x="6" y="6" width="108" height="108" rx="10" fill="#fff" stroke="var(--ink)" strokeWidth="4" />
      <path d="M34 60 L42 34 L54 54 M66 54 L78 34 L86 60" fill="var(--kraft)" stroke="var(--ink)" strokeWidth="4" strokeLinejoin="round" />
      <rect x="24" y="56" width="72" height="48" rx="4" fill="var(--kraft)" stroke="var(--ink)" strokeWidth="4" />
      <path d="M24 70 H96" stroke="var(--ink)" strokeWidth="3" />
      <circle className="pass-eye" cx="48" cy="64" r="3.5" fill="var(--ink)" />
      <circle className="pass-eye" cx="72" cy="64" r="3.5" fill="var(--ink)" />
      <text x="60" y="94" textAnchor="middle" fontFamily="var(--stencil)" fontSize="15" fill="var(--red)">
        ???
      </text>
    </svg>
  );
}
