import { useEffect, useRef, useState } from "react";

/** How long a figure takes to roll from the old value to the new one. */
const ROLL_MS = 700;
/** How long the flash and the "+5" stay after a change. */
const SHOW_MS = 1600;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface Change {
  /** Restarts the animations when the value moves again before the last one ended. */
  id: number;
  dir: "up" | "down";
  /** How much it moved, always positive. */
  size: bigint;
}

/**
 * A value that rolls to its new figure when it changes, and says by how much. The first value,
 * and a value coming back after `null` (a new account, a reload), just appear.
 */
export function useLiveValue(value: bigint | null): { shown: bigint | null; change: Change | null } {
  const [shown, setShown] = useState(value);
  const [change, setChange] = useState<Change | null>(null);
  const last = useRef(value);

  useEffect(() => {
    const from = last.current;
    last.current = value;
    if (value === null || from === null || from === value) {
      setShown(value);
      return;
    }
    const delta = value - from;
    setChange({ id: performance.now(), dir: delta > 0n ? "up" : "down", size: delta > 0n ? delta : -delta });
    if (reduced()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const roll = (now: number) => {
      const p = Math.min(1, (now - start) / ROLL_MS);
      const eased = 1 - (1 - p) ** 3;
      setShown(p === 1 ? value : from + (delta * BigInt(Math.round(eased * 1000))) / 1000n);
      if (p < 1) frame = requestAnimationFrame(roll);
    };
    frame = requestAnimationFrame(roll);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  useEffect(() => {
    if (!change) return;
    const timer = setTimeout(() => setChange(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [change]);

  return { shown, change };
}

/** A glow over the whole chip, green going up, red going down. The chip must be `position: relative`. */
export function Flash({ change }: { change: Change | null }) {
  if (!change) return null;
  return <span key={change.id} className={`live-flash is-${change.dir}`} aria-hidden="true" />;
}

/** The figure itself, with a small pop each time it moves. */
export function Figure({ change, children }: { change: Change | null; children: React.ReactNode }) {
  return (
    <span key={change?.id ?? 0} className={change ? `live-figure is-${change.dir}` : "live-figure"}>
      {children}
    </span>
  );
}

/** "+5" or "−0.25", rising beside the symbol and fading out. */
export function Delta({ change, format }: { change: Change | null; format: (amount: bigint) => string }) {
  if (!change) return null;
  return (
    <span key={change.id} className={`live-delta is-${change.dir}`} aria-hidden="true">
      {change.dir === "up" ? "+" : "−"}
      {format(change.size)}
    </span>
  );
}
