import { TRAIT_KEYS } from "@dno/game-spec";
import { decodeSeed } from "@dno/generator";
import * as B from "../domain/box";
import * as D from "../domain/duel";
import { actorsOf, type EventOf, type ProtocolEvent, type Snapshots } from "../domain/events";
import { settle } from "../domain/request";
import type { Build, Disease, RevealedContents } from "../domain/types";
import { seen } from "../domain/user";
import type { ProjectionTx } from "./ports/store";

const BUILDS: Build[] = ["thin", "normal", "chubby", "fat", "huge"];
const DISEASES: Disease[] = ["diabetic", "arthritic", "fattyLiver"];

/**
 * Folds one event into the read models. Called once per event, in chain order, inside the
 * batch's transaction, and only for events not recorded before: replays never get here.
 * Each transition is still forward-only, so an event that arrives late does no harm.
 */
export async function project(e: ProtocolEvent, snapshots: Snapshots, tx: ProjectionTx): Promise<void> {
  for (const address of new Set(actorsOf(e))) {
    await tx.saveUser(seen(await tx.user(address), address, e));
  }
  switch (e.name) {
    case "MintPlaced":
      await tx.saveMint({ firstTokenId: e.firstTokenId, count: e.count, buyer: e.buyer, block: e.block, txHash: e.txHash });
      for (let id = e.firstTokenId; id < e.firstTokenId + e.count; id++) {
        if (!(await tx.box(id))) await tx.saveBox(B.minted(id, e.block));
      }
      return;
    case "MilestoneReached":
      return tx.saveMilestone({ index: e.index, sold: e.sold, block: e.block });
    case "ConfidentialTransfer":
      return tx.saveTransfer({ tokenId: e.tokenId, from: e.from, to: e.to, moved: e.moved, block: e.block, blockHash: e.blockHash, timestamp: e.timestamp, txHash: e.txHash, logIndex: e.logIndex });
    case "Observed":
      return updateBox(tx, e.tokenId, e.block, (b) => B.reveal(b, snapshots.contents.get(e.tokenId) ?? contentsFromEvent(e), e.openedBy, e.block));
    case "AliveProven":
      return updateBox(tx, e.tokenId, e.block, (b) => B.proveAlive(b, e.alive));
    case "EntangleProposed":
      return tx.saveProposal({ tokenA: e.tokenA, tokenB: e.tokenB, proposer: e.proposer, block: e.block });
    case "Entangled":
      await tx.deleteProposal(e.tokenA, e.tokenB);
      await updateBox(tx, e.tokenA, e.block, (b) => B.entangle(b, e.tokenB));
      return updateBox(tx, e.tokenB, e.block, (b) => B.entangle(b, e.tokenA));
    case "RequestPlaced": {
      if (await tx.request(e.requestId)) return;
      const snap = snapshots.requests.get(e.requestId);
      return tx.saveRequest({
        requestId: e.requestId,
        kind: e.kind,
        tokenId: e.tokenId,
        other: snap?.other ?? null,
        requester: e.requester,
        status: "pending",
        placedBlock: e.block,
        settledBlock: null,
      });
    }
    case "RequestSettled":
      return settleRequest(tx, e, snapshots);
    case "DuelChallenged": {
      const existing = await tx.duel(e.duelId);
      if (existing) return;
      const snap = snapshots.duels.get(e.duelId);
      const duel = D.challenge({ duelId: e.duelId, tokenA: e.tokenA, tokenB: e.tokenB, challenger: snap?.challenger ?? null }, e);
      await tx.saveDuel(duel);
      if (duel.challenger) await tx.saveUser(seen(await tx.user(duel.challenger), duel.challenger, e));
      return;
    }
    case "DuelAccepted": {
      const accepter = snapshots.duels.get(e.duelId)?.accepter ?? null;
      await updateDuel(tx, e, snapshots, (d) => D.accept(d, accepter, e));
      if (accepter) await tx.saveUser(seen(await tx.user(accepter), accepter, e));
      return;
    }
    case "DuelCancelled":
      return updateDuel(tx, e, snapshots, (d) => D.cancel(d, e));
    case "DuelVoided":
      return updateDuel(tx, e, snapshots, (d) => D.voidDuel(d, e));
    case "DuelResolved": {
      const shown = { traitIndex: e.traitIndex, roll: e.roll };
      const before = await tx.duel(e.duelId);
      await updateDuel(tx, e, snapshots, (d) => D.resolve(d, { winner: e.winner, loser: e.loser, shown }, e));
      // Only the first time this duel resolves: a box wins once per duel.
      if (before?.status === "resolved") return;
      await updateBox(tx, e.winner, e.block, B.winDuel);
      return updateBox(tx, e.loser, e.block, (b) => B.loseDuel(b, shown));
    }
    case "WelcomeBag":
      return updateBox(tx, e.tokenId, e.block, B.welcome);
    case "WeighInRequested":
      return updateBox(tx, e.tokenId, e.block, B.weighRequested);
    case "Weighed":
      return updateBox(tx, e.tokenId, e.block, (b) =>
        B.weighed(b, {
          weight: e.weight,
          build: BUILDS[e.build] ?? "normal",
          sick: e.sick,
          disease: e.sick ? (DISEASES[e.disease] ?? null) : null,
          tolerance: snapshots.weighIns.get(e.tokenId)?.tolerance ?? "0",
        }),
      );
    // Recorded in the activity feed and folded into their actors, nothing more to project.
    case "Shaken":
    case "Fed":
    case "MealServed":
    case "Purred":
    case "Claimed":
    case "Bought":
      return;
  }
}

