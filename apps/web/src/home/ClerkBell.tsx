import { useEffect, useRef, useState } from "react";
import { chatApi } from "../chat/api";
import { Clerk } from "../chat/Clerk";
import { useT } from "./i18n";
import { pageSound } from "./sound";

const HUSHED_KEY = "dno.clerkBell";
/** When the clerk rings, counted from the page's opening: three tries, then it gives up. */
const RINGS = [6_000, 40_000, 100_000];
const LINES = ["home.clerk.say1", "home.clerk.say2", "home.clerk.say3"] as const;
/** How long one ring shakes the bell. */
const RING_MS = 900;
/** How fast the bubble types, per character. */
const TYPE_MS = 26;

function readHushed(): boolean {
  try {
    return sessionStorage.getItem(HUSHED_KEY) === "1";
  } catch {
    return false;
  }
}

function hush(): void {
  try {
    sessionStorage.setItem(HUSHED_KEY, "1");
  } catch {
    // Private window: the clerk stays quiet for this page only.
  }
}

const calm = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The depot's clerk, on the home page: the same chat as in the manual, with a brass bell on
 * its tab. The clerk rings it a few times to catch the visitor's eye and says something in a
 * bubble; the visitor can ring it back, which opens the counter. Once the counter has been
 * opened, or the bubble closed, the clerk stops calling for the rest of the visit. Browsers
 * keep sound off until the first click, so a ring before that is only seen, and that first
 * click gets the "ding" the visitor missed. The toy's sound switch mutes it too.
 */
export function ClerkBell() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [hushed, setHushed] = useState(readHushed);
  const [line, setLine] = useState<number | null>(null);
  const [typed, setTyped] = useState(0);
  const [ringing, setRinging] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const heard = useRef(false);
  const quiet = hushed || open;
  const stop = () => {
    hush();
    setHushed(true);
    setLine(null);
  };

  const ring = (times: number) => {
    setRinging(false);
    // Restart the shake even if the last one is still running.
    requestAnimationFrame(() => setRinging(true));
    pageSound.bell(times);
  };

  // The clerk's own rings.
  useEffect(() => {
    if (quiet || !chatApi()) return;
    const timers = RINGS.map((at, i) =>
      setTimeout(() => {
        setLine(i);
        ring(2);
      }, at),
    );
    return () => timers.forEach(clearTimeout);
  }, [quiet]);

  // The first click or key anywhere unlocks sound; if the clerk was already calling, it is heard now.
  useEffect(() => {
    const unlock = (e: Event) => {
      pageSound.resume();
      const target = e.target as Element | null;
      const own = root.current?.contains(target) || target?.closest?.(".clerk, .clerk-tab");
      if (!heard.current && line !== null && !quiet && !own) setTimeout(() => pageSound.bell(1), 120);
      heard.current = true;
    };
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [line, quiet]);

  useEffect(() => {
    if (!ringing) return;
    const done = setTimeout(() => setRinging(false), RING_MS);
    return () => clearTimeout(done);
  }, [ringing]);

  // The bubble types its line out, like a telex at the counter.
  const text = line === null ? "" : t(LINES[line]!);
  useEffect(() => setTyped(calm() ? text.length : 0), [text]);
  useEffect(() => {
    if (typed >= text.length) return;
    const next = setTimeout(() => setTyped(typed + 1), TYPE_MS);
    return () => clearTimeout(next);
  }, [text, typed]);

  if (!chatApi()) return null;

  const openCounter = () => {
    stop();
    setOpen(true);
  };

  return (
    <>
      {!open && (
        <div ref={root} className="clerk-bell">
          {line !== null && !hushed && (
            <div className="clerk-bell-bubble">
              {/* The full line holds the bubble's size while the typed one grows over it. */}
              <button type="button" className="clerk-bell-say" aria-label={text} onClick={openCounter}>
                <span className="clerk-bell-full" aria-hidden="true">
                  {text}
                </span>
                <span className="clerk-bell-typed" aria-hidden="true">
                  {text.slice(0, typed)}
                </span>
              </button>
              <button type="button" className="clerk-bell-hush" aria-label={t("home.clerk.hush")} title={t("home.clerk.hush")} onClick={stop}>
                ×
              </button>
            </div>
          )}
          <button
            type="button"
            className={`clerk-bell-button${ringing ? " is-ringing" : ""}`}
            aria-label={t("home.clerk.ring")}
            title={t("home.clerk.ring")}
            onClick={() => {
              pageSound.resume();
              heard.current = true;
              ring(2);
              setTimeout(openCounter, 420);
            }}
          >
            <span className="clerk-bell-ding" aria-hidden="true">
              {t("home.clerk.ding")}
            </span>
            <BellDoodle />
          </button>
        </div>
      )}
      <Clerk open={open} onOpenChange={setOpen} />
    </>
  );
}

function BellDoodle() {
  const ink = { stroke: "#1c1814", strokeWidth: 3, strokeLinejoin: "round", strokeLinecap: "round" } as const;
  return (
    <svg className="clerk-bell-svg" viewBox="0 0 64 56" aria-hidden="true">
      <g className="clerk-bell-waves" fill="none" {...ink} strokeWidth={2.5}>
        <path d="M8 18 q-5 8 0 16 M3 13 q-7 13 0 26" />
        <path d="M56 18 q5 8 0 16 M61 13 q7 13 0 26" />
      </g>
      <rect x="10" y="44" width="44" height="8" rx="3" fill="#7a5a36" {...ink} />
      <g className="clerk-bell-dome">
        <path d="M14 44 Q14 18 32 18 Q50 18 50 44 Z" fill="#ffd66b" {...ink} />
        <path d="M21 38 Q21 26 29 23" fill="none" stroke="#fff6d0" strokeWidth={3} strokeLinecap="round" />
        <rect x="29" y="10" width="6" height="8" fill="#ffd66b" {...ink} />
      </g>
      <rect className="clerk-bell-knob" x="25" y="5" width="14" height="6" rx="3" fill="#c2261d" {...ink} />
    </svg>
  );
}
