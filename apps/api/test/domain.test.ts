import { describe, expect, it } from "vitest";
import * as B from "../src/domain/box";
import * as D from "../src/domain/duel";
import { actorsOf, byChainOrder, tokensOf } from "../src/domain/events";
import { settle, type Request } from "../src/domain/request";
import { loggedIn, seen } from "../src/domain/user";
import { ALICE, BOB, ev } from "./fixtures";

const at = (block: number, logIndex = 0) => ({ block, logIndex, timestamp: 1000 + block });

describe("duel", () => {
  const posted = D.post({ duelId: 1, tokenA: 3, tokenB: 0, reserved: false, challenger: ALICE }, at(10));
  const open = D.open(posted, 5000, at(11));

  it("goes posted, open, pending, resolved", () => {
    expect(posted).toMatchObject({ status: "posted", tokenB: null, openUntil: null });
    expect(open).toMatchObject({ status: "open", openUntil: 5000, updatedBlock: 11 });
    const accepted = D.accept(open, 7, BOB, at(12));
    expect(accepted).toMatchObject({ status: "pending", tokenB: 7, accepter: BOB, updatedBlock: 12 });
    const resolved = D.resolve(accepted, { winner: 3, loser: 7, shown: { traitIndex: 2, roll: 40 } }, at(13));
    expect(resolved).toMatchObject({ status: "resolved", winner: 3, loser: 7, shown: { traitIndex: 2, roll: 40 }, createdBlock: 10, updatedBlock: 13 });
  });

  it("goes back on the shelf when the taker did not hold their box, and can be taken up again", () => {
    const back = D.reopen(D.accept(open, 7, BOB, at(12)), at(13));
    expect(back).toMatchObject({ status: "open", tokenB: null, accepter: null, openUntil: 5000 });
    expect(D.accept(back, 8, BOB, at(14))).toMatchObject({ status: "pending", tokenB: 8 });
    const reserved = D.open(D.post({ duelId: 2, tokenA: 3, tokenB: 7, reserved: true, challenger: ALICE }, at(10)), 5000, at(11));
    expect(D.reopen(D.accept(reserved, 7, BOB, at(12)), at(13)).tokenB).toBe(7);
  });

  it("takes only newer events, and nothing after a final status", () => {
    const accepted = D.accept(open, 7, BOB, at(12, 3));
    expect(D.reopen(accepted, at(12, 3))).toBe(accepted);
    expect(D.reopen(accepted, at(12, 1))).toBe(accepted);
    expect(D.open(accepted, 6000, at(11))).toBe(accepted);
    expect(D.reopen(accepted, at(12, 4)).status).toBe("open");
    const resolved = D.resolve(accepted, { winner: 3, loser: 7, shown: { traitIndex: 0, roll: 1 } }, at(13));
    expect(D.accept(resolved, 7, BOB, at(14))).toBe(resolved);
    expect(D.cancel(resolved, at(14))).toBe(resolved);
    expect(D.voidDuel(resolved, at(14))).toBe(resolved);
    const cancelled = D.cancel(open, at(12));
    expect(D.accept(cancelled, 7, BOB, at(13))).toBe(cancelled);
  });

  it("tells open duels, the shelf, and the pairs that can settle one", () => {
    expect(D.isOpen(posted)).toBe(true);
    expect(D.isOpen(D.cancel(open, at(12)))).toBe(false);
    expect(D.onShelf(open, 5000)).toBe(true);
    expect(D.onShelf(open, 5001)).toBe(false);
    expect(D.onShelf(posted, 0)).toBe(false);
    // Open to all: any other box settles it with box 3, until it runs out of time.
    expect(D.settles(open, 9, 3, 4000)).toBe(true);
    expect(D.settles(open, 3, 9, 6000)).toBe(false);
    expect(D.settles(open, 7, 9, 4000)).toBe(false);
    const accepted = D.accept(open, 7, BOB, at(12));
    expect(D.settles(accepted, 7, 3, 9999)).toBe(true);
    expect(D.settles(accepted, 9, 3, 0)).toBe(false);
    const reserved = D.open(D.post({ duelId: 2, tokenA: 3, tokenB: 7, reserved: true, challenger: ALICE }, at(10)), 5000, at(11));
    expect(D.settles(reserved, 3, 7, 0)).toBe(true);
    expect(D.settles(reserved, 3, 8, 0)).toBe(false);
    expect(D.involves(accepted, 7)).toBe(true);
    expect(D.involves(open, 7)).toBe(false);
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
    expect(tokensOf(ev("DuelAccepted", 1, { duelId: 0, tokenB: 6, accepter: BOB }))).toEqual([6]);
    expect(actorsOf(ev("DuelAccepted", 1, { duelId: 0, tokenB: 6, accepter: BOB }))).toEqual([BOB]);
    expect(tokensOf(ev("DuelPosted", 1, { duelId: 0, tokenA: 2, tokenB: 0, challenger: ALICE, reserved: false }))).toEqual([2]);
    expect(tokensOf(ev("DuelPosted", 1, { duelId: 0, tokenA: 2, tokenB: 5, challenger: ALICE, reserved: true }))).toEqual([2, 5]);
    expect(actorsOf(ev("DuelPosted", 1, { duelId: 0, tokenA: 2, tokenB: 0, challenger: ALICE, reserved: false }))).toEqual([ALICE]);
  });

  it("sort in chain order", () => {
    const list = [ev("Fed", 2, { tokenId: 1, feeder: ALICE }, { logIndex: 0 }), ev("Fed", 1, { tokenId: 1, feeder: ALICE }, { logIndex: 5 }), ev("Fed", 1, { tokenId: 1, feeder: ALICE }, { logIndex: 2 })];
    expect([...list].sort(byChainOrder).map((e) => [e.block, e.logIndex])).toEqual([[1, 2], [1, 5], [2, 0]]);
  });
});
