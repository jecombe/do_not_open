import { describe, expect, it } from "vitest";
import { spec } from "@dno/game-spec";
import { buildCatSpec } from "@dno/generator";
import { ChainError, formatAmount, MOCK_NIGHT_SHIFT, MOCK_YOU, MockAdapter, mockSeedForToken, mockWeighIn, shortAddress, type Step } from "../src";

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
  it("starts with boxes for you and for the night shift, and tells you only yours", async () => {
    const chain = await fresh();
    expect(await chain.boxesOf(MOCK_YOU)).toEqual([0, 1, 2]);
    // Nobody can list another account's boxes.
    expect(await chain.boxesOf(MOCK_NIGHT_SHIFT)).toEqual([]);
    const c = await chain.collection();
    expect(c.tokenCount).toBe(6);
    expect(c.sale).toEqual({ milestones: spec.collection.milestones, reached: 0, soldOut: false });
  });

  it("summarises a range of boxes: yours or not, status, partner", async () => {
    const chain = await fresh();
    const rows = await chain.boxSummaries(2, 5);
    expect(rows.map((r) => r.tokenId)).toEqual([2, 3, 4]);
    expect(rows.map((r) => r.mine)).toEqual([true, false, false]);
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
    expect((await chain.box(0)).mine).toBe(false);
    expect(await refusal(chain.mint(1))).toBe("not-connected");
  });

  it("hides a mint's quantity among as many ids as asked, and gives the first ones", async () => {
    const chain = await fresh();
    expect(await chain.mint(2)).toEqual([6, 7]);
    expect((await chain.collection()).tokenCount).toBe(16);
    expect(await chain.boxesOf(MOCK_YOU)).toEqual([0, 1, 2, 6, 7]);
    // Fewer ids: cheaper, and the quantity is easier to guess.
    expect(await chain.mint(1, { ids: 3 })).toEqual([16]);
    expect((await chain.collection()).tokenCount).toBe(19);
    // More boxes than ids gets as many as ids... and never fewer ids than boxes asked.
    expect(await chain.mint(12, { pay: "usdc" })).toHaveLength(10);
  });

  it("pays in cUSDC, shields USDC first on request, and gives nothing the wallet cannot cover", async () => {
    const chain = await fresh();
    const usdc = await chain.usdcBalance(MOCK_YOU);
    const cUsdc = await chain.confidentialUsdcBalance();
    await chain.mint(1);
    expect(await chain.confidentialUsdcBalance()).toBe(cUsdc - 5_000_000n);
    await chain.mint(2, { pay: "usdc" });
    // Shielded, then spent: the cUSDC balance is back where it was.
    expect(await chain.usdcBalance(MOCK_YOU)).toBe(usdc - 10_000_000n);
    expect(await chain.confidentialUsdcBalance()).toBe(cUsdc - 5_000_000n);
    // 15 cUSDC left: three boxes, not four.
    expect(await refusal(chain.mint(4))).toBe("unpaid");
    await chain.faucetUsdc();
    expect(await chain.usdcBalance(MOCK_YOU)).toBe(usdc + 90_000_000n);
    expect(await refusal(chain.shieldUsdc(10n ** 12n))).toBe("insufficient-usdc");
    const before = await chain.confidentialUsdcBalance();
    const { usdcOut, fee } = await chain.quoteUsdc(10n ** 16n);
    expect(fee).toBe(3n * 10n ** 13n);
    await chain.buyUsdc(10n ** 16n, true);
    expect(await chain.confidentialUsdcBalance()).toBe(before + usdcOut);
  });

  it("announces milestones as the hidden sold count reaches them", async () => {
    const chain = await fresh();
    for (let i = 0; i < 5; i++) await chain.faucetUsdc();
    // 6 sold at the start; the first milestone is 100.
    for (let i = 0; i < 9; i++) await chain.mint(10, { pay: "usdc" });
    expect((await chain.collection()).sale.reached).toBe(0);
    await chain.mint(10, { pay: "usdc" });
    expect((await chain.collection()).sale.reached).toBe(1);
  });

  it("reports steps in order: wallet, confirming, decrypting", async () => {
    const chain = await fresh();
    const steps: Step[] = [];
    await chain.shake(0, { onStep: (s) => steps.push(s) });
    expect(steps).toEqual(["wallet", "confirming", "decrypting"]);
  });

  it("shakes show a real trait to the holder, and nothing to anyone else", async () => {
    const chain = await fresh();
    const cat = buildCatSpec({ seed: mockSeedForToken(0) });
    for (let i = 0; i < 8; i++) {
      const { traitIndex, roll } = await chain.shake(0);
      expect(roll).toBe(cat.traits[spec.traits[traitIndex]!.key].roll);
    }
    expect(await refusal(chain.shake(3))).toBe("not-yours");
  });

  it("lets anyone pay to shake, and keeps the holder's share in the box", async () => {
    const chain = await fresh();
    await chain.paidShake(0);
    const before = await chain.confidentialUsdcBalance();
    // Your own box: the share comes back to you when you claim it.
    expect(await chain.claimEarnings([0, 1])).toBe(1_750_000n);
    expect(await chain.confidentialUsdcBalance()).toBe(before + 1_750_000n);
    await chain.paidShake(3);
    // The night shift's box: claiming it gets you nothing.
    expect(await chain.claimEarnings([3])).toBe(0n);
  });

  it("opens a box once, with contents that match the generator, and refuses a stranger", async () => {
    const chain = await fresh();
    await chain.feed(1);
    const [box] = await chain.observe(1);
    const cat = buildCatSpec({ seed: box!.revealed!.seed, affection: box!.revealed!.affection });
    expect(box!.status).toBe("revealed");
    expect(box!.revealed!.score).toBe(cat.rarity.score);
    expect(await refusal(chain.observe(1))).toBe("NotSealed");
    expect(await refusal(chain.feed(1))).toBe("NotSealed");
    const before = await chain.confidentialUsdcBalance();
    expect(await refusal(chain.observe(3))).toBe("not-yours");
    expect(await chain.confidentialUsdcBalance()).toBe(before);
  });

  it("answers the alive check once, for the holder only", async () => {
    const chain = await fresh();
    expect(await refusal(chain.proveAlive(3))).toBe("not-yours");
    const alive = await chain.proveAlive(0);
    expect((await chain.box(0)).aliveCheck).toBe(alive ? "alive" : "notAlive");
    expect(await refusal(chain.proveAlive(0))).toBe("NotSealed");
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

  it("refuses an entanglement whose proposer did not hold the box", async () => {
    const chain = await fresh();
    await chain.proposeEntangle(3, 0);
    expect(await refusal(chain.acceptEntangle(3, 0))).toBe("not-yours");
    expect((await chain.box(0)).partner).toBeNull();
  });

  it("starts with two of the night shift's boxes on the duel shelf", async () => {
    const chain = await fresh();
    const shelf = await chain.duelShelf();
    expect(shelf.map((d) => [d.tokenA, d.reserved, d.status])).toEqual([[4, false, "open"], [3, false, "open"]]);
    expect((await chain.pair(0, 3)).openDuel?.tokenA).toBe(3);
  });

  it("takes a duel up from the shelf and settles it in one go", async () => {
    const chain = await fresh();
    const listed = (await chain.duelShelf()).find((d) => d.tokenA === 3)!;
    const result = (await chain.acceptDuel(listed.duelId, 0))!;
    expect([result.winner, result.loser].sort()).toEqual([0, 3]);
    expect((await chain.box(result.winner)).wins).toBe(1);
    expect((await chain.box(result.loser)).publicTraits).toEqual([result.shown]);
    expect((await chain.duelShelf()).map((d) => d.tokenA)).toEqual([4]);
    expect(await refusal(chain.acceptDuel(listed.duelId, 1))).toBe("WrongDuelStatus");
  });

  it("puts a duel back on the shelf when the taker brought a box they do not hold", async () => {
    const chain = await fresh();
    const listed = (await chain.duelShelf()).find((d) => d.tokenA === 3)!;
    expect(await refusal(chain.acceptDuel(listed.duelId, 5))).toBe("not-yours");
    expect((await chain.duelShelf()).find((d) => d.duelId === listed.duelId)).toMatchObject({ status: "open", tokenB: null, accepter: null });
    expect((await chain.box(3)).publicTraits).toEqual([]);
  });

  it("puts your box on the shelf once proven, one listing per box, until withdrawn", async () => {
    const chain = await fresh();
    const first = await chain.postDuel(0);
    expect(first).toMatchObject({ tokenA: 0, tokenB: null, reserved: false, status: "open" });
    expect(first.openUntil! - Date.now() / 1000).toBeGreaterThan(Number(spec.mechanics.duel!.lifetimeDays) * 86_400 - 60);
    const second = await chain.postDuel(0);
    const shelf = await chain.duelShelf();
    expect(shelf.filter((d) => d.tokenA === 0).map((d) => d.duelId)).toEqual([second.duelId]);
    expect(await refusal(chain.acceptDuel(second.duelId, 0))).toBe("SameBox");
    await chain.cancelDuel(second.duelId);
    expect((await chain.duelShelf()).some((d) => d.tokenA === 0)).toBe(false);
    expect(await refusal(chain.cancelDuel(second.duelId))).toBe("WrongDuelStatus");
  });

  it("keeps a box nobody proved to hold off the shelf", async () => {
    const chain = await fresh();
    expect(await refusal(chain.postDuel(5))).toBe("not-yours");
    expect((await chain.duelShelf()).some((d) => d.tokenA === 5)).toBe(false);
  });

  it("runs a reserved duel against the night shift, who takes it up at once", async () => {
    const chain = await fresh();
    expect(await refusal(chain.postDuel(0, { reservedFor: 0 }))).toBe("SameBox");
    const duel = await chain.postDuel(0, { reservedFor: 5 });
    expect(duel).toMatchObject({ tokenB: 5, reserved: true, status: "pending" });
    expect((await chain.pair(0, 5)).openDuel?.status).toBe("pending");
    const result = (await chain.finishDuel(duel.duelId))!;
    expect([result.winner, result.loser].sort()).toEqual([0, 5]);
    expect((await chain.pair(0, 5)).openDuel).toBeNull();
  });

  it("lets only the named box take a reserved duel up, and nobody once it is out of time", async () => {
    let now = Date.now();
    const chain = new MockAdapter({ latency: 0, now: () => now });
    await chain.connect();
    const duel = await chain.postDuel(0, { reservedFor: 1 });
    expect(await refusal(chain.acceptDuel(duel.duelId, 2))).toBe("NotThisBox");
    now += (Number(spec.mechanics.duel!.lifetimeDays) * 86_400 + 1) * 1000;
    expect(await refusal(chain.acceptDuel(duel.duelId, 1))).toBe("DuelExpired");
    expect(await chain.duelShelf()).toEqual([]);
  });

  it("gives a box away, and gives nothing when it is not yours", async () => {
    const chain = await fresh();
    await chain.sendBox(0, MOCK_NIGHT_SHIFT);
    expect(await chain.boxesOf(MOCK_YOU)).toEqual([1, 2]);
    await chain.sendBox(3, MOCK_YOU);
    expect(await chain.boxesOf(MOCK_YOU)).toEqual([1, 2]);
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
    expect([e.mealsPerDay, e.maxEatenPerDay, e.mealTreasuryBps, e.mealBurnBps]).toEqual([2, 1_000n, 2_000, 2_000]);
    expect(e.market?.croqReserve).toBe(4_000_000n);
  });

  it("pays a welcome bag per box once, then a purr per whole day", async () => {
    const { chain, tick } = await clocked();
    await chain.claimCroquettes([0, 1, 2]);
    expect(await chain.confidentialBalance()).toBe(300n);
    // A second claim the same day pays nothing more.
    await chain.claimCroquettes([0]);
    expect(await chain.confidentialBalance()).toBe(300n);
    expect((await chain.boxPantry(0)).welcomed).toBe(true);

    tick(3 * DAY);
    await chain.claimCroquettes([0, 1, 2]);
    const after = await chain.confidentialBalance();
    expect(after - 300n).toBeGreaterThanOrEqual(0n);
    expect(after - 300n).toBeLessThanOrEqual(BigInt(3 * 3 * spec.economy.purr.maxPerDay));
    // The night shift's box: its bag goes into the box, not to you.
    const mine = await chain.confidentialBalance();
    await chain.claimCroquettes([3]);
    expect(await chain.confidentialBalance()).toBe(mine);
  });

  it("lets the holder feed twice a day, up to 1,000, and splits each meal", async () => {
    const { chain, tick } = await clocked();
    const youHold = async (n: bigint) => {
      await chain.trade("buy", 10_000_000n);
      await chain.wrap(await chain.croqBalance(MOCK_YOU));
      expect(await chain.confidentialBalance()).toBeGreaterThanOrEqual(n);
    };
    await youHold(3_000n);
    const start = await chain.confidentialBalance();

    await chain.feedCroquettes(0, 700n);
    await chain.feedCroquettes(0, 700n); // only 300 left today: cut down, silently
    expect(await chain.pantryDay(0)).toEqual({ meals: 2, eaten: 1_000n });
    expect(await chain.confidentialBalance()).toBe(start - 1_000n);
    // A third meal, or a meal for someone else's cat, moves nothing.
    await chain.feedCroquettes(0, 1n);
    await chain.feedCroquettes(3, 1n);
    expect(await chain.confidentialBalance()).toBe(start - 1_000n);
    expect(await chain.pantryDay(3)).toEqual({ meals: 0, eaten: 0n });

    tick(DAY);
    expect(await chain.pantryDay(0)).toEqual({ meals: 0, eaten: 0n });
    await chain.feedCroquettes(0, 10n ** 9n); // a new day: cut down to 1,000
    expect(await chain.confidentialBalance()).toBe(start - 2_000n);
    await chain.sendCroquettes(MOCK_NIGHT_SHIFT, await chain.confidentialBalance());
    await chain.feedCroquettes(1, 50n); // more than held: moves nothing
    expect((await chain.pantryDay(1)).eaten).toBe(0n);
  });

  it("weighs an opened cat once, by the spec's builds", async () => {
    const { chain } = await clocked();
    await chain.claimCroquettes([0, 1, 2]);
    await chain.feedCroquettes(0, 100n);
    expect(await refusal(chain.weigh(0))).toBe("NotRevealed");
    await chain.observe(0);
    const w = await chain.weigh(0);
    expect([w.weight, w.build, w.sick, w.disease]).toEqual([100n, "normal", false, null]);
    expect(w.tolerance).toBeGreaterThanOrEqual(BigInt(spec.economy.weight.sick.minWeight));
    expect((await chain.boxPantry(0)).weighIn).toEqual(w);
    expect(await refusal(chain.weigh(0))).toBe("AlreadyWeighed");
    expect(await refusal(chain.feedCroquettes(0, 1n))).toBe("NotSealed");

    await chain.observe(1);
    expect((await chain.weigh(1)).build).toBe("thin");
  });

  it("makes a cat sick at its own tolerance", () => {
    const seed = 0x1234_5678_9abc_def0n;
    const { tolerance } = mockWeighIn(0n, seed);
    expect(mockWeighIn(tolerance - 1n, seed)).toMatchObject({ build: "huge", sick: false, disease: null });
    const sick = mockWeighIn(tolerance, seed);
    expect(sick.sick).toBe(true);
    expect(spec.economy.weight.diseases.map((d) => d.key)).toContain(sick.disease);
  });

  it("buys on the market, wraps, unwraps and sells back", async () => {
    const { chain } = await clocked();
    const quoted = await chain.quote("buy", 5_000_000n);
    expect(quoted).toBeGreaterThan(0n);
    await chain.trade("buy", 5_000_000n);
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
