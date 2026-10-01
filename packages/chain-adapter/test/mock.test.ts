import { describe, expect, it } from "vitest";
import { spec } from "@dno/game-spec";
import { buildCatSpec } from "@dno/generator";
import { ChainError, formatAmount, MOCK_NIGHT_SHIFT, MOCK_YOU, MockAdapter, mockSeedForToken, shortAddress, type Step } from "../src";

const fresh = async () => {
  const chain = new MockAdapter({ latency: 0 });
  await chain.connect();
  return chain;
};
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ChainError ? (e.reason ?? e.code) : "not a ChainError";
  }
  return "no error";
};

describe("MockAdapter", () => {
  it("starts with boxes for you and for the night shift", async () => {
    const chain = await fresh();
    expect(await chain.boxesOf(MOCK_YOU)).toEqual([0, 1, 2]);
    expect(await chain.boxesOf(MOCK_NIGHT_SHIFT)).toEqual([3, 4, 5]);
    expect((await chain.collection()).totalMinted).toBe(6);
  });

  it("summarises a range of boxes with their holder and status", async () => {
    const chain = await fresh();
    const rows = await chain.boxSummaries(2, 5);
    expect(rows.map((r) => r.tokenId)).toEqual([2, 3, 4]);
    expect(rows.map((r) => r.owner)).toEqual([MOCK_YOU, MOCK_NIGHT_SHIFT, MOCK_NIGHT_SHIFT]);
    expect(rows.every((r) => r.status === "sealed")).toBe(true);
    expect(rows.every((r) => r.partner === null)).toBe(true);
    expect(await chain.boxSummaries(6, 10)).toEqual([]);
  });

  it("tells, in a summary, which sealed boxes are already entangled", async () => {
    const chain = await fresh();
    // The night shift accepts at once.
    await chain.proposeEntangle(0, 3);
    const rows = await chain.boxSummaries(0, 4);
    expect(rows.map((r) => r.partner)).toEqual([3, null, null, 0]);
  });

  it("needs an account for actions but not for reads", async () => {
    const chain = new MockAdapter({ latency: 0 });
    expect((await chain.box(0)).status).toBe("sealed");
    expect(await refusal(chain.mint(1))).toBe("not-connected");
  });

  it("mints consecutive ids and enforces the per-transaction cap", async () => {
    const chain = await fresh();
    expect(await chain.mint(2)).toEqual([6, 7]);
    expect(await chain.boxesOf(MOCK_YOU)).toEqual([0, 1, 2, 6, 7]);
    expect(await refusal(chain.mint(11))).toBe("InvalidQuantity");
  });

  it("reports steps in order: wallet, confirming, decrypting", async () => {
    const chain = await fresh();
    const steps: Step[] = [];
    await chain.shake(0, { onStep: (s) => steps.push(s) });
    expect(steps).toEqual(["wallet", "confirming", "decrypting"]);
  });

  it("shakes show a real trait of the box, and only the holder shakes for free", async () => {
    const chain = await fresh();
    const cat = buildCatSpec({ seed: mockSeedForToken(0) });
    for (let i = 0; i < 8; i++) {
      const { traitIndex, roll } = await chain.shake(0);
      expect(roll).toBe(cat.traits[spec.traits[traitIndex]!.key].roll);
    }
    expect(await refusal(chain.shake(3))).toBe("NotHolder");
    expect(await refusal(chain.paidShake(0))).toBe("HolderShakesForFree");
    await chain.paidShake(3);
    expect(await chain.credits(MOCK_NIGHT_SHIFT)).toBe(700000000000000n);
  });

  it("opens a box once, with contents that match the generator", async () => {
    const chain = await fresh();
    await chain.feed(1);
    const [box] = await chain.observe(1);
    const cat = buildCatSpec({ seed: box!.revealed!.seed, affection: box!.revealed!.affection });
    expect(box!.status).toBe("revealed");
    expect(box!.feeds).toBe(1);
    expect(box!.revealed!.score).toBe(cat.rarity.score);
    expect(await refusal(chain.observe(1))).toBe("NotSealed");
    expect(await refusal(chain.feed(1))).toBe("NotSealed");
  });

  it("answers the alive check once", async () => {
    const chain = await fresh();
    const alive = await chain.proveAlive(0);
    expect((await chain.box(0)).aliveCheck).toBe(alive ? "alive" : "notAlive");
    expect(await refusal(chain.proveAlive(0))).toBe("AliveCheckAlreadyRequested");
  });

  it("entangles two of your boxes in two steps and opens them together", async () => {
    const chain = await fresh();
    await chain.proposeEntangle(0, 1);
    expect((await chain.pair(1, 0)).entangleProposal).toEqual({ from: 0, to: 1, proposer: MOCK_YOU });
    await chain.acceptEntangle(0, 1);
    expect((await chain.box(1)).partner).toBe(0);
    const opened = await chain.observe(0);
    expect(opened.map((b) => [b.tokenId, b.status])).toEqual([[0, "revealed"], [1, "revealed"]]);
  });

  it("runs a duel against the night shift, who accepts at once", async () => {
    const chain = await fresh();
    const duelId = await chain.challengeDuel(0, 3);
    expect((await chain.pair(0, 3)).openDuel?.status).toBe("pending");
    const result = await chain.finishDuel(duelId);
    expect([result.winner, result.loser].sort()).toEqual([0, 3]);
    expect((await chain.box(result.winner)).wins).toBe(1);
    expect((await chain.box(result.loser)).publicTraits).toEqual([result.shown]);
    expect((await chain.pair(0, 3)).openDuel).toBeNull();
  });

  it("lets the challenger cancel a duel between two of their own boxes", async () => {
    const chain = await fresh();
    const duelId = await chain.challengeDuel(0, 1);
    expect((await chain.pair(0, 1)).openDuel?.status).toBe("challenged");
    await chain.cancelDuel(duelId);
    expect(await refusal(chain.acceptDuel(duelId))).toBe("WrongDuelStatus");
  });
});

