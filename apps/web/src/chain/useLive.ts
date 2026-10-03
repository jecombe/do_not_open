import { useEffect, useRef } from "react";

/** About one Sepolia block: what is on screen is never more than a block behind. */
export const LIVE_MS = 12_000;

/**
 * Runs `read` now, again every `LIVE_MS` while the page is in view, and at once when the player
 * comes back to the tab. Nothing is read while the tab is hidden. `read` gets a `live()` check
 * that turns false once the deps change or the component goes.
 */
export function useLive(read: (live: () => boolean) => void, deps: readonly unknown[], enabled = true): void {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const isLive = () => live;
    const tick = () => {
      if (!document.hidden) latest.current(isLive);
    };
    tick();
    const timer = setInterval(tick, LIVE_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
}
