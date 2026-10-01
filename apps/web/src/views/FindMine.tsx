import { useState } from "react";
import { useChain } from "../chain/ChainProvider";
import { useT } from "../i18n/app";

/**
 * Who holds a box is encrypted, even from this page. The account's boxes are found by
 * decrypting its own transfer receipts, which needs one signature per visit. Shown wherever
 * an action depends on knowing which boxes are the account's.
 */
export function FindMine({ compact = false }: { compact?: boolean }) {
  const { account, boxesKnown, findMyBoxes, findError } = useChain();
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (!account || boxesKnown) return null;

  const find = async () => {
    setBusy(true);
    await findMyBoxes();
    setBusy(false);
  };

  return (
    <div className="find-mine">
      {!compact && <p className="state-note">{t("mine.hidden")}</p>}
      <button type="button" className={compact ? "plain-button" : "stamp-button"} onClick={() => void find()} disabled={busy}>
        {busy ? t("mine.finding") : t("mine.find")}
      </button>
      <p className="fine">{findError ?? t("mine.why")}</p>
    </div>
  );
}
