import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { FinalitySweep } from "../src/application/finalitySweep";
import { silentLogger, type Logger } from "../src/application/ports/logger";
import type { Store } from "../src/application/ports/store";
import { Reconciler } from "../src/application/reconcile";
import { replayAll } from "../src/application/replay";
import { SyncChain } from "../src/application/syncChain";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ALICE, BOB, CAROL, ev, FakeChain, FakeChainState, hashOf } from "./fixtures";

const START = 100;
let chain: FakeChain;
let state: FakeChainState;
let store: MemoryStore;
let sync: SyncChain;

beforeEach(() => {
  chain = new FakeChain();
  state = new FakeChainState();
  store = new MemoryStore();
  sync = new SyncChain(chain, store, { startBlock: START, confirmations: 0, rescan: 2, maxBlocksPerPass: 1000 }, silentLogger);
});

const indexAll = async () => {
  for (let i = 0; i < 50; i++) if (!(await sync.pass())) return;
};

/** Everything a reader can see, to compare two indexes. */
async function readModels(s: Store) {
  const tokens = await s.tokenCount();
  return {
    boxes: await s.boxes(0, tokens + 10),
    duels: await s.duels({ limit: 1000 }),
    pending: await s.allPendingRequests(),
    proposals: await Promise.all([s.proposal(2, 3), s.proposal(5, 6)]),
    users: await Promise.all([ALICE, BOB, CAROL].map((a) => s.user(a))),
    milestones: await s.milestonesReached(),
    transfers: await s.transfers(ALICE, 0, 100),
    tokens,
  };
}

/** A small history touching every read model. */
function history() {
  chain.snapshots.duels.set(0, { tokenA: 0, tokenB: 1, challenger: ALICE, accepter: BOB, status: "resolved" });
  chain.snapshots.duels.set(1, { tokenA: 2, tokenB: 1, challenger: BOB, accepter: null, status: "challenged" });
  chain.snapshots.contents.set(4, { seed: "8177263914793887761", state: 2, traits: [232, 155, 52, 122, 123], score: 1600, affection: 3, golden: false });
  chain.snapshots.requests.set(0, { kind: "open", status: "done", requester: ALICE, tokenId: 4, other: null });
  chain.snapshots.requests.set(1, { kind: "aliveCheck", status: "pending", requester: BOB, tokenId: 3, other: null });
  return [
    ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 6 }),
    ev("ConfidentialTransfer", 100, { tokenId: 0, from: "0x0000000000000000000000000000000000000000", to: ALICE, moved: "0x01" }, { logIndex: 1 }),
    ev("DuelChallenged", 103, { duelId: 0, tokenA: 0, tokenB: 1 }),
    ev("DuelAccepted", 106, { duelId: 0 }),
    ev("DuelResolved", 109, { duelId: 0, winner: 0, loser: 1, traitIndex: 1, roll: 50 }),
    ev("DuelChallenged", 112, { duelId: 1, tokenA: 2, tokenB: 1 }),
    ev("EntangleProposed", 115, { tokenA: 2, tokenB: 3, proposer: BOB }),
    ev("RequestPlaced", 118, { requestId: 0, tokenId: 4, requester: ALICE, kind: "open" }),
    ev("Observed", 121, { tokenId: 4, openedBy: ALICE, seed: "8177263914793887761", state: 2, score: 1600, golden: false }),
    ev("RequestSettled", 121, { requestId: 0, status: "done" }, { logIndex: 1 }),
    ev("RequestPlaced", 124, { requestId: 1, tokenId: 3, requester: BOB, kind: "aliveCheck" }),
    ev("MilestoneReached", 127, { index: 0, sold: 100 }),
    ev("AliveProven", 130, { tokenId: 5, alive: true }),
  ];
}

