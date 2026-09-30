import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { spec as gameSpec } from "@dno/game-spec";
import { buildBoxSpec, buildCatSpec, FIXTURE_SEEDS } from "@dno/generator";
import { detectQuality, ShakeSound } from "@dno/scene";
import { mockShake, type ShakeResult } from "./mock/mockDepot";
import { DepotScene, SpecimenScene, type DepotHandle } from "./scenes/Scenes";

type View = "box" | "specimens";

const STATE_NOTES: Record<string, string> = {
  alive: "Alive. Annoyed about the box.",
  asleep: "Asleep. Slept through the whole shipment.",
  ghost: "Ghost. The box was sealed a long time.",
  quantum: "Quantum. Both, until you looked. Still both.",
};

export function App() {
  const quality = useMemo(detectQuality, []);
  const sound = useMemo(() => new ShakeSound(), []);
  const depot = useRef<DepotHandle>(null);

  const [view, setView] = useState<View>("box");
  const [tokenId, setTokenId] = useState(42);
  const [shakes, setShakes] = useState(0);
  const [shaking, setShaking] = useState(false);
  const [felt, setFelt] = useState<ShakeResult | null>(null);
  const [muted, setMuted] = useState(false);
  const [selected, setSelected] = useState(0);
  const [wellFed, setWellFed] = useState(false);

  useEffect(() => {
    sound.muted = muted;
  }, [sound, muted]);
  useEffect(() => () => sound.dispose(), [sound]);

  const box = useMemo(() => buildBoxSpec(tokenId), [tokenId]);
  const fedCount = gameSpec.affection.goldenThreshold + 1;
  const cats = useMemo(
    () => FIXTURE_SEEDS.map(({ seed }) => buildCatSpec({ seed, affection: wellFed ? fedCount : 0 })),
    [wellFed, fedCount],
  );
  const cat = cats[selected]!;

  const changeBox = (delta: number) => {
    const max = gameSpec.collection.maxSupply;
    setTokenId((id) => (id + delta + max) % max);
    setFelt(null);
    setShakes(0);
  };

  const shake = () => {
    if (shaking) return;
    sound.resume();
    setShaking(true);
    setFelt(null);
    depot.current?.shake();
  };

  const onShakeDone = useCallback(() => {
    setShaking(false);
    setShakes((n) => n + 1);
  }, []);

  // The reveal of a shake result follows the count, so it always matches the shake that just ended.
  useEffect(() => {
    if (shakes > 0) setFelt(mockShake(tokenId, shakes));
  }, [shakes, tokenId]);

  return (
    <div className="app">
      <Canvas
        className="stage"
        shadows={quality.shadows}
        dpr={[1, quality.maxDpr]}
        camera={{ fov: 38, near: 0.1, far: 60, position: [5.5, 3.2, 8.5] }}
      >
        {view === "box" ? (
          <DepotScene ref={depot} tokenId={tokenId} quality={quality} sound={sound} onShakeDone={onShakeDone} />
        ) : (
          <SpecimenScene specs={cats} selected={selected} onSelect={setSelected} />
        )}
        {quality.postprocessing && (
          <EffectComposer>
            <Bloom intensity={0.4} luminanceThreshold={0.92} luminanceSmoothing={0.2} mipmapBlur />
            <Noise opacity={0.035} />
            <Vignette offset={0.25} darkness={0.72} />
          </EffectComposer>
        )}
      </Canvas>

      <header className="masthead">
        <h1 className="wordmark">Do not open</h1>
        <nav className="views" aria-label="Views">
          <button type="button" aria-pressed={view === "box"} onClick={() => setView("box")}>
            Sealed box
          </button>
          <button type="button" aria-pressed={view === "specimens"} onClick={() => setView("specimens")}>
            Opened specimens
          </button>
        </nav>
      </header>

      {view === "box" ? (
        <section className="slip" aria-label={`Box ${box.serial}`}>
          <div className="slip-head">
            <span>Consignment</span>
            <div className="stepper">
              <button type="button" onClick={() => changeBox(-1)} aria-label="Previous box">
                ‹
              </button>
              <button type="button" onClick={() => changeBox(1)} aria-label="Next box">
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
              <dt>Weight</dt>
              <dd>{box.weightKg.toFixed(1)} kg</dd>
            </div>
            <div>
              <dt>Contents</dt>
              <dd>Encrypted</dd>
            </div>
          </dl>
          <button type="button" className="stamp-button" onClick={shake} disabled={shaking}>
            {shaking ? "Shaking…" : "Shake the box"}
          </button>
          <div className="felt" aria-live="polite">
            {felt ? (
              <>
                <p className="felt-line">
                  {felt.traitName}: <strong>{felt.trait.name}</strong>
                </p>
                <p className="fine">Only the holder can read a shake. Each one picks a trait at random; whether the cat is alive stays sealed.</p>
              </>
            ) : (
              <p className="fine">Shaking tells you one thing about what is inside. It never tells you whether it is alive.</p>
            )}
          </div>
        </section>
      ) : (
        <section className="slip declaration" aria-label="Specimen declaration">
          <div className="slip-head">
            <span>Declaration of contents</span>
            <span className={`tier tier-${cat.rarity.tier}`}>{cat.rarity.tierName}</span>
          </div>
          <p className="serial small">{cat.seed}</p>
          <p className="state-note">{STATE_NOTES[cat.state]}</p>
          <table className="traits">
            <tbody>
              {Object.values(cat.traits).map((t) => (
                <tr key={t.key}>
                  <th scope="row">{gameSpec.traits.find((d) => d.key === t.key)!.name}</th>
                  <td>
                    {t.key === "accessory" && cat.accessory.golden && t.variant !== "none" ? "Golden " + t.name.toLowerCase() : t.name}
                  </td>
                  <td className="roll">{t.roll}</td>
                </tr>
              ))}
              <tr className="total">
                <th scope="row">Rarity score</th>
                <td />
                <td className="roll">{cat.rarity.score}</td>
              </tr>
            </tbody>
          </table>
          <label className="check">
            <input type="checkbox" checked={wellFed} onChange={(e) => setWellFed(e.target.checked)} />
            Fed {fedCount} times before opening
          </label>
          <div className="picker" role="group" aria-label="Specimens">
            {FIXTURE_SEEDS.map((f, i) => (
              <button type="button" key={f.label} aria-pressed={i === selected} onClick={() => setSelected(i)}>
                {f.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <footer className="notice">
        <span>Mock depot. No chain connected; seeds are local stand-ins.</span>
        <button type="button" className="link" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
          {muted ? "Sound is off" : "Sound is on"}
        </button>
      </footer>
    </div>
  );
}
