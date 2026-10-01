import { useEffect, useRef, useState } from "react";
import type { Step } from "@dno/chain-adapter";
import { useT, type AppKey } from "../i18n/app";

export interface PlannedStep {
  step: Step;
  label: AppKey;
}

/** A cUSDC payment comes first: the order, then the proof that it was paid. */
export const PAYMENT_STEPS: PlannedStep[] = [
  { step: "wallet", label: "track.order" },
  { step: "confirming", label: "track.chain" },
  { step: "decrypting", label: "track.decryptPaid" },
  { step: "proving", label: "track.proof" },
];

/**
 * The steps of a slow chain action, ticked off as they pass, the current one with a
 * running count of seconds: a long decryption reads as progress, not as a hang.
 */
export function StepTracker({ plan, step }: { plan: PlannedStep[]; step: Step | null }) {
  const t = useT();
  const [at, setAt] = useState(-1);
  const [seconds, setSeconds] = useState(0);
  const last = useRef<Step | null>(null);

  // A step can come back (a second signature): look for it from where we are, never behind.
  useEffect(() => {
    if (step === null || step === last.current) return;
    last.current = step;
    setAt((cur) => {
      const from = cur < 0 ? 0 : cur + 1;
      const i = plan.findIndex((p, k) => k >= from && p.step === step);
      return i < 0 ? cur : i;
    });
    setSeconds(0);
  }, [step, plan]);

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [at]);

  return (
    <ol className="tracker">
      {plan.map((p, i) => (
        <li key={i} className={i < at ? "done" : i === at ? "now" : undefined} aria-current={i === at ? "step" : undefined}>
          <span className="tick" aria-hidden="true" />
          {t(p.label)}
          {i === at && seconds > 2 && <span className="secs">{t("track.seconds", { n: seconds })}</span>}
        </li>
      ))}
    </ol>
  );
}
