import type { ReactNode } from "react";
import type { CatSpec } from "@dno/generator";
import { useT } from "../i18n/app";
import { tierName, traitName, variantName, viceName } from "../i18n/names";

/** The customs form for an opened box: everything that is now public. */
export function Declaration({ cat, children }: { cat: CatSpec; children?: ReactNode }) {
  const t = useT();
  const accessory = variantName("accessory", cat.accessory.key);
  return (
    <>
      <div className="slip-head">
        <span>{t("decl.title")}</span>
        <span className={`tier tier-${cat.rarity.tier}`}>{tierName(cat.rarity.tier)}</span>
      </div>
      <p className="serial small">{cat.seed}</p>
      <p className="state-note">{t(`decl.note.${cat.state}`)}</p>
      <table className="traits">
        <tbody>
          {Object.values(cat.traits).map((r) => (
            <tr key={r.key}>
              <th scope="row">{traitName(r.key)}</th>
              <td>{r.key === "accessory" && cat.accessory.golden ? t("decl.golden", { name: accessory.toLowerCase() }) : variantName(r.key, r.variant)}</td>
              <td className="roll">{r.roll}</td>
            </tr>
          ))}
          {cat.vice !== "none" && (
            <tr>
              <th scope="row">{t("decl.condition")}</th>
              <td>{viceName(cat.vice)}</td>
              <td className="roll" />
            </tr>
          )}
          <tr className="total">
            <th scope="row">{t("decl.score")}</th>
            <td />
            <td className="roll">{cat.rarity.score}</td>
          </tr>
        </tbody>
      </table>
      {children}
    </>
  );
}
