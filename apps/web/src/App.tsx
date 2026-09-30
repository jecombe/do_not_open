import { useEffect, useMemo, useRef, useState } from "react";
import { shortAddress } from "@dno/chain-adapter";
import { detectQuality, ShakeSound } from "@dno/scene";
import { useChain } from "./chain/ChainProvider";
import { useT } from "./i18n/app";
import { Masthead, type View } from "./Masthead";
import { BoxView } from "./views/BoxView";
import { LeaderboardView } from "./views/LeaderboardView";
import { PairView, type PairIntent } from "./views/PairView";
import { ShelfView } from "./views/ShelfView";
import { SpecimensView } from "./views/SpecimensView";
import { WarehouseView } from "./views/WarehouseView";

export function App() {
  const chain = useChain();
  const t = useT();
  const quality = useMemo(detectQuality, []);
  const sound = useMemo(() => new ShakeSound(), []);
  const [view, setView] = useState<View>("shelf");
  const [tokenId, setTokenId] = useState(0);
  // The box the warehouse opens in front of: the one last looked at, when coming from it.
  const [focus, setFocus] = useState<number | null>(null);
  const [pair, setPair] = useState<[number, number] | null>(null);
  const [intent, setIntent] = useState<PairIntent | null>(null);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    sound.muted = muted;
  }, [sound, muted]);
  useEffect(() => () => sound.dispose(), [sound]);

  // The box view opens on one of the account's own boxes, once they are first known.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !chain.myBoxes.length) return;
    landed.current = true;
    setTokenId(chain.myBoxes[0]!);
  }, [chain.myBoxes]);

  const showBox = (id: number) => {
    setTokenId(id);
    setView("box");
  };
  const showWarehouse = () => {
    setFocus(tokenId);
    setView("warehouse");
  };
  const showPair = (a: number, b?: number, wanted: PairIntent | null = null) => {
    setPair(b === undefined ? [a, -1] : [a, b]);
    setIntent(wanted);
    setView("pair");
  };

  const { collection, mode } = chain;

  return (
    <div className="app">
      {view === "shelf" && <ShelfView quality={quality} sound={sound} onSelect={showBox} onPair={(id, wanted) => showPair(id, undefined, wanted)} />}
      {view === "box" && <BoxView quality={quality} sound={sound} tokenId={tokenId} onTokenChange={setTokenId} onPair={showPair} onShelf={() => setView("shelf")} onOverview={showWarehouse} />}
      {view === "warehouse" && <WarehouseView quality={quality} focus={focus} onInspect={showBox} />}
      {view === "pair" && <PairView quality={quality} sound={sound} initial={pair} intent={intent} onInspect={showBox} />}
      {view === "leaderboard" && <LeaderboardView quality={quality} sound={sound} onSelect={showBox} />}
      {view === "specimens" && <SpecimensView quality={quality} />}

      <Masthead
        view={view}
        onView={(v) => {
          // From the menu, the pair view offers both actions again.
          if (v === "pair") setIntent(null);
          setView(v);
        }}
      />

      <footer className="notice">
        <span>
          {chain.offline ? (
            t("footer.offline", { reason: chain.offline })
          ) : chain.connectError ? (
            chain.connectError
          ) : chain.unavailable ? (
            t("footer.unavailable", { mode: chain.unavailable })
          ) : mode === "mock" ? (
            t("footer.mock")
          ) : collection ? (
            <>
              {t("footer.chain.before", { chain: collection.chain })}
              {collection.explorerUrl ? (
                <a className="link" href={collection.explorerUrl} target="_blank" rel="noreferrer">
                  {shortAddress(collection.address)}
                </a>
              ) : (
                shortAddress(collection.address)
              )}
              {t("footer.chain.after")}
            </>
          ) : (
            t("footer.reading")
          )}
        </span>
        <button type="button" className="link" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
          {muted ? t("footer.soundOff") : t("footer.soundOn")}
        </button>
      </footer>
    </div>
  );
}
