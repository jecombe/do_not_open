import { allowListMessage } from "@dno/chain-adapter/standings";
import { beforeEach, describe, expect, it } from "vitest";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { AllowList, FACTS_TTL } from "../src/application/allowList";
import { GiftProofs, giftTree } from "../src/application/whitelistGifts";
import { silentLogger } from "../src/application/ports/logger";
import { SyncChain } from "../src/application/syncChain";
import { Seats } from "../src/application/seats";
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

  it("never gives the team's own wallets a place: no claim, no rank, no seat", async () => {
    // Alice is the team here: she minted, opened and won duels, all to test.
    let list: AllowList | null = null;
    const seats = new Seats(store, 10, () => list!.players(), ["follow", "post"], new Set([ALICE]));
    list = new AllowList(store, verifier, { now: () => now }, 10, async () => new Map(), seats);
    await expect(claim(list, ALICE)).rejects.toThrow(/team's wallets/);
    expect(await store.allowListClaim(ALICE)).toBeNull();
    expect((await list.players()).has(ALICE)).toBe(false);
    await claim(list, BOB);
    expect((await list.ranked()).map((e) => e.address)).toEqual([BOB]);
    expect(await seats.taken()).toBe(1);
    // A boarding pass linked to a team wallet takes no seat either.
    const pass = { id: "p", code: "DNO-TEAM01", handle: "team", xUserId: null, tweetId: null, tweetUrl: null, followedAt: 1, postedAt: 1, likedAt: null, repliedAt: null, repostedAt: null, address: ALICE, discordUserId: null, discordJoinedAt: null, createdAt: 1, verifiedAt: 1, updatedAt: 1 };
    expect(seats.passSeated(pass)).toBe(false);
    expect(seats.passSeated({ ...pass, address: CAROL })).toBe(true);
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

  it("carries an earlier deployment's facts: points and seats survive a redeploy, opponents counted once", async () => {
    const fresh = await indexed(...duel(0, 101, { token: 5, who: ALICE }, { token: 6, who: BOB }, 5));
    // What migration 21 kept of the old index: Alice beat Bob and Carol, Bob opened a box, Carol minted.
    fresh.carried = {
      duels: [
        { tokenA: 0, tokenB: 1, challenger: ALICE, accepter: BOB, winner: 0, loser: 1 },
        { tokenA: 2, tokenB: 0, challenger: CAROL, accepter: ALICE, winner: 0, loser: 2 },
      ],
      openers: [BOB],
      minters: [CAROL],
    };
    const list = new AllowList(fresh, verifier, { now: () => now }, 2);
    // Bob beaten again on the new collection is still one opponent.
    expect((await list.status(ALICE)).live).toEqual({ points: 3 * 2 + 2, beaten: 2, faced: 2, opened: 0 });
    expect((await list.status(BOB)).live).toMatchObject({ faced: 1, opened: 1 });
    // Carol only minted before the redeploy: she still played, so her claim is seated.
    await claim(list, CAROL);
    expect(await list.status(CAROL)).toMatchObject({ seated: true });
  });

  it("gives the gift tiers to the seated claimants only, in rank order", async () => {
    const DAVE = "0x000000000000000000000000000000000000da7e";
    const list = new AllowList(store, verifier, { now: () => now }, null);
    await claim(list, CAROL);
    await claim(list, DAVE);
    await claim(list, ALICE);
    // Dave never played and has no X seat: ranked, no tier, and nobody moves down for him.
    expect((await list.ranked()).map((e) => [e.address, e.seated, e.tier])).toEqual([
      [ALICE, true, 0],
      [CAROL, true, 0],
      [DAVE, false, null],
    ]);
    expect(await list.status(DAVE)).toMatchObject({ tier: null });
    expect(await list.status(ALICE)).toMatchObject({ tier: 0 });
  });

  it("freezes the tiers into the tree WhitelistGifts checks, and serves each wallet its proof", async () => {
    const list = new AllowList(store, verifier, { now: () => now }, null);
    await claim(list, ALICE);
    await claim(list, BOB);
    const tree = giftTree(await list.ranked())!;
    const gifts = new GiftProofs(JSON.parse(JSON.stringify(tree.dump())));
    expect([gifts.frozen, gifts.count, gifts.root]).toEqual([true, 2, tree.root]);
    const proof = gifts.proofOf(BOB.toUpperCase().replace("0X", "0x"))!;
    expect(proof.tier).toBe(0);
    expect(StandardMerkleTree.verify(tree.root, ["address", "uint8"], [BOB, 0], proof.proof)).toBe(true);
    expect(gifts.proofOf(CAROL)).toBeNull();
    expect(new GiftProofs(null)).toMatchObject({ frozen: false, root: null });
  });

  it("puts every claimant on the list when there is no cap", async () => {
    const list = new AllowList(store, verifier, { now: () => now }, null);
    await claim(list, ALICE);
    await claim(list, BOB);
    await claim(list, CAROL);
    expect((await list.ranked()).map((e) => e.inPlace)).toEqual([true, true, true]);
    expect(await list.status(CAROL)).toMatchObject({ places: null, claimants: 3 });
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
