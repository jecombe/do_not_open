import { useEffect, useMemo, useRef, useState } from "react";
import { shortAddress } from "@dno/chain-adapter";
import { detectQuality, ShakeSound } from "@dno/scene";
import { useChain } from "./chain/ChainProvider";
import { Clerk } from "./chat/Clerk";
import { useT } from "./i18n/app";
import { Masthead, type View } from "./Masthead";
import { TermsGate } from "./terms/TermsGate";
import { BoxView } from "./views/BoxView";
import { DuelShelfView } from "./views/DuelShelfView";
import { ExchangeView } from "./views/ExchangeView";
import { onOpenExchange } from "./views/exchangeLink";
import { LeaderboardView } from "./views/LeaderboardView";
import { PairView, type PairIntent } from "./views/PairView";
import { PantryView } from "./views/PantryView";
import { ShelfView } from "./views/ShelfView";
import { SpecimensView } from "./views/SpecimensView";
import { WarehouseView } from "./views/WarehouseView";

/** `app.html?box=42` opens straight on box 42: the link the share buttons hand out. */
const linkedBox = (() => {
  const raw = new URLSearchParams(window.location.search).get("box");
  const id = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
})();

export function App() {
  const chain = useChain();
  const t = useT();
  const quality = useMemo(detectQuality, []);
  const sound = useMemo(() => new ShakeSound(), []);
  const [view, setView] = useState<View>(linkedBox === null ? "shelf" : "box");
  const [tokenId, setTokenId] = useState(linkedBox ?? 0);
  // The box the warehouse opens in front of: the one last looked at, when coming from it.
  const [pair, setPair] = useState<[number, number] | null>(null);
  const [intent, setIntent] = useState<PairIntent | null>(null);
  // The box the duel shelf offers to put up, when coming from one.
  const [duelFocus, setDuelFocus] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    sound.muted = muted;
  }, [sound, muted]);
  useEffect(() => () => sound.dispose(), [sound]);
  // Any "buy" or "shield" link, anywhere, lands on the bureau de change.
  useEffect(() => onOpenExchange(() => setView("exchange")), []);

  // The box view opens on one of the account's own boxes, once they are first known.
  const landed = useRef(linkedBox !== null);
  useEffect(() => {
    if (landed.current || !chain.myBoxes.length) return;
    landed.current = true;
    setTokenId(chain.myBoxes[0]!);
  }, [chain.myBoxes]);

  // The address bar follows the box on screen, so it can be copied and sent as is.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "box") url.searchParams.set("box", String(tokenId));
    else url.searchParams.delete("box");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [view, tokenId]);

  // The view a box was opened from: its slip offers the way back there.
  const [cameFrom, setCameFrom] = useState<Exclude<View, "box"> | null>(null);
  const showBox = (id: number) => {
    if (view !== "box") setCameFrom(view);
    setTokenId(id);
    setView("box");
  };
  const showPair = (a: number, b?: number, wanted: PairIntent | null = null) => {
    setPair(b === undefined ? [a, -1] : [a, b]);
    setIntent(wanted);
    setView("pair");
  };
  /** The face-to-face page of the duels tab, offering both actions on the last pair shown. */
  const showFace = () => {
    setIntent(null);
    setView("pair");
  };
  const showDuels = (focus: number | null = null) => {
    setDuelFocus(focus);
    setView("duels");
  };

  const { collection, mode } = chain;

  return (
    <div className="app">
      {view === "shelf" && (
        <ShelfView quality={quality} sound={sound} onSelect={showBox} onPair={(id, wanted) => showPair(id, undefined, wanted)} onOpenPair={(a, b) => showPair(a, b, "duel")} onDuels={showDuels} />
      )}
      {view === "duels" && <DuelShelfView quality={quality} sound={sound} focus={duelFocus} onSelect={showBox} onFight={(mine, listed) => showPair(mine, listed, "duel")} onFace={showFace} />}
      {view === "box" && <BoxView quality={quality} sound={sound} tokenId={tokenId} onTokenChange={setTokenId} onPair={showPair} onShelf={() => setView("shelf")} backTo={cameFrom ?? "shelf"} onBack={() => setView(cameFrom ?? "shelf")} />}
      {view === "warehouse" && <WarehouseView quality={quality} focus={null} onInspect={showBox} />}
      {view === "pair" && <PairView quality={quality} sound={sound} initial={pair} intent={intent} onInspect={showBox} onShelf={() => showDuels()} />}
      {view === "pantry" && <PantryView quality={quality} sound={sound} onSelect={showBox} />}
      {view === "leaderboard" && <LeaderboardView quality={quality} sound={sound} onSelect={showBox} />}
      {view === "specimens" && <SpecimensView quality={quality} />}
      {view === "exchange" && <ExchangeView />}

      <Masthead
        view={view}
        onView={(v) => {
          if (v === "duels") setDuelFocus(null);
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
        <span className="notice-actions">
          {/* The manual opens in another tab: the game stays where it was. */}
          <Clerk newTab inline />
          <button type="button" className="link" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
            {muted ? t("footer.soundOff") : t("footer.soundOn")}
          </button>
        </span>
      </footer>
      <TermsGate />
    </div>
  );
}
