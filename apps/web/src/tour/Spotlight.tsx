import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import "./tour.css";

/**
 * A guided walk: a spotlight zooms onto one thing at a time with a tag saying what it is for.
 * The game's depot tour and the vault's walkthrough both use it. A step may first `enter` (open a
 * tab, say) so that what it points at is on screen; a step whose targets are all missing is
 * skipped. The first target found is the one lit, so a step can fall back on a smaller one.
 */
export interface SpotStep {
  /** `data-tour` names, tried in order. */
  targets: string[];
  title: string;
  body: string;
  enter?: () => void;
}

export interface SpotLabels {
  count: (n: number, total: number) => string;
  skip: string;
  back: string;
  next: string;
  done: string;
}

const PAD = 8;

/** The element a step points at, if it is laid out and not tucked away. */
function findOne(target: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden") return el;
  }
  return null;
}

function find(step: SpotStep): HTMLElement | null {
  for (const target of step.targets) {
    const el = findOne(target);
    if (el) return el;
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

/** Shown while `step` is a number; `onStep(null)` is never called, `onClose` ends it. */
export function Spotlight({
  steps,
  step,
  onStep,
  onClose,
  labels,
  className,
}: {
  steps: SpotStep[];
  step: number | null;
  onStep: (step: number) => void;
  onClose: () => void;
  labels: SpotLabels;
  className?: string;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const width = useWindowWidth();
  /**
   * The steps counted in "n of total", fixed when the walk starts: entering a step can hide
   * another one's target (the other side's figures), which must not change the count. A step
   * skipped on the way drops out of it.
   */
  const [counted, setCounted] = useState<number[]>([]);
  const running = step !== null;

  useEffect(() => {
    if (!running) return setBox(null);
    setCounted(steps.map((s, i) => (s.enter || find(s) ? i : -1)).filter((i) => i >= 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- counted once per walk
  }, [running]);

  /**
   * Moves from `from` in direction `dir` to the next step with something on screen. A step that
   * enters first is taken on trust: its target only shows once it has entered.
   */
  const go = useCallback(
    (from: number, dir: 1 | -1) => {
      for (let i = from; i >= 0 && i < steps.length; i += dir) {
        const s = steps[i]!;
        if (s.enter) {
          s.enter();
          return onStep(i);
        }
        if (find(s)) return onStep(i);
      }
      if (dir === 1) onClose();
    },
    [steps, onStep, onClose],
  );

  // A step whose target is missing, even once entered, hands over to the next one.
  useEffect(() => {
    if (step === null) return;
    const id = requestAnimationFrame(() => {
      if (find(steps[step]!)) return;
      setCounted((c) => c.filter((i) => i !== step));
      go(step + 1, 1);
    });
    return () => cancelAnimationFrame(id);
  }, [step, steps, go]);

  // Follow the target every frame: panels fold, the header wraps, the window turns.
  useEffect(() => {
    if (step === null) return;
    let frame = 0;
    const track = () => {
      const el = find(steps[step]!);
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
  }, [step, steps]);

  // Bring the target into view when it sits off screen (a long page on a phone).
  useEffect(() => {
    if (step === null) return;
    const id = requestAnimationFrame(() => {
      const el = find(steps[step]!);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [step, steps]);

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
    next.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(step + 1, 1);
      else if (e.key === "ArrowLeft") go(step - 1, -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, go, onClose]);

  if (step === null || !box) return null;
  const shown = counted.includes(step) ? counted : [...counted, step].sort((a, b) => a - b);
  const index = shown.indexOf(step);
  const last = index === shown.length - 1;
  const s = steps[step]!;

  return (
    <div className={`tour${className ? ` ${className}` : ""}${reduced() ? " is-still" : ""}`} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      {/* Clicks outside the spotlight are caught; the target itself stays usable. */}
      <div className="tour-shade" onClick={onClose} />
      <div className="tour-spot" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} key={`spot-${step}`} />
      <div className="tour-card" ref={card} style={cardPos ? { top: cardPos.top, left: cardPos.left } : { visibility: "hidden" }} key={`card-${step}`}>
        <p className="tour-count">{labels.count(index + 1, shown.length)}</p>
        <h2 id="tour-title" className="tour-title">
          {s.title}
        </h2>
        <p id="tour-body" className="tour-body">
          {s.body}
        </p>
        <div className="tour-actions">
          <button type="button" className="link" onClick={onClose}>
            {labels.skip}
          </button>
          <span className="tour-nav">
            {index > 0 && (
              <button type="button" className="plain-button" onClick={() => go(step - 1, -1)}>
                {labels.back}
              </button>
            )}
            <button type="button" className="plain-button tour-next" ref={next} onClick={() => (last ? onClose() : go(step + 1, 1))}>
              {last ? labels.done : labels.next}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** The first step with something on screen, entering it if it says so. */
export function firstStep(steps: SpotStep[]): number | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.enter) {
      s.enter();
      return i;
    }
    if (find(s)) return i;
  }
  return null;
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
