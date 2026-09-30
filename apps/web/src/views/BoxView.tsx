import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { spec as gameSpec } from "@dno/game-spec";
import { buildBoxSpec, type CatSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { mockCat, mockFeedGain, mockShake, type TraitPeek } from "../mock/mockDepot";
import { BoxScene, type BoxSceneHandle } from "../scenes/Scenes";
import { Declaration } from "./Declaration";
import { Stage } from "./Stage";

type Busy = null | "shake" | "feed" | "open";

export function BoxView({ quality, sound }: { quality: QualitySettings; sound: ShakeSound }) {
  const scene = useRef<BoxSceneHandle>(null);
  const [tokenId, setTokenId] = useState(42);
  const [busy, setBusy] = useState<Busy>(null);
  const [shakes, setShakes] = useState(0);
  const [felt, setFelt] = useState<TraitPeek | null>(null);
  const [feeds, setFeeds] = useState(0);
  const [affection, setAffection] = useState(0);
  const [opened, setOpened] = useState<CatSpec | null>(null);

  const box = useMemo(() => buildBoxSpec(tokenId), [tokenId]);

  const changeBox = (delta: number) => {
    const max = gameSpec.collection.maxSupply;
    setTokenId((id) => (id + delta + max) % max);
    setBusy(null);
    setShakes(0);
    setFelt(null);
    setFeeds(0);
    setAffection(0);
    setOpened(null);
  };

  const act = (what: Exclude<Busy, null>, run: () => void) => {
    if (busy) return;
    sound.resume();
    setBusy(what);
    run();
  };

  const onShakeDone = useCallback(() => {
    setBusy(null);
    setShakes((n) => n + 1);
  }, []);
  const onFed = useCallback(() => {
    setBusy(null);
    setFeeds((n) => n + 1);
  }, []);
  const onOpened = useCallback(() => setBusy(null), []);

  // Results follow the counters, so they always belong to the action that just ended.
  useEffect(() => {
    if (shakes > 0) setFelt(mockShake(tokenId, shakes));
  }, [shakes, tokenId]);
  useEffect(() => {
    if (feeds > 0) setAffection((a) => a + mockFeedGain(tokenId, feeds));
  }, [feeds, tokenId]);

  const open = () =>
    act("open", () => {
      const cat = mockCat(tokenId, affection);
      setOpened(cat);
      scene.current?.open(cat);
    });

  const revealed = opened && busy !== "open";

  return (
    <>
      <Stage quality={quality}>
        <BoxScene ref={scene} tokenId={tokenId} quality={quality} sound={sound} onShakeDone={onShakeDone} onFed={onFed} onOpened={onOpened} />
      </Stage>

      <section className="slip" aria-label={`Box ${box.serial}`}>
        {revealed ? (
          <Declaration cat={opened}>
            <p className="fine after-table">
              {box.serial} is open for good.
              {opened.rarity.golden ? " It was fed enough to come out in gold." : feeds > 0 ? " The feeding was not quite enough for gold." : ""}
            </p>
            <button type="button" className="stamp-button" onClick={() => changeBox(1)}>
              Next box
            </button>
          </Declaration>
        ) : (
          <>
            <div className="slip-head">
              <span>Consignment</span>
              <div className="stepper">
                <button type="button" onClick={() => changeBox(-1)} aria-label="Previous box" disabled={!!busy}>
                  ‹
                </button>
                <button type="button" onClick={() => changeBox(1)} aria-label="Next box" disabled={!!busy}>
                  ›
                </button>
              </div>
            </div>
            <p className="serial">{box.serial}</p>
            <dl className="fields">
              <div>
                <dt>Dock</dt>
                <dd>{box.dock}</dd>
              </div>
              <div>
                <dt>Fed</dt>
                <dd>{feeds} ×</dd>
              </div>
              <div>
                <dt>Contents</dt>
                <dd>Encrypted</dd>
              </div>
            </dl>
            <div className="actions">
              <button type="button" className="stamp-button" onClick={() => act("shake", () => scene.current?.shake())} disabled={!!busy}>
                {busy === "shake" ? "Shaking…" : "Shake the box"}
              </button>
              <button type="button" className="plain-button" onClick={() => act("feed", () => scene.current?.feed())} disabled={!!busy}>
                {busy === "feed" ? "Feeding…" : "Feed it"}
              </button>
              <button type="button" className="plain-button" onClick={open} disabled={!!busy}>
                {busy === "open" ? "Opening…" : "Open the box"}
              </button>
            </div>
            <div className="felt" aria-live="polite">
              {felt ? (
                <>
                  <p className="felt-line">
                    {felt.traitName}: <strong>{felt.trait.name}</strong>
                  </p>
                  <p className="fine">Only you can read a shake. Whether the cat is alive stays sealed.</p>
                </>
              ) : feeds > 0 ? (
                <p className="fine">Fed {feeds} time{feeds > 1 ? "s" : ""}. How much affection that earned is encrypted; you find out when you open the box.</p>
              ) : (
                <p className="fine">Shaking tells you one trait. Feeding may turn its accessory golden. Opening cannot be undone.</p>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
