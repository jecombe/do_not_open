import { useT } from "../i18n/app";

/** The duels tab holds two pages: the open shelf, and two boxes face to face (a duel or an entanglement). */
export function DuelTabs({ on, onSwitch }: { on: "shelf" | "face"; onSwitch: () => void }) {
  const t = useT();
  return (
    <div className="picker duel-tabs" role="group" aria-label={t("duels.tabs")}>
      <button type="button" aria-pressed={on === "shelf"} onClick={on === "shelf" ? undefined : onSwitch}>
        {t("duels.tab.shelf")}
      </button>
      <button type="button" aria-pressed={on === "face"} onClick={on === "face" ? undefined : onSwitch}>
        {t("duels.tab.face")}
      </button>
    </div>
  );
}
