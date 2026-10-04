import { beforeEach, describe, expect, it } from "vitest";
import type { ArchiveStore } from "../src/application/ports/archive";
import type { PostStore } from "../src/application/ports/herald";
import type { Store } from "../src/application/ports/store";
import * as B from "../src/domain/box";
import * as D from "../src/domain/duel";
import { ALICE, BOB, CAROL, ev } from "./fixtures";

/**
 * What any Store must do, run against each implementation: the in-memory one the tests use and
 * the Postgres one production uses must not drift apart.
 */
export function storeContract(name: string, make: () => Promise<Store & PostStore & ArchiveStore>) {
  describe(`${name} store`, () => {
    let store: Store & PostStore & ArchiveStore;
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
        const a = await tx.insertEvent(e, null);
        const b = await tx.insertEvent(e, null);
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
          await tx.insertEvent(ev("Fed", 10, { tokenId: 1, feeder: ALICE }), null);
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

    it("finds duels by challenger, accepter, boxes, status and time left, newest first", async () => {
      const at = (block: number, logIndex = 0) => ({ block, logIndex, timestamp: 1000 + block });
      const post = (duelId: number, tokenA: number, challenger: string, tokenB: number | null = null) =>
        D.post({ duelId, tokenA, tokenB, reserved: tokenB !== null, challenger }, at(10));
      await store.transaction(async (tx) => {
        await tx.saveDuel(D.open(post(0, 1, ALICE, 2), 5000, at(10, 1)));
        await tx.saveDuel(D.accept(D.open(post(1, 3, BOB), 5000, at(10, 1)), 1, CAROL, at(12)));
        await tx.saveDuel(D.resolve(D.accept(D.open(post(2, 4, ALICE), 5000, at(10, 1)), 5, BOB, at(11)), { winner: 4, loser: 5, shown: { traitIndex: 0, roll: 1 } }, at(12)));
        // On the shelf for anyone, out of time at 4000.
        await tx.saveDuel(D.open(post(3, 6, BOB), 4000, at(10, 1)));
      });
      const ids = (list: D.Duel[]) => list.map((d) => d.duelId);
      expect(ids(await store.duels({ account: ALICE, limit: 10 }))).toEqual([2, 0]);
      expect(ids(await store.duels({ account: CAROL, limit: 10 }))).toEqual([1]);
      expect(ids(await store.duels({ tokenIds: [1], limit: 10 }))).toEqual([1, 0]);
      expect(ids(await store.duels({ account: BOB, tokenIds: [5], limit: 10 }))).toEqual([3, 2, 1]);
      expect(ids(await store.duels({ account: ALICE, statuses: ["posted", "open", "pending"], limit: 10 }))).toEqual([0]);
      expect(ids(await store.duels({ account: ALICE, limit: 1 }))).toEqual([2]);
      expect(ids(await store.duels({ statuses: ["open"], limit: 10 }))).toEqual([3, 0]);
      expect(ids(await store.duels({ statuses: ["open"], inTimeAt: 4500, limit: 10 }))).toEqual([0]);
      expect(ids(await store.duels({ inTimeAt: 4500, limit: 10 }))).toEqual([2, 1, 0]);
      expect(await store.duel(1)).toMatchObject({ tokenB: 1, reserved: false, accepter: CAROL, status: "pending", openUntil: 5000, updatedAt: 1012, updatedLog: 0, shown: null });
      expect(await store.duel(0)).toMatchObject({ tokenB: 2, reserved: true, updatedBlock: 10, updatedLog: 1 });
      expect(await store.duel(3)).toMatchObject({ tokenB: null, reserved: false });
      expect((await store.duel(2))!.shown).toEqual({ traitIndex: 0, roll: 1 });
      expect(await store.stats()).toMatchObject({ duels: 4, openDuels: 3 });
    });

    it("keeps proposals, requests, milestones and receipts", async () => {
      await store.transaction(async (tx) => {
        await tx.saveProposal({ tokenA: 1, tokenB: 2, proposer: ALICE, block: 5 });
        await tx.saveProposal({ tokenA: 3, tokenB: 4, proposer: BOB, block: 6 });
        await tx.deleteProposal(3, 4);
        await tx.saveProposal({ tokenA: 5, tokenB: 1, proposer: BOB, block: 8 });
        await tx.saveRequest({ requestId: 0, kind: "open", tokenId: 1, other: 2, requester: ALICE, status: "pending", placedBlock: 7, settledBlock: null });
        await tx.saveRequest({ requestId: 1, kind: "aliveCheck", tokenId: 1, other: null, requester: ALICE, status: "done", placedBlock: 7, settledBlock: 8 });
        await tx.saveMilestone({ index: 0, sold: 100, block: 9 });
        await tx.saveMilestone({ index: 0, sold: 100, block: 9 });
        await tx.saveTransfer({ tokenId: 1, from: ALICE, to: BOB, moved: "0xaa", block: 9, blockHash: null, timestamp: null, txHash: "0xt", logIndex: 2 });
        await tx.saveTransfer({ tokenId: 1, from: ALICE, to: BOB, moved: "0xaa", block: 9, blockHash: null, timestamp: null, txHash: "0xt", logIndex: 2 });
      });
      expect(await store.proposal(1, 2)).toEqual({ tokenA: 1, tokenB: 2, proposer: ALICE, block: 5 });
      expect(await store.proposal(2, 1)).toBeNull();
      expect(await store.proposal(3, 4)).toBeNull();
      expect((await store.proposals([1], 10)).map((p) => [p.tokenA, p.tokenB])).toEqual([[5, 1], [1, 2]]);
      expect((await store.proposals([2, 4], 10)).map((p) => [p.tokenA, p.tokenB])).toEqual([[1, 2]]);
      expect(await store.proposals([1], 1)).toEqual([{ tokenA: 5, tokenB: 1, proposer: BOB, block: 8 }]);
      expect((await store.pendingRequests(ALICE)).map((r) => r.requestId)).toEqual([0]);
      expect(await store.milestonesReached()).toBe(1);
      expect(await store.transfers(BOB, 0, 10)).toEqual([{ tokenId: 1, from: ALICE, to: BOB, moved: "0xaa", block: 9, blockHash: null, timestamp: null, txHash: "0xt", logIndex: 2 }]);
      expect(await store.transfers(CAROL, 0, 10)).toEqual([]);
    });

    it("filters the activity feed by box, actor and block", async () => {
      await store.transaction(async (tx) => {
        await tx.insertEvent(ev("MintPlaced", 1, { firstTokenId: 0, buyer: ALICE, count: 3 }), null);
        await tx.insertEvent(ev("Shaken", 2, { tokenId: 1, viewer: BOB, paid: true }), null);
        await tx.insertEvent(ev("Entangled", 3, { tokenA: 1, tokenB: 2 }), null);
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

    it("files one release form per address and version, and keeps the first", async () => {
      const a = { address: ALICE, version: "v1", hash: "ab".repeat(32), message: "m1", signature: "0x01", receivedAt: 100 };
      expect(await store.saveTermsAcceptance(a)).toBeNull();
      expect(await store.saveTermsAcceptance({ ...a, signature: "0x02", receivedAt: 200 })).toEqual(a);
      await store.saveTermsAcceptance({ ...a, version: "v2", receivedAt: 300 });
      expect((await store.termsAcceptances(ALICE)).map((x) => [x.version, x.signature])).toEqual([["v1", "0x01"], ["v2", "0x01"]]);
      expect(await store.termsAcceptances(BOB)).toEqual([]);
    });

    it("stores events with their enrichment, pages them in chain order, and deletes them by key", async () => {
      const contents = { seed: "1", state: 0, traits: [1, 2, 3, 4, 5], score: 9, affection: 4, golden: false };
      const a = ev("Observed", 20, { tokenId: 1, openedBy: ALICE, seed: "1", state: 0, score: 9, golden: false }, { logIndex: 3 });
      const b = ev("Fed", 20, { tokenId: 1, feeder: ALICE }, { logIndex: 1 });
      const c = ev("Fed", 21, { tokenId: 2, feeder: BOB });
      await store.transaction(async (tx) => {
        await tx.insertEvent(a, { contents });
        await tx.insertEvent(c, null);
        await tx.insertEvent(b, null);
      });
      const page = await store.transaction((tx) => tx.storedEvents(null, 2));
      expect(page.map((p) => [p.event.block, p.event.logIndex])).toEqual([[20, 1], [20, 3]]);
      expect(page[1]).toEqual({ event: a, enrichment: { contents } });
      const rest = await store.transaction((tx) => tx.storedEvents({ block: 20, logIndex: 3 }, 10));
      expect(rest.map((p) => p.event)).toEqual([c]);

      const between = await store.transaction((tx) => tx.eventsBetween(20, 20));
      expect(between.sort((x, y) => x.key.localeCompare(y.key))).toEqual(
        [a, b].map((e) => ({ key: `${e.txHash}:${e.logIndex}`, blockHash: e.blockHash })).sort((x, y) => x.key.localeCompare(y.key)),
      );
      expect(await store.transaction((tx) => tx.deleteEvents([`${a.txHash}:${a.logIndex}`, "0xnope:0"]))).toBe(1);
      expect((await store.stats()).events).toBe(2);
    });

    it("empties the read models but keeps the events and the sign-ins", async () => {
      await store.transaction(async (tx) => {
        await tx.insertEvent(ev("Fed", 10, { tokenId: 1, feeder: ALICE }), null);
        await tx.saveBox(B.minted(1, 10));
        await tx.saveDuel(D.post({ duelId: 0, tokenA: 1, tokenB: null, reserved: false, challenger: ALICE }, { block: 10, logIndex: 0, timestamp: null }));
        await tx.saveMint({ firstTokenId: 0, count: 2, buyer: ALICE, block: 10, txHash: "0x1" });
        await tx.saveUser({ address: ALICE, firstBlock: 10, lastBlock: 10, firstSeenAt: 1, lastSeenAt: 1, actions: 1, registeredAt: null, lastLoginAt: null });
        await tx.saveUser({ address: BOB, firstBlock: 10, lastBlock: 10, firstSeenAt: 1, lastSeenAt: 1, actions: 2, registeredAt: 50, lastLoginAt: 60 });
        await tx.resetReadModels();
      });
      expect(await store.box(1)).toBeNull();
      expect(await store.duel(0)).toBeNull();
      expect(await store.tokenCount()).toBe(0);
      expect(await store.user(ALICE)).toBeNull();
      expect(await store.user(BOB)).toEqual({ address: BOB, firstBlock: null, lastBlock: null, firstSeenAt: null, lastSeenAt: null, actions: 0, registeredAt: 50, lastLoginAt: 60 });
      expect((await store.stats()).events).toBe(1);
    });

    it("keeps the finalized cursor and who served which blocks", async () => {
      await store.transaction(async (tx) => {
        await tx.setFinalizedCursor(40);
        await tx.saveRange(10, 20, ["rpc-a"]);
        await tx.saveRange(21, 30, ["rpc-b", "rpc-c"]);
        await tx.saveRange(31, 30, ["ignored"]);
      });
      expect(await store.finalizedCursor()).toBe(40);
      expect((await store.servedBy(15, 25)).sort()).toEqual(["rpc-a", "rpc-b", "rpc-c"]);
      expect(await store.servedBy(31, 99)).toEqual([]);
      await store.transaction((tx) => tx.pruneRanges(20));
      expect((await store.servedBy(0, 99)).sort()).toEqual(["rpc-b", "rpc-c"]);
    });

    it("keeps published handles and credits as read models, and the relayer meter across replays", async () => {
      const h = "0x" + "ab".repeat(32);
      await store.transaction(async (tx) => {
        await tx.savePublished([h, h], ALICE, 5);
        await tx.addCredits(BOB, 100);
        await tx.addCredits(BOB, 50);
      });
      expect(await store.publishedAmong([h.toUpperCase().replace("0X", "0x"), "0x" + "cd".repeat(32)])).toEqual([h]);
      expect(await store.creditsBought(BOB)).toBe(150);

      const day = "2026-10-02";
      expect(await store.meterOf(BOB, day)).toEqual({ freeUsed: 0, spent: 0, bought: 150 });
      expect(await store.meter(BOB, day, (m) => (m.bought === 150 ? { free: 10, credits: 5 } : null))).toEqual({ free: 10, credits: 5 });
      expect(await store.meter(BOB, day, () => null)).toBeNull();
      expect(await store.meter(BOB, day, () => ({ free: -2, credits: 0 }))).toEqual({ free: -2, credits: 0 });
      expect(await store.meterOf(BOB, day)).toEqual({ freeUsed: 8, spent: 5, bought: 150 });
      expect(await store.meterOf(BOB, "2026-10-03")).toEqual({ freeUsed: 0, spent: 5, bought: 150 });

      // A replay folds the chain again: purchases and publications are rebuilt, what was used stays.
      await store.transaction((tx) => tx.resetReadModels());
      expect(await store.publishedAmong([h])).toEqual([]);
      expect(await store.meterOf(BOB, day)).toEqual({ freeUsed: 8, spent: 5, bought: 0 });
    });

    it("lists known ids, every pending request, and every open duel", async () => {
      const at = (logIndex: number) => ({ block: 1, logIndex, timestamp: null });
      await store.transaction(async (tx) => {
        await tx.saveDuel(D.post({ duelId: 3, tokenA: 1, tokenB: 2, reserved: true, challenger: ALICE }, at(0)));
        await tx.saveDuel(D.cancel(D.post({ duelId: 1, tokenA: 1, tokenB: null, reserved: false, challenger: BOB }, at(0)), at(1)));
        await tx.saveRequest({ requestId: 5, kind: "open", tokenId: 1, other: null, requester: ALICE, status: "pending", placedBlock: 1, settledBlock: null });
        await tx.saveRequest({ requestId: 2, kind: "open", tokenId: 1, other: null, requester: BOB, status: "pending", placedBlock: 1, settledBlock: null });
        await tx.saveRequest({ requestId: 4, kind: "open", tokenId: 1, other: null, requester: BOB, status: "refused", placedBlock: 1, settledBlock: 2 });
      });
      expect(await store.knownDuelIds()).toEqual([1, 3]);
      expect(await store.knownRequestIds()).toEqual([2, 4, 5]);
      expect((await store.allPendingRequests()).map((r) => r.requestId)).toEqual([2, 5]);
      expect((await store.duels({ statuses: ["posted", "open", "pending"], limit: 10 })).map((d) => d.duelId)).toEqual([3]);
      expect((await store.duels({ limit: 10 })).map((d) => d.duelId)).toEqual([3, 1]);
    });

    it("queues the herald's posts once per fact, in order, and keeps where it read up to", async () => {
      expect(await store.heraldCursor("x")).toBeNull();
      const drafts = [
        { key: "opening:1", kind: "opening" as const, text: "one" },
        { key: "digest:2026-10-03", kind: "digest" as const, text: "", skipped: "nothing happened" },
        { key: "opening:2", kind: "opening" as const, text: "two" },
      ];
      expect(await store.queuePosts("x", drafts, { block: 5, logIndex: 2 }, 100)).toBe(2);
      expect(await store.queuePosts("x", drafts, { block: 6, logIndex: 0 }, 200)).toBe(0);
      expect(await store.heraldCursor("x")).toEqual({ block: 6, logIndex: 0 });
      expect(await store.hasPost("x", "digest:2026-10-03")).toBe(true);

      const first = await store.nextQueuedPost("x");
      expect(first).toMatchObject({ key: "opening:1", status: "queued", createdAt: 100, attempts: 0 });
      await store.updatePost(first!.id, { status: "posted", postedAt: 150, externalId: "9", url: "https://x.com/i/web/status/9" });
      expect((await store.nextQueuedPost("x"))!.key).toBe("opening:2");
      expect(await store.postedSince("x", 100)).toBe(1);
      expect(await store.postedSince("x", 151)).toBe(0);
      expect(await store.lastPostedAt("x")).toBe(150);
      expect((await store.posts(10)).map((p) => [p.key, p.status])).toEqual([
        ["opening:2", "queued"],
        ["digest:2026-10-03", "skipped"],
        ["opening:1", "posted"],
      ]);
    });

    it("keeps one queue, quota and cursor per network", async () => {
      await store.queuePosts("x", [{ key: "opening:1", kind: "opening", text: "one" }], { block: 5, logIndex: 0 }, 100);
      expect(await store.heraldCursor("discord")).toBeNull();
      expect(await store.queuePosts("discord", [{ key: "opening:1", kind: "opening", text: "one" }], { block: 7, logIndex: 1 }, 100)).toBe(1);
      expect(await store.heraldCursor("x")).toEqual({ block: 5, logIndex: 0 });
      expect(await store.heraldCursor("discord")).toEqual({ block: 7, logIndex: 1 });
      const discord = await store.nextQueuedPost("discord");
      expect(discord).toMatchObject({ network: "discord", key: "opening:1" });
      await store.updatePost(discord!.id, { status: "posted", postedAt: 150 });
      expect(await store.postedSince("discord", 100)).toBe(1);
      expect(await store.postedSince("x", 100)).toBe(0);
      expect(await store.lastPostedAt("x")).toBeNull();
      expect((await store.nextQueuedPost("x"))!.network).toBe("x");
      expect(await store.hasPost("discord", "opening:2")).toBe(false);
      expect((await store.posts(10, "discord")).map((p) => p.network)).toEqual(["discord"]);
      expect(await store.posts(10)).toHaveLength(2);
    });

    it("keeps the herald's posts through a replay", async () => {
      await store.queuePosts("x", [{ key: "opening:1", kind: "opening", text: "one" }], { block: 1, logIndex: 0 }, 1);
      await store.transaction((tx) => tx.resetReadModels());
      expect(await store.hasPost("x", "opening:1")).toBe(true);
      expect(await store.heraldCursor("x")).toEqual({ block: 1, logIndex: 0 });
    });

    it("remembers the images stored on Arweave, once each, through a replay", async () => {
      expect(await store.archivedImages(["a", "b"])).toEqual(new Map());
      await store.saveArchivedImage("a", "id-a", 1);
      await store.saveArchivedImage("a", "id-other", 2);
      await store.transaction((tx) => tx.resetReadModels());
      expect(await store.archivedImages(["a", "b"])).toEqual(new Map([["a", "id-a"]]));
      expect(await store.archivedImages([])).toEqual(new Map());
    });
  });
}