describe("replay", () => {
  it("rebuilds exactly what the incremental projection built, from the events table alone", async () => {
    chain.add(...history());
    await indexAll();
    const before = await readModels(store);
    // No chain: the enrichment stored with each event stands in for the views.
    chain.snapshots.duels.clear();
    chain.snapshots.contents.clear();
    chain.snapshots.requests.clear();
    const replayed = await store.transaction((tx) => replayAll(tx));
    expect(replayed).toBe(13);
    expect(await readModels(store)).toEqual(before);
    expect((await store.box(4))!.revealed).toMatchObject({ affection: 3 });
    expect((await store.duel(0))!.challenger).toBe(ALICE);
  });

  it("keeps users' sign-ins, and counts their on-chain acts again from scratch", async () => {
    chain.add(...history());
    await indexAll();
    const alice = (await store.user(ALICE))!;
    await store.saveUser({ ...alice, registeredAt: 5, lastLoginAt: 6 });
    await store.saveUser({ address: CAROL, firstBlock: null, lastBlock: null, firstSeenAt: null, lastSeenAt: null, actions: 0, registeredAt: 7, lastLoginAt: 7 });
    await store.transaction((tx) => replayAll(tx));
    expect(await store.user(ALICE)).toEqual({ ...alice, registeredAt: 5, lastLoginAt: 6 });
    expect(await store.user(CAROL)).toMatchObject({ registeredAt: 7, actions: 0 });
  });
});

describe("FinalitySweep", () => {
  const sweep = () => new FinalitySweep(chain, store, { startBlock: START, maxBlocks: 1000 }, silentLogger).run();

  it("checks final blocks only, with other endpoints than the first time, and moves on", async () => {
    chain.add(...history());
    await indexAll();
    chain.finalized_ = 120;
    expect(await sweep()).toEqual({ from: 100, to: 120, recovered: 0, orphaned: 0, servedBy: ["rpc-b"] });
    expect(chain.excluded.at(-1)).toEqual(["rpc-a"]);
    expect(await store.finalizedCursor()).toBe(120);
    expect(await sweep()).toBeNull();
    chain.finalized_ = 200;
    expect(await sweep()).toMatchObject({ from: 121, to: 130 });
  });

  it("never checks past what is indexed", async () => {
    chain.add(...history());
    await indexAll();
    chain.finalized_ = 10_000;
    expect((await sweep())!.to).toBe(130);
  });

  it("adds an event the first read missed past the rescan window, and folds it in order", async () => {
    const events = history();
    const accepted = events[3]!;
    chain.add(...events);
    chain.hidden.add(accepted);
    await indexAll();
    // Missed: the duel jumped from challenged to resolved, without its accepter.
    expect((await store.duel(0))!.accepter).toBeNull();
    chain.hidden.clear();
    chain.finalized_ = 130;
    expect(await sweep()).toMatchObject({ recovered: 1, orphaned: 0 });
    expect(await store.duel(0)).toMatchObject({ accepter: BOB, status: "resolved", updatedBlock: 109 });
    expect((await store.user(BOB))!.actions).toBe(4);
  });

  it("removes what a reorg dropped, and undoes its effects", async () => {
    const events = history();
    const proof = events.at(-1)!;
    chain.add(...events);
    await indexAll();
    expect((await store.box(5))!.aliveCheck).toBe("alive");
    // The final chain does not have that proof any more.
    chain.events = chain.events.filter((e) => e !== proof);
    chain.finalized_ = 130;
    expect(await sweep()).toMatchObject({ recovered: 0, orphaned: 1 });
    expect((await store.box(5))!.aliveCheck).toBe("none");
    expect((await store.stats()).events).toBe(12);
  });

  it("replaces an event recorded from a block that lost the fork", async () => {
    const events = history();
    chain.add(...events);
    await indexAll();
    const proof = chain.events.at(-1)!;
    proof.blockHash = hashOf(proof.block, "f0");
    chain.finalized_ = 130;
    expect(await sweep()).toMatchObject({ recovered: 1, orphaned: 1 });
    const [stored] = await store.activity({ tokenId: 5, limit: 1 });
    expect(stored!.blockHash).toBe(hashOf(130, "f0"));
  });
});

