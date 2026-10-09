import { useEffect, useRef } from "react";

const INTERACTIVE = "a, button, [role='button'], summary, label, select";
const TEXT = "input, textarea, [contenteditable='true']";

/**
 * The pointer as a padlock, on mouse and pen only. A dot marks the exact point; the lock trails
 * it a little. Over a link or a button the shackle lifts (it would let you in); a press snaps it
 * shut; over a text field the lock steps aside for the system's caret.
 */
export function LockCursor() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || !matchMedia("(pointer: fine)").matches) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const html = document.documentElement;
    html.classList.add("has-lock");
    const dot = el.querySelector<HTMLElement>(".lock-dot")!;
    const lock = el.querySelector<HTMLElement>(".lock-body")!;
    const at = { x: -100, y: -100 };
    const trail = { x: -100, y: -100 };
    let raf = 0;

    const frame = () => {
      raf = 0;
      const k = still ? 1 : 0.22;
      trail.x += (at.x - trail.x) * k;
      trail.y += (at.y - trail.y) * k;
      dot.style.transform = `translate(${at.x}px, ${at.y}px)`;
      lock.style.transform = `translate(${trail.x + 16}px, ${trail.y + 16}px)`;
      if (Math.abs(at.x - trail.x) + Math.abs(at.y - trail.y) > 0.3) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      if (!el.classList.contains("on")) {
        // First sight: no trailing in from the corner.
        trail.x = e.clientX;
        trail.y = e.clientY;
      }
      at.x = e.clientX;
      at.y = e.clientY;
      el.classList.add("on");
      kick();
    };
    const over = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      el.classList.toggle("is-text", !!target?.closest(TEXT));
      el.classList.toggle("is-open", !!target?.closest(INTERACTIVE) && !target?.closest(TEXT));
    };
    const down = () => el.classList.add("is-down");
    const up = () => el.classList.remove("is-down");
    const leave = () => el.classList.remove("on");

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerover", over, { passive: true });
    window.addEventListener("pointerdown", down, { passive: true });
    window.addEventListener("pointerup", up, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      html.classList.remove("has-lock");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerover", over);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      document.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <div ref={root} className="lock-cursor" aria-hidden="true">
      <span className="lock-dot" />
      <span className="lock-body">
        <svg viewBox="0 0 24 28" width="22" height="26">
          <path className="lock-shackle" d="M6.5 13V8.5a5.5 5.5 0 0 1 11 0V13" />
          <rect x="3" y="12" width="18" height="14" rx="3" />
          <path className="lock-hole" d="M12 17.5v3.5" />
        </svg>
      </span>
    </div>
  );
}
