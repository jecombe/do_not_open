import { useEffect, useState } from "react";

/** What ciphertext looks like on these pages: hex and shaded blocks. */
const GLYPHS = "0123456789abcdef▓▒░█";

export const glyphs = (n: number) => Array.from({ length: n }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join("");
export const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
export const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Text that resolves out of ciphertext, left to right, when it first shows or changes. Screen
 * readers get the plain text from the caller's aria-label. `ms` is the whole reveal; `perChar`,
 * when given, makes it last longer for longer text (capped at 2.5 s).
 */
export function useDecrypt(text: string, ms = 1100, perChar = 0): string {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (reduced()) return setShown(text);
    const total = perChar ? Math.min(2500, Math.max(ms, text.length * perChar)) : ms;
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const k = Math.min(1, (performance.now() - start) / total);
      const fixed = Math.floor(text.length * k);
      setShown(text.slice(0, fixed) + [...text.slice(fixed)].map((c) => (c === " " || c === "\n" ? c : glyphs(1))).join(""));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [text, ms, perChar]);
  return shown;
}
