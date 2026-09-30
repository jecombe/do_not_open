import { useMemo, useState } from "react";
import { spec as gameSpec } from "@dno/game-spec";
import { buildCatSpec, FIXTURE_SEEDS } from "@dno/generator";
import type { QualitySettings } from "@dno/scene";
import { useT } from "../i18n/app";
import { cap, catNames, viceName } from "../i18n/names";
import { SpecimenScene } from "../scenes/Scenes";
import { Declaration } from "./Declaration";
import { Stage } from "./Stage";

/**
 * The fixtures, plus two cats with a vice. Vices are rare (about 1% of cats) and none of
 * the fixtures has one, so without these the Condition trait would never show here.
 * Each is a fixture with only its cosmetic byte changed, so the rest of the cat is the same.
 */
const SPECIMENS: readonly { label: string; seed: bigint }[] = [
  ...FIXTURE_SEEDS,
  { label: "Stoned tabby", seed: 0x2a19465f141e2ee0n },
  { label: "Drunk void", seed: 0x62f5c8bef5d70bb8n },
];

export function SpecimensView({ quality }: { quality: QualitySettings }) {
  const t = useT();
  const [selected, setSelected] = useState(0);
  const [wellFed, setWellFed] = useState(false);
  const affection = wellFed ? gameSpec.affection.goldenThreshold + 1 : 0;
  const cats = useMemo(() => SPECIMENS.map(({ seed }) => buildCatSpec({ seed, affection })), [affection]);

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
          <div className="specimen-nav">
            <div className="stepper">
              <button type="button" onClick={() => setSelected((i) => Math.max(0, i - 1))} disabled={selected === 0} aria-label={t("specimens.prev")}>
                ‹
              </button>
              <button type="button" onClick={() => setSelected((i) => Math.min(cats.length - 1, i + 1))} disabled={selected === cats.length - 1} aria-label={t("specimens.next")}>
                ›
              </button>
            </div>
            <span className="fine">{t("specimens.count", { n: selected + 1, total: cats.length })}</span>
          </div>
          <div className="picker" role="group" aria-label={t("specimens.picker")}>
            {cats.map((cat, i) => {
              const { state, breed } = catNames(cat);
              return (
                <button type="button" key={SPECIMENS[i]!.label} aria-pressed={i === selected} onClick={() => setSelected(i)}>
                  {cap(t("specimens.label", { state: state.toLowerCase(), breed: breed.toLowerCase() }))}
                  {cat.vice !== "none" && `, ${viceName(cat.vice).toLowerCase()}`}
                </button>
              );
            })}
          </div>
          <p className="fine after-table">
            <span className="hint-pointer">{t("specimens.hint")}</span>
            <span className="hint-touch">{t("specimens.hintTouch")}</span>
          </p>
        </Declaration>
      </section>
    </>
  );
}
