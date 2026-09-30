import { useCallback, useEffect, useRef, useState } from "react";
import { buildBoxSpec, type CatSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { mockCat, mockDuel, type DuelOutcome } from "../mock/mockDepot";
import { PairScene, type PairSceneHandle } from "../scenes/Scenes";
import { Stage } from "./Stage";

const FIRST_PAIR: [number, number] = [42, 1337];

export function PairView({ quality, sound }: { quality: QualitySettings; sound: ShakeSound }) {
  const scene = useRef<PairSceneHandle>(null);
  const [[tokenA, tokenB], setPair] = useState(FIRST_PAIR);
  const [busy, setBusy] = useState<null | "duel" | "open">(null);
  const [duels, setDuels] = useState(0);
  const [outcome, setOutcome] = useState<DuelOutcome | null>(null);
  const [entangled, setEntangled] = useState(false);
  const [opened, setOpened] = useState<CatSpec[] | null>(null);

  const serial = (id: number) => buildBoxSpec(id).serial;

  const onDuelDone = useCallback(() => {
    setBusy(null);
    setDuels((n) => n + 1);
  }, []);
  const onOpened = useCallback(() => setBusy(null), []);

  useEffect(() => {
    if (duels > 0) setOutcome(mockDuel(tokenA, tokenB, duels - 1));
  }, [duels, tokenA, tokenB]);

  const duel = () => {
    if (busy) return;
    sound.resume();
    setBusy("duel");
    setOutcome(null);
    scene.current?.duel(mockDuel(tokenA, tokenB, duels).aWins);
  };

  const entangle = () => {
    sound.resume();
    setEntangled(true);
    scene.current?.entangle();
  };

  const open = () => {
    if (busy) return;
    sound.resume();
    setBusy("open");
    const cats = entangled ? [mockCat(tokenA), mockCat(tokenB)] : [mockCat(tokenA)];
    setOpened(cats);
    scene.current?.open(cats[0]!, cats[1] ?? null);
  };

  const nextPair = () => {
    setPair(([a, b]) => [a + 2, b + 2]);
    setBusy(null);
    setDuels(0);
    setOutcome(null);
    setEntangled(false);
    setOpened(null);
  };

  const done = opened && !busy;

  return (
    <>
      <Stage quality={quality}>
        <PairScene ref={scene} tokenA={tokenA} tokenB={tokenB} quality={quality} sound={sound} onDuelDone={onDuelDone} onOpened={onOpened} />
      </Stage>

      <section className="slip" aria-label="Two boxes">
        <div className="slip-head">
          <span>Two consignments</span>
          {entangled && <span className="tier tier-entangled">Entangled</span>}
        </div>
        <p className="serial pair">
          {serial(tokenA)} <span>and</span> {serial(tokenB)}
        </p>

        {done ? (
          <>
            <ul className="results">
              {opened.map((cat, i) => (
                <li key={cat.seed}>
                  <strong>{serial(i === 0 ? tokenA : tokenB)}</strong>: {cat.state} {cat.traits.breed.name.toLowerCase()}, {cat.rarity.tierName.toLowerCase()} ({cat.rarity.score}).
                </li>
              ))}
            </ul>
            <p className="fine after-table">
              {opened.length === 2 ? "One holder looked, and both boxes opened. That was the deal." : `${serial(tokenB)} is still sealed.`}
            </p>
            <button type="button" className="stamp-button" onClick={nextPair}>
              Next pair
            </button>
          </>
        ) : (
          <>
            <div className="actions">
              <button type="button" className="stamp-button" onClick={duel} disabled={!!busy || !!opened}>
                {busy === "duel" ? "Fighting…" : "Start a duel"}
              </button>
              <button type="button" className="plain-button" onClick={entangle} disabled={!!busy || entangled || !!opened}>
                {entangled ? "Entangled" : "Entangle them"}
              </button>
              <button type="button" className="plain-button" onClick={open} disabled={!!busy || !!opened}>
                {busy === "open" ? "Opening…" : `Open ${serial(tokenA)}`}
              </button>
            </div>
            <div className="felt" aria-live="polite">
              {outcome ? (
                <>
                  <p className="felt-line">
                    <strong>{serial(outcome.winner)}</strong> wins.
                  </p>
                  <p className="fine">
                    {serial(outcome.loser)} has to show one trait to everyone. {outcome.shown.traitName}: <strong>{outcome.shown.trait.name}</strong>. The winner shows nothing.
                  </p>
                </>
              ) : entangled ? (
                <p className="fine">Both holders agreed. Opening either box now opens both.</p>
              ) : (
                <p className="fine">A duel compares two hidden rarity scores and publishes only who won. Both holders have to agree to it.</p>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
