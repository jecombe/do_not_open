import { beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/application/ports/logger";
import { SyncChain, type SyncOptions } from "../src/application/syncChain";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ALICE, BOB, CAROL, ev, FakeChain } from "./fixtures";

const OPTS: SyncOptions = { startBlock: 100, confirmations: 0, rescan: 3, maxBlocksPerPass: 1000 };

let chain: FakeChain;
let store: MemoryStore;
let sync: SyncChain;

beforeEach(() => {
  chain = new FakeChain();
  store = new MemoryStore();
  sync = new SyncChain(chain, store, OPTS, silentLogger);
});

const passUntilIdle = async () => {
  for (let i = 0; i < 50; i++) if (!(await sync.pass())) return;
  throw new Error("sync never settled");
};

describe("SyncChain", () => {
  it("indexes from the start block to the confirmed head and remembers where it stopped", async () => {
    chain.add(ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 3 }), ev("Fed", 105, { tokenId: 1, feeder: ALICE }));
    chain.head_ = 110;
    sync = new SyncChain(chain, store, { ...OPTS, confirmations: 2 }, silentLogger);
    const r = await sync.pass();
    expect(r).toMatchObject({ from: 100, to: 108, applied: 2, target: 108 });
    expect(await store.cursor()).toBe(108);
    expect(await store.tokenCount()).toBe(3);
    expect(await sync.pass()).toBeNull();
  });

  it("re-reads a few blocks behind the cursor, and projects nothing twice", async () => {
    chain.add(ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 1 }));
    await sync.pass();
    chain.add(ev("Shaken", 101, { tokenId: 0, viewer: BOB, paid: true }));
    const r = await sync.pass();
    expect(r).toMatchObject({ from: 100, to: 101, applied: 1 });
    expect((await store.user(ALICE))!.actions).toBe(1);
    expect((await store.stats()).events).toBe(2);
  });

  it("picks up a log a lagging node missed, on the next pass", async () => {
    const mint = ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 2 });
    const late = ev("AliveProven", 101, { tokenId: 1, alive: true });
    chain.add(mint, late);
    chain.hidden.add(late);
    await sync.pass();
    expect((await store.box(1))!.aliveCheck).toBe("none");
    chain.hidden.clear();
    chain.add(ev("Fed", 102, { tokenId: 0, feeder: ALICE }));
    await sync.pass();
    expect((await store.box(1))!.aliveCheck).toBe("alive");
  });

  it("keeps reading when a source covers less than the rescan window", async () => {
    chain.span = 2;
    chain.add(ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 1 }));
    chain.head_ = 120;
    await passUntilIdle();
    expect(await store.cursor()).toBe(120);
    chain.add(ev("Fed", 121, { tokenId: 0, feeder: ALICE }));
    await passUntilIdle();
    expect(await store.cursor()).toBe(121);
    expect((await store.stats()).events).toBe(2);
  });

  it("commits nothing when a read fails", async () => {
    chain.add(ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 1 }));
    chain.failNext = new Error("429");
    await expect(sync.pass()).rejects.toThrow("429");
    expect(await store.cursor()).toBeNull();
    await sync.pass();
    expect(await store.cursor()).toBe(100);
  });

  it("rolls the batch back when a projection fails half way", async () => {
    chain.add(ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 1 }), ev("Fed", 100, { tokenId: 0, feeder: ALICE }, { logIndex: 1 }));
    const original = store.transaction.bind(store);
    store.transaction = (run) =>
      original(async (tx) => {
        const insert = tx.insertEvent;
        let n = 0;
        tx.insertEvent = async (e, enrichment) => {
          if (++n === 2) throw new Error("disk full");
          return insert(e, enrichment);
        };
        return run(tx);
      });
    await expect(sync.pass()).rejects.toThrow("disk full");
    expect((await store.stats()).events).toBe(0);
    expect(await store.tokenCount()).toBe(0);
  });

  it("caps a pass, so a long catch-up commits as it goes", async () => {
    sync = new SyncChain(chain, store, { ...OPTS, maxBlocksPerPass: 10 }, silentLogger);
    chain.head_ = 135;
    const r = await sync.pass();
    expect(r).toMatchObject({ to: 109, target: 135 });
    await passUntilIdle();
    expect(await store.cursor()).toBe(135);
  });
});

