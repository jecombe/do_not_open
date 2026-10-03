import { duelUnderway, onShelf, type BoxStatus, type DuelInfo, type EntangleProposal } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { BoxTagSpec } from "@dno/scene";
import { t } from "../i18n/app";

/** "6 days left", rounded up: a duel posted a minute ago has its whole week ahead of it. */
export function timeLeftCopy(until: number, nowSeconds = Date.now() / 1000): string {
  const s = Math.max(0, until - nowSeconds);
  return s > 86_400 ? t("duels.daysLeft", { count: Math.ceil(s / 86_400) }) : t("duels.hoursLeft", { count: Math.max(1, Math.ceil(s / 3600)) });
}

/**
 * The paper tags a sealed box carries, from public facts only: the duel it is up for (open to all,
 * or aimed at one box), in, or challenged to; the box it is entangled with, or proposed to be;
 * and the duels it won. An open box carries none.
 */
export function boxTags(
  box: { tokenId: number; status: BoxStatus | null; partner: number | null; wins?: number },
  duels: readonly DuelInfo[],
  proposals: readonly EntangleProposal[] = [],
  nowSeconds = Date.now() / 1000,
): BoxTagSpec[] {
  if (box.status !== null && box.status !== "sealed") return [];
  const tags: BoxTagSpec[] = [];
  const own = duels.find(
    (d) => duelUnderway(d, nowSeconds) && (d.tokenA === box.tokenId || (d.status === "pending" && d.tokenB === box.tokenId)),
  );
  // A duel on the shelf reserved for this box: only it can take it up.
  const challenged = own ? undefined : duels.find((d) => onShelf(d, nowSeconds) && d.reserved && d.tokenB === box.tokenId);
  if (own) {
    const aimed = own.status === "open" && own.reserved && own.tokenB !== null;
    tags.push({
      kind: "duel",
      title: own.status !== "open" ? t("tag.duel") : aimed ? t("tag.duelAimed") : t("tag.duelOpenToAll"),
      detail:
        own.status === "pending"
          ? t("tag.duelPending")
          : own.status === "posted"
            ? t("tag.duelUnproven")
            : aimed
              ? t("tag.against", { serial: buildBoxSpec(own.tokenB!).serial })
              : own.openUntil !== null
                ? timeLeftCopy(own.openUntil, nowSeconds)
                : t("tag.duelOpen"),
    });
  } else if (challenged) {
    tags.push({ kind: "duel", title: t("tag.challenged"), detail: t("tag.by", { serial: buildBoxSpec(challenged.tokenA).serial }) });
  }
  const proposal = box.partner === null ? proposals.find((p) => p.from === box.tokenId || p.to === box.tokenId) : undefined;
  if (box.partner !== null) tags.push({ kind: "entangled", title: t("tag.entangled"), detail: t("tag.with", { serial: buildBoxSpec(box.partner).serial }) });
  else if (proposal) {
    const other = proposal.from === box.tokenId ? proposal.to : proposal.from;
    tags.push({ kind: "entangled", title: t("tag.linkProposed"), detail: t("tag.with", { serial: buildBoxSpec(other).serial }) });
  }
  if (box.wins) tags.push({ kind: "champion", title: t("tag.champion"), detail: t("tag.wins", { count: box.wins }) });
  return tags;
}
