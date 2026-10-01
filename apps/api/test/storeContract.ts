import { beforeEach, describe, expect, it } from "vitest";
import type { Store } from "../src/application/ports/store";
import * as B from "../src/domain/box";
import * as D from "../src/domain/duel";
import { ALICE, BOB, CAROL, ev } from "./fixtures";

/**
 * What any Store must do, run against each implementation: the in-memory one the tests use and
 * the Postgres one production uses must not drift apart.
 */
export function storeContract(name: string, make: () => Promise<Store>) {
  describe(`${name} store`, () => {
    let store: Store;
    beforeEach(async () => {
      store = await make();
    });

    it("starts empty", async () => {
      expect(await store.cursor()).toBeNull();
      expect(await store.tokenCount()).toBe(0);
      expect(await store.milestonesReached()).toBe(0);
      expect(await store.stats()).toEqual({ users: 0, registered: 0, minted: 0, opened: 0, duels: 0, openDuels: 0, events: 0 });
    });

    it("records an event once, and moves the cursor", async () => {
      const e = ev("Fed", 10, { tokenId: 1, feeder: ALICE });
      const firsts = await store.transaction(async (tx) => {
        const a = await tx.insertEvent(e);
        const b = await tx.insertEvent(e);
        await tx.setCursor(10);
        return [a, b];
      });
      expect(firsts).toEqual([true, false]);
      expect(await store.cursor()).toBe(10);
      await store.transaction((tx) => tx.setCursor(12));
      expect(await store.cursor()).toBe(12);
    });

    it("rolls back everything when a transaction throws", async () => {
      await expect(
        store.transaction(async (tx) => {
          await tx.insertEvent(ev("Fed", 10, { tokenId: 1, feeder: ALICE }));
          await tx.saveBox(B.minted(1, 10));
          await tx.setCursor(10);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await store.cursor()).toBeNull();
      expect(await store.box(1)).toBeNull();
      expect((await store.stats()).events).toBe(0);
    });

    it("round-trips boxes, and lists windows and openings", async () => {
      const contents = { seed: "18446744073709551615", state: 3, traits: [1, 2, 3, 4, 5], score: 2000, affection: 70000, golden: true };
      const weighIn = { weight: "123456789", build: "chubby" as const, sick: false, disease: null, tolerance: "999" };
      await store.transaction(async (tx) => {
        for (let i = 0; i < 4; i++) await tx.saveBox(B.minted(i, 100));
        await tx.saveBox(B.weighed(B.reveal(B.loseDuel(B.minted(2, 100), { traitIndex: 4, roll: 9 }), contents, ALICE, 150), weighIn));
        await tx.saveMint({ firstTokenId: 0, count: 4, buyer: ALICE, block: 100, txHash: "0x1" });
      });
      expect(await store.box(2)).toEqual({ ...B.minted(2, 100), status: "revealed", revealed: contents, openedBy: ALICE, openedBlock: 150, publicTraits: [{ traitIndex: 4, roll: 9 }], weighing: "done", weighIn });
      expect((await store.boxes(1, 3)).map((b) => b.tokenId)).toEqual([1, 2]);
      expect((await store.openedBoxes()).map((b) => b.tokenId)).toEqual([2]);
      expect(await store.tokenCount()).toBe(4);
    });

    it("finds duels by challenger, accepter, boxes and status, newest first", async () => {
      const at = { block: 10, timestamp: 1000 };
      await store.transaction(async (tx) => {
        await tx.saveDuel(D.challenge({ duelId: 0, tokenA: 1, tokenB: 2, challenger: ALICE }, at));
        await tx.saveDuel(D.accept(D.challenge({ duelId: 1, tokenA: 3, tokenB: 1, challenger: BOB }, at), CAROL, { block: 11, timestamp: 1012 }));
        await tx.saveDuel(D.resolve(D.challenge({ duelId: 2, tokenA: 4, tokenB: 5, challenger: ALICE }, at), { winner: 4, loser: 5, shown: { traitIndex: 0, roll: 1 } }, at));
      });
      const ids = (list: D.Duel[]) => list.map((d) => d.duelId);
      expect(ids(await store.duels({ account: ALICE, limit: 10 }))).toEqual([2, 0]);
      expect(ids(await store.duels({ account: CAROL, limit: 10 }))).toEqual([1]);
      expect(ids(await store.duels({ tokenIds: [1], limit: 10 }))).toEqual([1, 0]);
      expect(ids(await store.duels({ account: BOB, tokenIds: [5], limit: 10 }))).toEqual([2, 1]);
      expect(ids(await store.duels({ account: ALICE, statuses: ["challenged", "pending"], limit: 10 }))).toEqual([0]);
      expect(ids(await store.duels({ account: ALICE, limit: 1 }))).toEqual([2]);
      expect(await store.duel(1)).toMatchObject({ accepter: CAROL, status: "pending", updatedAt: 1012, shown: null });
      expect((await store.duel(2))!.shown).toEqual({ traitIndex: 0, roll: 1 });
      expect(await store.stats()).toMatchObject({ duels: 3, openDuels: 2 });
    });

    it("keeps proposals, requests, milestones and receipts", async () => {
      await store.transaction(async (tx) => {
        await tx.saveProposal({ tokenA: 1, tokenB: 2, proposer: ALICE, block: 5 });
        await tx.saveProposal({ tokenA: 3, tokenB: 4, proposer: BOB, block: 6 });
        await tx.deleteProposal(3, 4);
        await tx.saveRequest({ requestId: 0, kind: "open", tokenId: 1, other: 2, requester: ALICE, status: "pending", placedBlock: 7, settledBlock: null });
        await tx.saveRequest({ requestId: 1, kind: "aliveCheck", tokenId: 1, other: null, requester: ALICE, status: "done", placedBlock: 7, settledBlock: 8 });
        await tx.saveMilestone({ index: 0, sold: 100, block: 9 });
        await tx.saveMilestone({ index: 0, sold: 100, block: 9 });
        await tx.saveTransfer({ tokenId: 1, from: ALICE, to: BOB, moved: "0xaa", block: 9, timestamp: null, txHash: "0xt", logIndex: 2 });
        await tx.saveTransfer({ tokenId: 1, from: ALICE, to: BOB, moved: "0xaa", block: 9, timestamp: null, txHash: "0xt", logIndex: 2 });
      });
      expect(await store.proposal(1, 2)).toEqual({ tokenA: 1, tokenB: 2, proposer: ALICE, block: 5 });
      expect(await store.proposal(2, 1)).toBeNull();
      expect(await store.proposal(3, 4)).toBeNull();
      expect((await store.pendingRequests(ALICE)).map((r) => r.requestId)).toEqual([0]);
      expect(await store.milestonesReached()).toBe(1);
      expect(await store.transfers(BOB, 0, 10)).toEqual([{ tokenId: 1, from: ALICE, to: BOB, moved: "0xaa", block: 9, timestamp: null, txHash: "0xt", logIndex: 2 }]);
      expect(await store.transfers(CAROL, 0, 10)).toEqual([]);
    });

    it("filters the activity feed by box, actor and block", async () => {
      await store.transaction(async (tx) => {
        await tx.insertEvent(ev("MintPlaced", 1, { firstTokenId: 0, buyer: ALICE, count: 3 }));
        await tx.insertEvent(ev("Shaken", 2, { tokenId: 1, viewer: BOB, paid: true }));
        await tx.insertEvent(ev("Entangled", 3, { tokenA: 1, tokenB: 2 }));
      });
      const names = (list: { name: string }[]) => list.map((e) => e.name);
      expect(names(await store.activity({ limit: 10 }))).toEqual(["Entangled", "Shaken", "MintPlaced"]);
      expect(names(await store.activity({ tokenId: 2, limit: 10 }))).toEqual(["Entangled", "MintPlaced"]);
      expect(names(await store.activity({ account: BOB, limit: 10 }))).toEqual(["Shaken"]);
      expect(names(await store.activity({ beforeBlock: 3, limit: 1 }))).toEqual(["Shaken"]);
      const [shaken] = await store.activity({ account: BOB, limit: 1 });
      expect(shaken).toEqual(expect.objectContaining({ name: "Shaken", tokenId: 1, viewer: BOB, paid: true, block: 2, source: "collection" }));
    });

    it("keeps users, and hands each sign-in nonce out once", async () => {
      const u = { address: ALICE, firstBlock: 1, lastBlock: 9, firstSeenAt: 100, lastSeenAt: 900, actions: 4, registeredAt: null, lastLoginAt: null };
      await store.transaction((tx) => tx.saveUser(u));
      await store.saveUser({ ...u, registeredAt: 1000, lastLoginAt: 1000 });
      expect(await store.user(ALICE)).toEqual({ ...u, registeredAt: 1000, lastLoginAt: 1000 });
      expect(await store.stats()).toMatchObject({ users: 1, registered: 1 });

      await store.saveNonce(BOB, "n1", 50);
      await store.saveNonce(BOB, "n2", 60);
      expect(await store.takeNonce(BOB)).toEqual({ nonce: "n2", expiresAt: 60 });
      expect(await store.takeNonce(BOB)).toBeNull();
    });
  });
}
