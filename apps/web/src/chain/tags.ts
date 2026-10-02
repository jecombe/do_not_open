import { duelUnderway, type BoxStatus, type DuelInfo } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { BoxTagSpec } from "@dno/scene";
import { t } from "../i18n/app";

/** "6 days left", rounded up: a duel posted a minute ago has its whole week ahead of it. */
export function timeLeftCopy(until: number, nowSeconds = Date.now() / 1000): string {
  const s = Math.max(0, until - nowSeconds);
  return s > 86_400 ? t("duels.daysLeft", { count: Math.ceil(s / 86_400) }) : t("duels.hoursLeft", { count: Math.max(1, Math.ceil(s / 3600)) });
}

/**
 * The paper tags a sealed box carries, from public facts only: the duel it is up for, or in, and
 * the box it is entangled with. An open box carries none.
 */
export function boxTags(box: { tokenId: number; status: BoxStatus | null; partner: number | null }, duels: readonly DuelInfo[], nowSeconds = Date.now() / 1000): BoxTagSpec[] {
  if (box.status !== null && box.status !== "sealed") return [];
  const tags: BoxTagSpec[] = [];
  const duel = duels.find(
    (d) => duelUnderway(d, nowSeconds) && (d.tokenA === box.tokenId || (d.status === "pending" && d.tokenB === box.tokenId)),
  );
  if (duel) {
    tags.push({
      kind: "duel",
      title: t("tag.duel"),
      detail:
        duel.status === "pending"
          ? t("tag.duelPending")
          : duel.status === "posted"
            ? t("tag.duelUnproven")
            : duel.openUntil !== null
              ? timeLeftCopy(duel.openUntil, nowSeconds)
              : t("tag.duelOpen"),
    });
  }
  if (box.partner !== null) tags.push({ kind: "entangled", title: t("tag.entangled"), detail: t("tag.with", { serial: buildBoxSpec(box.partner).serial }) });
  return tags;
}
