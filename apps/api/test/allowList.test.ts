import { allowListMessage } from "@dno/chain-adapter/standings";
import { beforeEach, describe, expect, it } from "vitest";
import { AllowList, FACTS_TTL } from "../src/application/allowList";
import { silentLogger } from "../src/application/ports/logger";
import { SyncChain } from "../src/application/syncChain";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ALICE, BOB, ev, FakeChain } from "./fixtures";

const CAROL = "0x000000000000000000000000000000000000ca01";

/** Signatures are checked in the HTTP tests; here the verifier believes the address the test names. */
let signer = ALICE;
const verifier = { recover: () => signer };
let now = 1_000;

async function indexed(...events: ReturnType<typeof ev>[]): Promise<MemoryStore> {
  const store = new MemoryStore();
  const chain = new FakeChain();
  chain.add(...events);
  await new SyncChain(chain, store, { startBlock: 100, confirmations: 0, rescan: 0, maxBlocksPerPass: 1000 }, silentLogger).pass();
  return store;
}

/** A duel from posting to outcome, between two players. */
function duel(id: number, block: number, a: { token: number; who: string }, b: { token: number; who: string }, winner: number) {
  const loser = winner === a.token ? b.token : a.token;
  return [
    ev("DuelPosted", block, { duelId: id, tokenA: a.token, tokenB: 0, challenger: a.who, reserved: false }),
    ev("DuelOpened", block, { duelId: id, openUntil: 2_000_000_000 }, { logIndex: 1 }),
    ev("DuelAccepted", block + 1, { duelId: id, tokenB: b.token, accepter: b.who }),
    ev("DuelResolved", block + 2, { duelId: id, winner, loser, traitIndex: 0, roll: 1 }),
  ];
}

describe("allow list", () => {
  let store: MemoryStore;
  const claim = async (list: AllowList, who: string) => {
    signer = who;
    return list.claim(who, allowListMessage(who, new Date()), "0x01");
  };

  beforeEach(async () => {
    now = 1_000;
    store = await indexed(
      ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 6 }),
      // Alice beats Bob twice and Carol once: two opponents beaten, two faced.
      ...duel(0, 101, { token: 0, who: ALICE }, { token: 1, who: BOB }, 0),
      ...duel(1, 110, { token: 0, who: ALICE }, { token: 1, who: BOB }, 0),
      ...duel(2, 120, { token: 2, who: CAROL }, { token: 0, who: ALICE }, 0),
      // Bob against himself counts nothing.
      ...duel(3, 130, { token: 3, who: BOB }, { token: 4, who: BOB }, 3),
      ev("Observed", 140, { tokenId: 1, openedBy: BOB, seed: "1", state: 0, score: 1, golden: false }),
    );
  });

  it("counts each opponent once and ignores duels against yourself", async () => {
    const list = new AllowList(store, verifier, { now: () => now }, 2);
    expect((await list.status(ALICE)).live).toEqual({ points: 3 * 2 + 2, beaten: 2, faced: 2, opened: 0 });
    expect((await list.status(BOB)).live).toEqual({ points: 1 + 2, beaten: 0, faced: 1, opened: 1 });
    expect((await list.status(CAROL)).live).toEqual({ points: 1, beaten: 0, faced: 1, opened: 0 });
  });

  it("ranks claimants by points, then by who claimed first, and gives the places to the best", async () => {
    const list = new AllowList(store, verifier, { now: () => now }, 2);
    await claim(list, CAROL);
    now = 2_000;
    await claim(list, ALICE);
    now = 3_000;
    expect(await claim(list, BOB)).toMatchObject({ points: 3, rank: 2, claimants: 3 });
    expect((await list.ranked()).map((e) => [e.address, e.points, e.inPlace])).toEqual([
      [ALICE, 8, true],
      [BOB, 3, true],
      [CAROL, 1, false],
    ]);
    // Claiming again keeps the first claim's date.
    now = 4_000;
    expect(await claim(list, CAROL)).toMatchObject({ claimedAt: 1_000, rank: 3 });
  });

  it("keeps the best points a claimant had, when the duels are gone", async () => {
    await claim(new AllowList(store, verifier, { now: () => now }, 2), ALICE);
    // A redeployment empties the index; the claim stays.
    const fresh = await indexed(ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 1 }));
    await fresh.saveAllowListClaim((await store.allowListClaim(ALICE))!);
    const list = new AllowList(fresh, verifier, { now: () => now }, 2);
    expect(await list.status(ALICE)).toMatchObject({ points: 8, live: { points: 0 }, rank: 1 });
  });

  it("reuses the public facts for a while, but a claim reads them afresh", async () => {
    const list = new AllowList(store, verifier, { now: () => now }, 2);
    expect((await list.status(CAROL)).live.points).toBe(1);
    // Carol beats Bob (+3 beaten, +1 faced): a quest platform checking her within the window still sees the old points.
    const later = new FakeChain();
    later.add(...duel(4, 200, { token: 2, who: CAROL }, { token: 1, who: BOB }, 2));
    await new SyncChain(later, store, { startBlock: 200, confirmations: 0, rescan: 0, maxBlocksPerPass: 1000 }, silentLogger).pass();
    expect((await list.status(CAROL)).live.points).toBe(1);
    expect((await claim(list, CAROL)).live.points).toBe(5);
    now += FACTS_TTL;
    expect((await list.status(CAROL)).live.points).toBe(5);
  });
});