describe("Reconciler", () => {
  let log: Logger & { warn: Mock<Logger["warn"]>; error: Mock<Logger["error"]> };
  const reconcile = (boxesPerRun = 10) => new Reconciler(chain, state, store, { startBlock: START, boxesPerRun }, log).run();

  /** The contract's views, as they should read after `history()`. */
  const truthful = () => {
    state.countersValue = { tokenCount: 6, duelCount: 2, requestCount: 2, milestonesReached: 1 };
    state.duels.set(1, { tokenA: 2, tokenB: 1, challenger: BOB, accepter: null, status: "challenged" });
    state.requests.set(1, { kind: "aliveCheck", status: "pending", requester: BOB, tokenId: 3, other: null });
    for (let id = 0; id < 6; id++) {
      state.boxes.set(id, {
        tokenId: id,
        status: id === 4 ? "revealed" : "sealed",
        aliveCheck: id === 5 ? "alive" : "none",
        partner: null,
        wins: id === 0 ? 1 : 0,
        publicTraits: id === 1 ? [{ traitIndex: 1, roll: 50 }] : [],
      });
    }
  };

  beforeEach(() => {
    log = { ...silentLogger, warn: vi.fn<Logger["warn"]>(), error: vi.fn<Logger["error"]>() };
  });

  it("finds nothing when the index matches the contract, read as of the indexed block", async () => {
    chain.add(...history());
    await indexAll();
    truthful();
    const r = await reconcile();
    expect(r).toMatchObject({ block: 130, drift: [], recovered: 0, unresolved: [], checked: { duels: 1, requests: 1, boxes: 6 } });
    expect(state.readAt).toEqual([130]);
    expect(chain.entityQueries).toEqual([]);
  });

  it("recovers a duel the contract has and the index lost", async () => {
    const events = history();
    chain.add(...events);
    for (const e of events.filter((e) => "duelId" in e && e.duelId === 1)) chain.hidden.add(e);
    await indexAll();
    truthful();
    const r = await reconcile();
    expect(r!.drift).toContainEqual({ kind: "duel", id: 1, detail: "missing from the index" });
    expect(chain.entityQueries[0]).toMatchObject({ duelIds: [1] });
    expect(r).toMatchObject({ recovered: 1, unresolved: [] });
    expect(await store.duel(1)).toMatchObject({ status: "challenged", challenger: BOB });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("settles a duel left open in the index that the contract closed", async () => {
    chain.add(...history());
    await indexAll();
    const cancel = ev("DuelCancelled", 131, { duelId: 1 });
    chain.add(cancel);
    chain.hidden.add(cancel);
    await indexAll();
    truthful();
    state.duels.set(1, { tokenA: 2, tokenB: 1, challenger: BOB, accepter: null, status: "cancelled" });
    const r = await reconcile();
    expect(r!.drift).toEqual([{ kind: "duel", id: 1, detail: "index challenged, contract cancelled" }]);
    expect((await store.duel(1))!.status).toBe("cancelled");
    expect(r!.unresolved).toEqual([]);
  });

  it("repairs a box from its own events, and a missed milestone", async () => {
    const events = history();
    chain.add(...events);
    chain.hidden.add(events.at(-1)!);
    chain.hidden.add(events.at(-2)!);
    // Indexed on, so the missed logs fall out of the rescan window.
    chain.add(ev("Fed", 140, { tokenId: 0, feeder: ALICE }));
    await indexAll();
    truthful();
    const r = await reconcile();
    expect(r!.drift).toEqual(
      expect.arrayContaining([
        { kind: "milestones", id: 1, detail: "index 0, contract 1" },
        { kind: "box", id: 5, detail: "alive check: index none, contract alive" },
      ]),
    );
    expect(r).toMatchObject({ recovered: 2, unresolved: [] });
    expect((await store.box(5))!.aliveCheck).toBe("alive");
    expect(await store.milestonesReached()).toBe(1);
  });

  it("compares public traits by value, whatever order their keys come back in", async () => {
    chain.add(...history());
    await indexAll();
    truthful();
    // Postgres (jsonb) returns {"roll":..,"traitIndex":..}; the views build {traitIndex, roll}.
    const box = (await store.box(1))!;
    await store.transaction((tx) => tx.saveBox({ ...box, publicTraits: [{ roll: 50, traitIndex: 1 } as never] }));
    expect((await reconcile())!.drift).toEqual([]);
  });

  it("reports what no event explains, as an error", async () => {
    chain.add(...history());
    await indexAll();
    truthful();
    state.boxes.set(3, { ...state.boxes.get(3)!, wins: 7 });
    const r = await reconcile();
    expect(r!.unresolved).toEqual([{ kind: "box", id: 3, detail: "wins: index 0, contract 7" }]);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("checks the boxes a slice at a time, all of them over successive runs", async () => {
    chain.add(...history());
    await indexAll();
    truthful();
    const reconciler = new Reconciler(chain, state, store, { startBlock: START, boxesPerRun: 4 }, log);
    const seen: number[] = [];
    const views = state.boxViews.bind(state);
    state.boxViews = async (ids: number[]) => (seen.push(...ids), views(ids));
    await reconciler.run();
    await reconciler.run();
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
  });
});
