import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Step } from "@dno/chain-adapter";
import { stepCopy } from "../chain/copy";
import { useT, type AppKey } from "../i18n/app";
import { StepTracker, type PlannedStep } from "./StepTracker";

/** How a step reads in the list when the action has no plan: each one as it comes. */
const LOGGED: Record<Step, AppKey> = {
  encrypting: "track.encrypt",
  wallet: "track.sign",
  confirming: "track.chain",
  decrypting: "track.decryptPublic",
  proving: "track.proof",
};

/**
 * While a chain action runs, the slip it was started from shows the stamped box shaking and
 * the steps it goes through, in place of its content. The content stays mounted underneath,
 * hidden, so a failed action hands the slip back exactly as it was, with the problem in it.
 */
export function TxPending(props: { busy: string | null; step: Step | null; title: string; plan?: PlannedStep[] | null; secret?: boolean; children: ReactNode }) {
  const { busy, step, title, plan, secret = false, children } = props;
  const body = useRef<HTMLDivElement>(null);
  const was = useRef(busy);
  // Handed back after a failure: the problem sits at the foot of the slip, bring it into view.
  useEffect(() => {
    if (was.current && !busy) body.current?.querySelector(".problem-note")?.scrollIntoView({ block: "nearest" });
    was.current = busy;
  }, [busy]);
  return (
    <>
      <div className="tx-body" hidden={!!busy} ref={body}>
        {children}
      </div>
      {busy && <Working key={busy} step={step} title={title} plan={plan ?? null} secret={secret} />}
    </>
  );
}

function Working({ step, title, plan, secret }: { step: Step | null; title: string; plan: PlannedStep[] | null; secret: boolean }) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  // The slip may have been scrolled down to its button: bring the spinner into view.
  useEffect(() => {
    root.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div className="tx-pending" role="status" aria-live="polite" ref={root}>
      <BoxSpinner />
      <p className="tx-title">{title}</p>
      {plan ? <StepTracker plan={plan} step={step} /> : <StepLog step={step} secret={secret} />}
      <p className="fine tx-now">{stepCopy(step, secret)}</p>
      {step === "decrypting" && <p className="fine">{t("track.slow")}</p>}
      <p className="fine tx-keep">{t("ex.keepOpen")}</p>
    </div>
  );
}

/** The steps an action without a plan went through so far, the last one running. */
function StepLog({ step, secret }: { step: Step | null; secret: boolean }) {
  const t = useT();
  const [seen, setSeen] = useState<Step[]>([]);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (step === null) return;
    setSeen((s) => (s[s.length - 1] === step ? s : [...s, step]));
    setSeconds(0);
  }, [step]);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [seen.length]);
  if (!seen.length) return null;
  return (
    <ol className="tracker">
      {seen.map((s, i) => {
        const now = i === seen.length - 1;
        return (
          <li key={i} className={now ? "now" : "done"} aria-current={now ? "step" : undefined}>
            <span className="tick" aria-hidden="true" />
            {t(s === "decrypting" && secret ? "track.decryptPrivate" : LOGGED[s])}
            {now && seconds > 2 && <span className="secs">{t("track.seconds", { n: seconds })}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The site's mark, a taped kraft box under a red stamp, rattled while the chain works. */
export function BoxSpinner() {
  return (
    <svg className="box-spinner" viewBox="0 0 64 64" aria-hidden="true">
      <circle className="box-spinner-ring" cx="32" cy="32" r="30" />
      <g className="box-spinner-box">
        <rect x="14" y="16" width="36" height="32" fill="#B8895A" stroke="#1c1814" strokeWidth="2" />
        <rect x="14" y="28" width="36" height="8" fill="#D9C28A" />
        <rect className="box-spinner-stamp" x="18" y="22" width="28" height="20" fill="none" stroke="#C2261D" strokeWidth="3.5" />
      </g>
    </svg>
  );
}