/** A box this index never saw minted (it started after the mint) is created on first sight. */
async function updateBox(tx: ProjectionTx, tokenId: number, block: number, change: (b: B.Box) => B.Box): Promise<void> {
  const box = (await tx.box(tokenId)) ?? B.minted(tokenId, block);
  const next = change(box);
  if (next !== box || !(await tx.box(tokenId))) await tx.saveBox(next);
}

async function updateDuel(tx: ProjectionTx, e: { duelId: number; block: number; timestamp: number | null }, snapshots: Snapshots, change: (d: D.Duel) => D.Duel) {
  let duel = await tx.duel(e.duelId);
  if (!duel) {
    // Its challenge was missed (the index started later, or a node lagged): rebuild it from the view.
    const snap = snapshots.duels.get(e.duelId);
    if (!snap) return;
    duel = D.challenge({ duelId: e.duelId, tokenA: snap.tokenA, tokenB: snap.tokenB, challenger: snap.challenger }, e);
  }
  await tx.saveDuel(change(duel));
}

async function settleRequest(tx: ProjectionTx, e: EventOf<"RequestSettled">, snapshots: Snapshots): Promise<void> {
  let request = await tx.request(e.requestId);
  if (!request) {
    const snap = snapshots.requests.get(e.requestId);
    if (!snap) return;
    request = { requestId: e.requestId, kind: snap.kind, tokenId: snap.tokenId, other: snap.other, requester: snap.requester, status: "pending", placedBlock: e.block, settledBlock: null };
  }
  await tx.saveRequest(settle(request, e.status, e.block));
  // A settled entanglement consumes its proposal, whether or not the boxes got linked.
  if (request.kind === "entangle" && e.status === "done" && request.other !== null) await tx.deleteProposal(request.tokenId, request.other);
}

/** When `contentsOf` could not be read: the seed decodes to the same rolls; affection is unknown. */
function contentsFromEvent(e: EventOf<"Observed">): RevealedContents {
  const decoded = decodeSeed(BigInt(e.seed));
  return { seed: e.seed, state: e.state, traits: TRAIT_KEYS.map((k) => decoded.rolls[k]), score: e.score, affection: 0, golden: e.golden };
}
