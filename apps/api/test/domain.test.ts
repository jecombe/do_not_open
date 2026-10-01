import { describe, expect, it } from "vitest";
import * as B from "../src/domain/box";
import * as D from "../src/domain/duel";
import { actorsOf, byChainOrder, tokensOf } from "../src/domain/events";
import { settle, type Request } from "../src/domain/request";
import { loggedIn, seen } from "../src/domain/user";
import { ALICE, BOB, ev } from "./fixtures";

const at = (block: number) => ({ block, timestamp: 1000 + block });

describe("duel", () => {
  const challenged = D.challenge({ duelId: 1, tokenA: 3, tokenB: 7, challenger: ALICE }, at(10));

  it("goes challenged, pending, resolved", () => {
    const accepted = D.accept(challenged, BOB, at(11));
    expect(accepted).toMatchObject({ status: "pending", accepter: BOB, updatedBlock: 11 });
    const resolved = D.resolve(accepted, { winner: 3, loser: 7, shown: { traitIndex: 2, roll: 40 } }, at(12));
    expect(resolved).toMatchObject({ status: "resolved", winner: 3, loser: 7, shown: { traitIndex: 2, roll: 40 }, createdBlock: 10, updatedBlock: 12 });
  });

  it("never moves back: a late or replayed event changes nothing", () => {
    const resolved = D.resolve(challenged, { winner: 3, loser: 7, shown: { traitIndex: 0, roll: 1 } }, at(12));
    expect(D.accept(resolved, BOB, at(13))).toBe(resolved);
    expect(D.cancel(resolved, at(13))).toBe(resolved);
    expect(D.voidDuel(resolved, at(13))).toBe(resolved);
    const cancelled = D.cancel(challenged, at(11));
    expect(D.accept(cancelled, BOB, at(12))).toBe(cancelled);
  });

  it("can be voided once accepted, and cancelled only before", () => {
    expect(D.voidDuel(D.accept(challenged, BOB, at(11)), at(12)).status).toBe("void");
    expect(D.cancel(challenged, at(11)).status).toBe("cancelled");
  });

  it("tells open duels and the boxes involved", () => {
    expect(D.isOpen(challenged)).toBe(true);
    expect(D.isOpen(D.cancel(challenged, at(11)))).toBe(false);
    expect(D.involves(challenged, 7)).toBe(true);
    expect(D.involves(challenged, 8)).toBe(false);
    expect(D.between(challenged, 7, 3)).toBe(true);
    expect(D.between(challenged, 3, 8)).toBe(false);
  });
});

describe("box", () => {
  const box = B.minted(5, 100);

  it("is sealed and blank when minted", () => {
    expect(box).toMatchObject({ tokenId: 5, status: "sealed", aliveCheck: "none", partner: null, wins: 0, publicTraits: [], revealed: null });
  });

  it("is revealed once, keeping the first opener", () => {
    const contents = { seed: "1", state: 0, traits: [1, 2, 3, 4, 5], score: 9, affection: 0, golden: false };
    const open = B.reveal(box, contents, ALICE, 110);
    expect(open).toMatchObject({ status: "revealed", openedBy: ALICE, openedBlock: 110, revealed: contents });
    expect(B.reveal(open, { ...contents, seed: "2" }, BOB, 120)).toBe(open);
  });

  it("keeps one shown roll per trait, sorted", () => {
    let b = B.loseDuel(box, { traitIndex: 3, roll: 9 });
    b = B.loseDuel(b, { traitIndex: 1, roll: 4 });
    b = B.loseDuel(b, { traitIndex: 3, roll: 9 });
    expect(b.publicTraits).toEqual([{ traitIndex: 1, roll: 4 }, { traitIndex: 3, roll: 9 }]);
  });

  it("proves alive and entangles once", () => {
    expect(B.proveAlive(B.proveAlive(box, false), true).aliveCheck).toBe("notAlive");
    expect(B.entangle(B.entangle(box, 9), 11).partner).toBe(9);
  });

  it("weighs: pending, then done, never back to pending", () => {
    const w = { weight: "420", build: "fat" as const, sick: false, disease: null, tolerance: "900" };
    const done = B.weighed(B.weighRequested(box), w);
    expect(done).toMatchObject({ weighing: "done", weighIn: w });
    expect(B.weighRequested(done).weighing).toBe("done");
  });
});

describe("request", () => {
  const r: Request = { requestId: 1, kind: "open", tokenId: 4, other: null, requester: ALICE, status: "pending", placedBlock: 10, settledBlock: null };
  it("settles once", () => {
    const done = settle(r, "done", 12);
    expect(done).toMatchObject({ status: "done", settledBlock: 12 });
    expect(settle(done, "refused", 13)).toBe(done);
  });
});

describe("user", () => {
  it("is created on first sight and counts acts", () => {
    const u = seen(seen(null, ALICE, { block: 20, timestamp: 2000 }), ALICE, { block: 10, timestamp: 1000 });
    expect(u).toMatchObject({ address: ALICE, firstBlock: 10, lastBlock: 20, firstSeenAt: 2000, lastSeenAt: 2000, actions: 2, registeredAt: null });
  });

  it("keeps the first registration and stamps each login", () => {
    const u = loggedIn(loggedIn(null, BOB, 50), BOB, 80);
    expect(u).toMatchObject({ registeredAt: 50, lastLoginAt: 80, actions: 0 });
  });
});

describe("events", () => {
  it("name their actors and boxes", () => {
    expect(actorsOf(ev("MintPlaced", 1, { firstTokenId: 4, buyer: ALICE, count: 3 }))).toEqual([ALICE]);
    expect(tokensOf(ev("MintPlaced", 1, { firstTokenId: 4, buyer: ALICE, count: 3 }))).toEqual([4, 5, 6]);
    expect(tokensOf(ev("DuelResolved", 1, { duelId: 0, winner: 2, loser: 9, traitIndex: 0, roll: 1 }))).toEqual([2, 9]);
    expect(tokensOf(ev("DuelAccepted", 1, { duelId: 0 }))).toEqual([]);
    expect(actorsOf(ev("DuelAccepted", 1, { duelId: 0 }))).toEqual([]);
  });

  it("sort in chain order", () => {
    const list = [ev("Fed", 2, { tokenId: 1, feeder: ALICE }, { logIndex: 0 }), ev("Fed", 1, { tokenId: 1, feeder: ALICE }, { logIndex: 5 }), ev("Fed", 1, { tokenId: 1, feeder: ALICE }, { logIndex: 2 })];
    expect([...list].sort(byChainOrder).map((e) => [e.block, e.logIndex])).toEqual([[1, 2], [1, 5], [2, 0]]);
  });
});
