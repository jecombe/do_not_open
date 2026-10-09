import { useCallback, useEffect, useMemo, useState } from "react";
import { useChain } from "../chain/ChainProvider";
import { useT, type AppKey } from "../i18n/app";
import { useGateUp } from "../terms/terms";
import { Spotlight, type SpotStep } from "./Spotlight";

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

export function Tour() {
  const t = useT();
  const { collection } = useChain();
  const gateUp = useGateUp();
  const [step, setStep] = useState<number | null>(null);

  const steps = useMemo<SpotStep[]>(() => STEPS.map((s) => ({ targets: [s.target], title: t(s.title), body: t(s.body) })), [t]);
  const labels = useMemo(
    () => ({ count: (n: number, total: number) => t("tour.count", { n, total }), skip: t("tour.skip"), back: t("tour.back"), next: t("tour.next"), done: t("tour.done") }),
    [t],
  );

  // Once, with no form in the way: give the depot a moment to settle so the spotlight lands on real things.
  useEffect(() => {
    if (gateUp || !collection || seen() || step !== null) return;
    const timer = setTimeout(() => setStep(0), 900);
    return () => clearTimeout(timer);
  }, [gateUp, collection, step]);

  useEffect(() => {
    const play = () => setStep(0);
    replays.add(play);
    return () => void replays.delete(play);
  }, []);

  const close = useCallback(() => {
    markSeen();
    setStep(null);
  }, []);

  return <Spotlight steps={steps} step={step} onStep={setStep} onClose={close} labels={labels} />;
}