describe("projection", () => {
  it("follows a duel from challenge to result, with the challenger read from the contract", async () => {
    chain.snapshots.duels.set(0, { tokenA: 0, tokenB: 1, challenger: ALICE, accepter: BOB, status: "resolved" });
    chain.add(
      ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 2 }),
      ev("DuelChallenged", 101, { duelId: 0, tokenA: 0, tokenB: 1 }),
      ev("DuelAccepted", 102, { duelId: 0 }),
      ev("DuelResolved", 103, { duelId: 0, winner: 1, loser: 0, traitIndex: 2, roll: 77 }),
    );
    await sync.pass();
    const duel = await store.duel(0);
    expect(duel).toMatchObject({ status: "resolved", challenger: ALICE, accepter: BOB, winner: 1, loser: 0, shown: { traitIndex: 2, roll: 77 } });
    expect((await store.box(1))!.wins).toBe(1);
    expect((await store.box(0))!.publicTraits).toEqual([{ traitIndex: 2, roll: 77 }]);
    // Both sides of a duel are users now, though the logs never named them.
    expect(await store.user(BOB)).not.toBeNull();
    expect((await store.user(ALICE))!.actions).toBe(2);
  });

  it("rebuilds a duel whose challenge it never saw, from the contract's view", async () => {
    sync = new SyncChain(chain, store, { ...OPTS, startBlock: 102 }, silentLogger);
    chain.snapshots.duels.set(4, { tokenA: 8, tokenB: 9, challenger: CAROL, accepter: BOB, status: "pending" });
    chain.add(ev("DuelChallenged", 101, { duelId: 4, tokenA: 8, tokenB: 9 }), ev("DuelAccepted", 102, { duelId: 4 }));
    await sync.pass();
    expect(await store.duel(4)).toMatchObject({ tokenA: 8, tokenB: 9, challenger: CAROL, accepter: BOB, status: "pending" });
  });

  it("does not count a duel's win twice when its result is replayed from another log", async () => {
    chain.snapshots.duels.set(0, { tokenA: 0, tokenB: 1, challenger: ALICE, accepter: BOB, status: "resolved" });
    chain.add(
      ev("DuelChallenged", 100, { duelId: 0, tokenA: 0, tokenB: 1 }),
      ev("DuelResolved", 101, { duelId: 0, winner: 0, loser: 1, traitIndex: 0, roll: 3 }),
      ev("DuelResolved", 102, { duelId: 0, winner: 0, loser: 1, traitIndex: 0, roll: 3 }),
    );
    await sync.pass();
    expect((await store.box(0))!.wins).toBe(1);
  });

  it("opens a box with its full contents, or falls back on the seed", async () => {
    chain.snapshots.contents.set(3, { seed: "8177263914793887761", state: 2, traits: [232, 155, 52, 122, 123], score: 1600, affection: 3, golden: false });
    chain.add(
      ev("Observed", 100, { tokenId: 3, openedBy: ALICE, seed: "8177263914793887761", state: 2, score: 1600, golden: false }),
      ev("Observed", 101, { tokenId: 4, openedBy: BOB, seed: "8177263914793887761", state: 2, score: 1600, golden: false }),
    );
    await sync.pass();
    expect((await store.box(3))!).toMatchObject({ status: "revealed", openedBy: ALICE, revealed: { affection: 3 } });
    // The seed alone decodes to the same rolls the contract stored.
    expect((await store.box(4))!.revealed).toMatchObject({ traits: [232, 155, 52, 122, 123], affection: 0 });
    expect((await store.openedBoxes()).map((b) => b.tokenId)).toEqual([3, 4]);
  });

  it("tracks requests from placement to settlement, with the other box from the view", async () => {
    chain.snapshots.requests.set(7, { kind: "entangle", status: "done", requester: BOB, tokenId: 2, other: 5 });
    chain.add(
      ev("EntangleProposed", 100, { tokenA: 2, tokenB: 5, proposer: ALICE }),
      ev("RequestPlaced", 101, { requestId: 7, tokenId: 2, requester: BOB, kind: "entangle" }),
      ev("RequestPlaced", 101, { requestId: 8, tokenId: 9, requester: BOB, kind: "open" }, { logIndex: 1 }),
    );
    await sync.pass();
    expect((await store.pendingRequests(BOB)).map((r) => [r.requestId, r.other])).toEqual([[7, 5], [8, null]]);
    expect(await store.proposal(2, 5)).toMatchObject({ proposer: ALICE });

    chain.add(ev("RequestSettled", 102, { requestId: 7, status: "done" }), ev("Entangled", 102, { tokenA: 2, tokenB: 5 }, { logIndex: 1 }));
    await sync.pass();
    expect((await store.pendingRequests(BOB)).map((r) => r.requestId)).toEqual([8]);
    expect(await store.proposal(2, 5)).toBeNull();
    expect((await store.box(2))!.partner).toBe(5);
    expect((await store.box(5))!.partner).toBe(2);
  });

  it("keeps a proposal when its entanglement was refused", async () => {
    chain.snapshots.requests.set(1, { kind: "entangle", status: "refused", requester: BOB, tokenId: 2, other: 5 });
    chain.add(
      ev("EntangleProposed", 100, { tokenA: 2, tokenB: 5, proposer: ALICE }),
      ev("RequestPlaced", 101, { requestId: 1, tokenId: 2, requester: BOB, kind: "entangle" }),
      ev("RequestSettled", 102, { requestId: 1, status: "refused" }),
    );
    await sync.pass();
    expect(await store.proposal(2, 5)).not.toBeNull();
  });

  it("records receipts, milestones, welcome bags and weigh-ins", async () => {
    chain.snapshots.weighIns.set(1, { weight: "1200", build: "huge", sick: true, disease: "arthritic", tolerance: "1100" });
    chain.add(
      ev("ConfidentialTransfer", 100, { tokenId: 1, from: "0x0000000000000000000000000000000000000000", to: ALICE, moved: "0xaa" }),
      ev("ConfidentialTransfer", 103, { tokenId: 1, from: ALICE, to: BOB, moved: "0xbb" }),
      ev("MilestoneReached", 103, { index: 0, sold: 100 }, { logIndex: 1 }),
      ev("WelcomeBag", 104, { tokenId: 1 }),
      ev("WeighInRequested", 105, { tokenId: 1 }),
      ev("Weighed", 106, { tokenId: 1, weight: "1200", build: 4, sick: true, disease: 1 }),
    );
    await sync.pass();
    expect((await store.transfers(ALICE, 0, 10)).map((t) => t.moved)).toEqual(["0xaa", "0xbb"]);
    expect((await store.transfers(ALICE, 100, 10)).map((t) => t.moved)).toEqual(["0xbb"]);
    expect((await store.transfers(BOB, 0, 10)).map((t) => t.moved)).toEqual(["0xbb"]);
    expect(await store.milestonesReached()).toBe(1);
    expect(await store.box(1)).toMatchObject({ welcomed: true, weighing: "done", weighIn: { build: "huge", sick: true, disease: "arthritic", tolerance: "1100" } });
  });
});
