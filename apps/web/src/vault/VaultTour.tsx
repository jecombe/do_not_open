import { useCallback, useEffect, useMemo, useState } from "react";
import { Spotlight, firstStep, type SpotStep } from "../tour/Spotlight";
import { useT } from "./i18n";
import type { VaultKey } from "./i18n/en";

export type TourTab = "explore" | "mine" | "pocket" | "pools" | "wallet" | "sales" | "leaks";

/**
 * The vault's walkthrough, the way a game shows its first level: the two safes, what stays hidden,
 * the wallet, then each tab in the order a newcomer uses them (look, seal, hold and sell, sell
 * privately, pockets, liquidity positions, what leaks), and where to ask. Each tab's step opens it first, so the
 * spotlight lands on the real thing; without a wallet it falls back on the tab itself.
 * Shown once per browser, after the vault's door has opened; the bar's "?" plays it again.
 */
const STEPS: { targets: string[]; key: string; tab?: TourTab }[] = [
  { targets: ["kinds"], key: "kinds" },
  { targets: ["owners"], key: "owners" },
  { targets: ["account"], key: "account" },
  { targets: ["grid", "tab-explore"], key: "explore", tab: "explore" },
  { targets: ["decoys", "tab-wallet"], key: "seal", tab: "wallet" },
  { targets: ["tab-mine"], key: "mine", tab: "mine" },
  { targets: ["tab-sales"], key: "sales", tab: "sales" },
  { targets: ["pocket", "tab-pocket"], key: "pocket", tab: "pocket" },
  { targets: ["lp-pools", "tab-pools"], key: "lp", tab: "pools" },
  { targets: ["tab-leaks"], key: "leaks", tab: "leaks" },
  { targets: ["warden"], key: "warden" },
  { targets: ["tour-replay"], key: "again" },
];

const SEEN = "dno.vault-tour.v2";

const replays = new Set<() => void>();
/** The bar's "?": plays the walkthrough again from the start. */
export function replayVaultTour(): void {
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
    // Private mode: the walkthrough may show again on the next visit, which is harmless.
  }
}

/** `ready` once the market has its first read and no box is open; `go` opens a tab. */
export function VaultTour({ ready, go }: { ready: boolean; go: (tab: TourTab) => void }) {
  const t = useT();
  const [step, setStep] = useState<number | null>(null);

  const steps = useMemo<SpotStep[]>(
    () =>
      STEPS.map((s) => ({
        targets: s.targets,
        title: t(`vault.tour.${s.key}.title` as VaultKey),
        body: t(`vault.tour.${s.key}.body` as VaultKey),
        enter: s.tab ? () => go(s.tab!) : undefined,
      })),
    [t, go],
  );
  const labels = useMemo(
    () => ({
      count: (n: number, total: number) => t("vault.tour.count", { n, total }),
      skip: t("vault.tour.skip"),
      back: t("vault.tour.back"),
      next: t("vault.tour.next"),
      done: t("vault.tour.done"),
    }),
    [t],
  );

  // Once, after the door has opened and the market has read the chain.
  useEffect(() => {
    if (!ready || seen() || step !== null) return;
    const timer = setTimeout(() => setStep(firstStep(steps)), 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the first read starts it
  }, [ready]);

  useEffect(() => {
    const play = () => setStep(firstStep(steps));
    replays.add(play);
    return () => void replays.delete(play);
  }, [steps]);

  // Back to the market where it started.
  const close = useCallback(() => {
    markSeen();
    setStep(null);
    go("explore");
  }, [go]);

  return <Spotlight steps={steps} step={step} onStep={setStep} onClose={close} labels={labels} className="tour-vault" />;
}
