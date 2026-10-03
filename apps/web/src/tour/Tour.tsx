import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useChain } from "../chain/ChainProvider";
import { useT, type AppKey } from "../i18n/app";
import { useGateUp, useTermsRecord } from "../terms/terms";
import "./tour.css";

/**
 * The first walk through the depot: once the release form is signed, a spotlight zooms onto a
 * few things in turn (where to ask for help, the balances, the menu, where boxes are bought)
 * with a tag saying what each is for. Shown once per browser; the menu plays it again.
 * A step whose target is not on screen (no chat without the API, the shelf on another view) is
 * skipped.
 */
const STEPS: { target: string; title: AppKey; body: AppKey }[] = [
  { target: "clerk", title: "tour.clerk.title", body: "tour.clerk.body" },
  { target: "balances", title: "tour.balances.title", body: "tour.balances.body" },
  { target: "menu", title: "tour.menu.title", body: "tour.menu.body" },
  { target: "mint", title: "tour.mint.title", body: "tour.mint.body" },
  { target: "boxes", title: "tour.boxes.title", body: "tour.boxes.body" },
];

const SEEN = "dno.tour.v1";
const PAD = 8;

const replays = new Set<() => void>();
/** The menu's "Guided tour": plays it again from the start. */
export function replayTour(): void {
  for (const r of replays) r();
}

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN, "1");
  } catch {
    // Private mode: the tour may show again on the next visit, which is harmless.
  }
}

/** The element a step points at, if it is laid out and not tucked away. */
function find(target: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden") return el;
  }
  return null;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Tour() {
  const t = useT();
  const { collection } = useChain();
  const record = useTermsRecord();
  const gateUp = useGateUp();
  const [step, setStep] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const width = useWindowWidth();

  // Once, after the form: give the depot a moment to settle so the spotlight lands on real things.
  useEffect(() => {
    if (gateUp || !record.initialed || !collection || seen() || step !== null) return;
    const timer = setTimeout(() => setStep(0), 900);
    return () => clearTimeout(timer);
  }, [gateUp, record.initialed, collection, step]);

  useEffect(() => {
    const play = () => setStep(0);
    replays.add(play);
    return () => void replays.delete(play);
  }, []);

  const close = useCallback(() => {
    markSeen();
    setStep(null);
    setBox(null);
  }, []);

  /** Moves from `from` in direction `dir` to the next step with something on screen. */
  const go = useCallback(
    (from: number, dir: 1 | -1) => {
      for (let i = from; i >= 0 && i < STEPS.length; i += dir) if (find(STEPS[i]!.target)) return setStep(i);
      if (dir === 1) close();
    },
    [close],
  );

  // A step whose target is missing hands over to the next one.
  useEffect(() => {
    if (step !== null && !find(STEPS[step]!.target)) go(step, 1);
  }, [step, go]);

  // Follow the target every frame: slips fold, the masthead wraps, the window turns.
  useEffect(() => {
    if (step === null) return;
    let frame = 0;
    const track = () => {
      const el = find(STEPS[step]!.target);
      if (el) {
        const r = el.getBoundingClientRect();
        setBox((b) => {
          const n = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
          return b && b.top === n.top && b.left === n.left && b.width === n.width && b.height === n.height ? b : n;
        });
      }
      frame = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(frame);
  }, [step]);

  // The tag sits under the spotlight when there is room, above it otherwise, always on screen.
  useLayoutEffect(() => {
    if (!box || !card.current) return;
    const c = card.current.getBoundingClientRect();
    const margin = 12;
    const below = box.top + box.height + margin;
    const top = below + c.height < window.innerHeight - margin ? below : Math.max(margin, box.top - c.height - margin);
    const left = Math.min(Math.max(margin, box.left + box.width / 2 - c.width / 2), window.innerWidth - c.width - margin);
    setCardPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  }, [box, step, width]);

  useEffect(() => {
    if (step === null) return;
    next.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(step + 1, 1);
      else if (e.key === "ArrowLeft") go(step - 1, -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, go, close]);

  if (step === null || !box) return null;
  const shown = STEPS.map((s, i) => ({ ...s, i })).filter((s) => find(s.target));
  const index = shown.findIndex((s) => s.i === step);
  const last = index === shown.length - 1;
  const s = STEPS[step]!;

  return (
    <div className={`tour${reduced() ? " is-still" : ""}`} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      {/* Clicks outside the spotlight are caught; the target itself stays usable. */}
      <div className="tour-shade" onClick={close} />
      <div className="tour-spot" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} key={`spot-${step}`} />
      <div className="tour-card" ref={card} style={cardPos ? { top: cardPos.top, left: cardPos.left } : { visibility: "hidden" }} key={`card-${step}`}>
        <p className="tour-count">
          {t("tour.count", { n: index + 1, total: shown.length })}
        </p>
        <h2 id="tour-title" className="tour-title">
          {t(s.title)}
        </h2>
        <p id="tour-body" className="tour-body">
          {t(s.body)}
        </p>
        <div className="tour-actions">
          <button type="button" className="link" onClick={close}>
            {t("tour.skip")}
          </button>
          <span className="tour-nav">
            {index > 0 && (
              <button type="button" className="plain-button" onClick={() => go(step - 1, -1)}>
                {t("tour.back")}
              </button>
            )}
            <button type="button" className="plain-button tour-next" ref={next} onClick={() => (last ? close() : go(step + 1, 1))}>
              {last ? t("tour.done") : t("tour.next")}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function useWindowWidth(): number {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener("resize", l);
      return () => window.removeEventListener("resize", l);
    },
    () => window.innerWidth,
  );
}
