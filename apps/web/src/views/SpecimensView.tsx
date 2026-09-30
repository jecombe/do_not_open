import { useMemo, useState } from "react";
import { spec as gameSpec } from "@dno/game-spec";
import { buildCatSpec, FIXTURE_SEEDS } from "@dno/generator";
import type { QualitySettings } from "@dno/scene";
import { useT } from "../i18n/app";
import { cap, catNames } from "../i18n/names";
import { SpecimenScene } from "../scenes/Scenes";
import { Declaration } from "./Declaration";
import { Stage } from "./Stage";

export function SpecimensView({ quality }: { quality: QualitySettings }) {
  const t = useT();
  const [selected, setSelected] = useState(0);
  const [wellFed, setWellFed] = useState(false);
  const affection = wellFed ? gameSpec.affection.goldenThreshold + 1 : 0;
  const cats = useMemo(() => FIXTURE_SEEDS.map(({ seed }) => buildCatSpec({ seed, affection })), [affection]);

  return (
    <>
      <Stage quality={quality}>
        <SpecimenScene specs={cats} selected={selected} onSelect={setSelected} />
      </Stage>
      <section className="slip declaration" aria-label={t("specimens.aria")}>
        <Declaration cat={cats[selected]!}>
          <label className="check">
            <input type="checkbox" checked={wellFed} onChange={(e) => setWellFed(e.target.checked)} />
            {t("specimens.wellFed", { n: gameSpec.affection.goldenThreshold })}
          </label>
          <div className="picker" role="group" aria-label={t("specimens.picker")}>
            {cats.map((cat, i) => {
              const { state, breed } = catNames(cat);
              return (
                <button type="button" key={FIXTURE_SEEDS[i]!.label} aria-pressed={i === selected} onClick={() => setSelected(i)}>
                  {cap(t("specimens.label", { state: state.toLowerCase(), breed: breed.toLowerCase() }))}
                </button>
              );
            })}
          </div>
        </Declaration>
      </section>
    </>
  );
}
