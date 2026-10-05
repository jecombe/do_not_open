import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useT, type AppKey } from "../i18n/app";
import { progressOf, seedOf } from "./progress";
import type { JobKind } from "./service";

// three.js loads with the wheel, never with the page's text.
const WheelLoader = lazy(() => import("./WheelLoader").then((m) => ({ default: m.WheelLoader })));

const PHASES: Record<JobKind, AppKey[]> = {
  sketch: ["studio.load.sketch.0", "studio.load.sketch.1", "studio.load.sketch.2", "studio.load.sketch.3"],
  model: ["studio.load.model.0", "studio.load.model.1", "studio.load.model.2", "studio.load.model.3"],
};

/**
 * A running job on the drawing board: the rat in its wheel and a bar of how far along the AI
 * looks. The bar is worked out from when the job started, so it picks up where it was when the
 * visitor comes back to the page.
 */
export function JobLoader({ id, kind, startedMs, expectedS }: { id: string; kind: JobKind; startedMs: number; expectedS: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const elapsedS = Math.max(0, (now - startedMs) / 1000);
  const p = progressOf(elapsedS, expectedS);
  const pRef = useRef(p);
  pRef.current = p;
  const progress = useCallback(() => pRef.current, []);
  const phases = PHASES[kind];
  const phase = phases[Math.min(phases.length - 1, Math.floor((elapsedS / expectedS) * phases.length))]!;
  const leftS = Math.ceil(expectedS - elapsedS);
  const percent = Math.floor(p * 100);

  return (
    <div className="studio-viewer studio-loading">
      <Suspense fallback={null}>
        <WheelLoader kind={kind} seed={seedOf(id)} progress={progress} />
      </Suspense>
      <div className="studio-load" role="status" aria-live="polite">
        <p className="studio-load-phase">{t(phase)}</p>
        <div className="studio-load-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("studio.load.aria")}>
          <span style={{ width: `${Math.max(3, p * 100)}%` }} />
        </div>
        <p className="studio-load-meta">
          <span>{percent}%</span>
          <span>{leftS <= 0 ? t("studio.load.long") : leftS >= 90 ? t("studio.load.leftMin", { n: Math.round(leftS / 60) }) : t("studio.load.left", { n: leftS })}</span>
        </p>
      </div>
    </div>
  );
}