describe("helpers", () => {
  it("formats amounts without trailing zeros", () => {
    expect(formatAmount(2000000000000000n, 18)).toBe("0.002");
    expect(formatAmount(10n ** 18n, 18)).toBe("1");
    expect(formatAmount(0n, 18)).toBe("0");
  });
  it("shortens addresses", () => {
    expect(shortAddress("0x6a18cFC3fAeef453B295B12246d40a82593b3208")).toBe("0x6a18…3208");
  });
});

describe("MockAdapter croquettes", () => {
  const DAY = 60_000;
  const clocked = async () => {
    let now = 1_000_000;
    const chain = new MockAdapter({ latency: 0, dayMs: DAY, now: () => now });
    await chain.connect();
    return { chain, tick: (ms: number) => (now += ms) };
  };

  it("reports the spec's economy and an open market", async () => {
    const { chain } = await clocked();
    const e = await chain.economy();
    expect(e.totalSupply).toBe(BigInt(spec.economy.token.totalSupply));
    expect(e.welcomeBag).toBe(spec.economy.welcomeBag.amount);
    expect(e.payoutBps).toEqual([10_000, 10_000, 0, 5_000]);
    expect(e.market?.croqReserve).toBe(4_000_000n);
  });

  it("pays a welcome bag per box once, then a purr per whole day", async () => {
    const { chain, tick } = await clocked();
    await chain.claimCroquettes([0, 1, 2]);
    expect(await chain.confidentialBalance()).toBe(300n);
    expect(await refusal(chain.claimCroquettes([0]))).toBe("NothingToClaim");
    expect((await chain.boxPantry(0)).welcomed).toBe(true);

    tick(3 * DAY);
    await chain.claimCroquettes([0, 1, 2]);
    const after = await chain.confidentialBalance();
    expect(after - 300n).toBeGreaterThanOrEqual(0n);
    expect(after - 300n).toBeLessThanOrEqual(BigInt(3 * 3 * spec.economy.purr.maxPerDay));
    expect(await refusal(chain.claimCroquettes([3]))).toBe("NotHolder");
  });

  it("burns a tenth of each meal, moves nothing when short, and settles by state", async () => {
    const { chain } = await clocked();
    await chain.claimCroquettes([0, 1, 2]);
    await chain.feedCroquettes(0, 200n);
    await chain.feedCroquettes(0, 5_000n); // more than held: moves nothing
    expect(await chain.confidentialBalance()).toBe(100n);
    expect((await chain.boxPantry(0)).meals).toBe(2);

    expect(await refusal(chain.settle(0))).toBe("NotRevealed");
    const [opened] = await chain.observe(0);
    await chain.settle(0);
    const state = spec.states.find((s) => s.id === opened!.revealed!.state)!.key;
    const payout = (180n * BigInt(spec.economy.settlement.payoutBps[state])) / 10_000n;
    expect(await chain.confidentialBalance()).toBe(100n + payout);
    expect(await refusal(chain.settle(0))).toBe("AlreadySettled");
    expect(await refusal(chain.feedCroquettes(0, 1n))).toBe("NotSealed");
  });

  it("buys on the market, wraps, unwraps and sells back", async () => {
    const { chain } = await clocked();
    const quoted = await chain.quote("buy", 10n ** 15n);
    expect(quoted).toBeGreaterThan(0n);
    await chain.trade("buy", 10n ** 15n);
    expect(await chain.croqBalance(MOCK_YOU)).toBe(quoted);

    await chain.wrap(quoted);
    expect(await chain.croqBalance(MOCK_YOU)).toBe(0n);
    expect(await chain.confidentialBalance()).toBe(quoted);

    await chain.unwrap(1_000n);
    expect(await chain.croqBalance(MOCK_YOU)).toBe(1_000n);
    await chain.sendCroquettes(MOCK_NIGHT_SHIFT, 500n);
    expect(await chain.confidentialBalance()).toBe(quoted - 1_500n);

    await chain.trade("sell", 1_000n);
    expect(await chain.croqBalance(MOCK_YOU)).toBe(0n);
    expect(await refusal(chain.wrap(1n))).toBe("ERC20InsufficientBalance");
  });
});
