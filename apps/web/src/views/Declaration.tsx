import type { ReactNode } from "react";
import { spec as gameSpec } from "@dno/game-spec";
import type { CatSpec } from "@dno/generator";

const STATE_NOTES: Record<string, string> = {
  alive: "Alive. Annoyed about the box.",
  asleep: "Asleep. Slept through the whole shipment.",
  ghost: "Ghost. The box was sealed a long time.",
  quantum: "Quantum. Both, until you looked. Still both.",
};

const accessoryName = (cat: CatSpec) => {
  const base = gameSpec.traits.find((t) => t.key === "accessory")!.variants.find((v) => v.key === cat.accessory.key)!.name;
  return cat.accessory.golden ? `Golden ${base.toLowerCase()}` : base;
};

/** The customs form for an opened box: everything that is now public. */
export function Declaration({ cat, children }: { cat: CatSpec; children?: ReactNode }) {
  return (
    <>
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
              <td>{t.key === "accessory" ? accessoryName(cat) : t.name}</td>
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
      {children}
    </>
  );
}
