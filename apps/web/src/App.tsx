import { useEffect, useMemo, useRef, useState } from "react";
import { shortAddress } from "@dno/chain-adapter";
import { detectQuality, ShakeSound } from "@dno/scene";
import { useChain } from "./chain/ChainProvider";
import { useT, type AppKey } from "./i18n/app";
import { LangSwitch } from "./i18n/LangSwitch";
import { BoxView } from "./views/BoxView";
import { LeaderboardView } from "./views/LeaderboardView";
import { PairView } from "./views/PairView";
import { ShelfView } from "./views/ShelfView";
import { SpecimensView } from "./views/SpecimensView";

const VIEWS = [
  { key: "shelf", label: "nav.shelf" },
  { key: "box", label: "nav.box" },
  { key: "pair", label: "nav.pair" },
  { key: "leaderboard", label: "nav.leaderboard" },
  { key: "specimens", label: "nav.specimens" },
] as const satisfies readonly { key: string; label: AppKey }[];
type View = (typeof VIEWS)[number]["key"];

export function App() {
  const chain = useChain();
  const t = useT();
  const quality = useMemo(detectQuality, []);
  const sound = useMemo(() => new ShakeSound(), []);
  const [view, setView] = useState<View>("box");
  const [tokenId, setTokenId] = useState(0);
  const [pair, setPair] = useState<[number, number] | null>(null);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    sound.muted = muted;
  }, [sound, muted]);
  useEffect(() => () => sound.dispose(), [sound]);

  // Start on one of the account's own boxes, once, when they are first known.
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
  const showPair = (a: number, b?: number) => {
    setPair(b === undefined ? [a, -1] : [a, b]);
    setView("pair");
  };

  const { collection, account, mode } = chain;

  return (
    <div className="app">
      {view === "shelf" && <ShelfView quality={quality} sound={sound} onSelect={showBox} />}
      {view === "box" && <BoxView quality={quality} sound={sound} tokenId={tokenId} onTokenChange={setTokenId} onPair={showPair} onShelf={() => setView("shelf")} />}
      {view === "pair" && <PairView quality={quality} sound={sound} initial={pair} onInspect={showBox} />}
      {view === "leaderboard" && <LeaderboardView quality={quality} sound={sound} onSelect={showBox} />}
      {view === "specimens" && <SpecimensView quality={quality} />}

      <header className="masthead">
        <h1 className="wordmark">Do not open</h1>
        <nav className="views" aria-label={t("nav.views")}>
          {VIEWS.map((v) => (
            <button type="button" key={v.key} aria-pressed={view === v.key} onClick={() => setView(v.key)}>
              {t(v.label)}
            </button>
          ))}
          <a href="/docs.html">{t("nav.manual")}</a>
          {mode !== "mock" &&
            (account ? (
              <button type="button" className="wallet" onClick={() => void chain.disconnect()} title={t("nav.disconnect")}>
                {shortAddress(account)}
              </button>
            ) : (
              <button type="button" className="wallet" onClick={() => void chain.connect()}>
                {t("nav.connect")}
              </button>
            ))}
          <LangSwitch label={t("nav.language")} />
        </nav>
      </header>

      <footer className="notice">
        <span>
          {chain.offline ? (
            t("footer.offline", { reason: chain.offline })
          ) : chain.connectError ? (
            chain.connectError
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
