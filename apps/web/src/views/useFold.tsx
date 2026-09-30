import { useState } from "react";
import { useT } from "../i18n/app";

/**
 * On a phone the slip covers half the scene: this folds it down to its heading line.
 * Returns the class to add to the slip and the button to put at its top (shown on narrow screens only).
 * A folded slip keeps its heading line and anything marked `keep`. `startFolded` suits a slip that
 * is mostly reading matter over a scene worth seeing.
 */
export function useFold({ startFolded = false } = {}) {
  const t = useT();
  const [folded, setFolded] = useState(() => startFolded && window.matchMedia("(max-width: 700px)").matches);
  const button = (
    <button type="button" className="fold" aria-expanded={!folded} onClick={() => setFolded((f) => !f)}>
      {folded ? t("slip.unfold") : t("slip.fold")}
      <span aria-hidden="true">{folded ? " ▴" : " ▾"}</span>
    </button>
  );
  return { foldClass: folded ? " folded" : "", foldButton: button };
}
