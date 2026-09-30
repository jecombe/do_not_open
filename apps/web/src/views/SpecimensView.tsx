import { useMemo, useState } from "react";
import { spec as gameSpec } from "@dno/game-spec";
import { buildCatSpec, FIXTURE_SEEDS } from "@dno/generator";
import type { QualitySettings } from "@dno/scene";
import { SpecimenScene } from "../scenes/Scenes";
import { Declaration } from "./Declaration";
import { Stage } from "./Stage";

export function SpecimensView({ quality }: { quality: QualitySettings }) {
  const [selected, setSelected] = useState(0);
  const [wellFed, setWellFed] = useState(false);
  const affection = wellFed ? gameSpec.affection.goldenThreshold + 1 : 0;
  const cats = useMemo(() => FIXTURE_SEEDS.map(({ seed }) => buildCatSpec({ seed, affection })), [affection]);

  return (
    <>
      <Stage quality={quality}>
        <SpecimenScene specs={cats} selected={selected} onSelect={setSelected} />
      </Stage>
      <section className="slip declaration" aria-label="Specimen declaration">
        <Declaration cat={cats[selected]!}>
          <label className="check">
            <input type="checkbox" checked={wellFed} onChange={(e) => setWellFed(e.target.checked)} />
            Affection above {gameSpec.affection.goldenThreshold} before opening
          </label>
          <div className="picker" role="group" aria-label="Specimens">
            {FIXTURE_SEEDS.map((f, i) => (
              <button type="button" key={f.label} aria-pressed={i === selected} onClick={() => setSelected(i)}>
                {f.label}
              </button>
            ))}
          </div>
        </Declaration>
      </section>
    </>
  );
}
