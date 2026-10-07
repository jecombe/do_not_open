import { useEffect, useState } from "react";
import { MockAdapter, type RatSupply } from "@dno/chain-adapter";
import { studio } from "@dno/game-spec";
import { chainMode } from "../chain/mode";
import { useT } from "./i18n";
import { apiUrl } from "../apiUrl";

type Counts = Pick<RatSupply, "seed" | "model">;

const REFRESH_MS = 60_000;

/** The caps alone, before (or without) the API: nothing minted is known yet. */
const CAPS: Counts = { seed: { minted: 0, max: studio.rats.mint.maxSeedRats }, model: { minted: 0, max: studio.rats.mint.maxModelRats } };

/** Rats minted per kind: the API on Sepolia, the in-memory game in the demo. Null until one answers. */
function useRatCounts(): Counts | null {
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    let live = true;
    const { mode } = chainMode();
    const api = apiUrl();
    const read = async (): Promise<Counts | null> => {
      if (mode === "mock") return new MockAdapter().ratSupply(null);
      if (!api) return null;
      const res = await fetch(`${api}/v1/rats/supply`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      return ((await res.json()) as { supply: Counts }).supply;
    };
    const tick = () =>
      read().then(
        (c) => live && c && setCounts(c),
        () => undefined,
      );
    void tick();
    const timer = mode === "mock" ? null : setInterval(tick, REFRESH_MS);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, []);
  return counts;
}

function Meter({ label, minted, max }: { label: string; minted: number; max: number }) {
  const left = Math.max(0, max - minted);
  return (
    <div className="rats-left-row">
      <span className="rats-left-label">{label}</span>
      <span className="rats-left-bar" aria-hidden="true">
        <span style={{ width: `${max ? (left / max) * 100 : 0}%` }} />
      </span>
      <span className="rats-left-count">
        <strong>{left}</strong>/{max}
      </span>
    </div>
  );
}

/** How many rats are left to adopt, per kind, out of the most there will ever be. */
export function RatsLeft() {
  const t = useT();
  const live = useRatCounts();
  const c = live ?? CAPS;
  return (
    <div className="rats-left" role="group" aria-label={t("home.studio.left.aria")}>
      <p className="rats-left-title">{t("home.studio.left.title")}</p>
      <Meter label={t("home.studio.left.seed")} minted={c.seed.minted} max={c.seed.max} />
      <Meter label={t("home.studio.left.model")} minted={c.model.minted} max={c.model.max} />
      <p className="rats-left-note">{t("home.studio.left.note", { perWallet: studio.rats.mint.maxPerWallet })}</p>
    </div>
  );
}
