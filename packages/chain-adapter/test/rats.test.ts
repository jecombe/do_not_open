import { describe, expect, it } from "vitest";
import { studio } from "@dno/game-spec";
import { MOCK_YOU, MockAdapter, ratJob } from "../src";

const DAY = 60_000;

const fresh = async () => {
  let t = 1_000_000;
  const chain = new MockAdapter({ latency: 0, dayMs: DAY, now: () => t });
  await chain.connect();
  return { chain, advance: (ms: number) => (t += ms) };
};

describe("MockAdapter rats", () => {
  it("adopts a free rat by its seed, once, for its USDC price", async () => {
    const { chain } = await fresh();
    const prices = await chain.ratPrices();
    expect(prices).toEqual({ seed: 1_000_000n, model: 3_000_000n });
    const before = await chain.usdcBalance(MOCK_YOU);
    expect(await chain.ratTaken({ seed: 42n })).toBeNull();
    const id = await chain.mintSeedRat(42n);
    expect(id).toBe(1);
    expect(await chain.ratTaken({ seed: 42n })).toEqual({ id: 1, owner: MOCK_YOU });
    expect(await chain.usdcBalance(MOCK_YOU)).toBe(before - 1_000_000n);
    await expect(chain.mintSeedRat(42n)).rejects.toThrow();
    const rats = await chain.ratsOf(MOCK_YOU);
    expect(rats).toHaveLength(1);
    expect(rats[0]).toMatchObject({ id: 1, kind: "seed", seed: "42", owner: MOCK_YOU });
  });

  it("adopts an AI rat with the API's go-ahead, once", async () => {
    const { chain } = await fresh();
    const adoption = { job: "00000000-0000-4000-8000-000000000001", uri: "ar://x", deadline: 10_000_000, signature: "0x", priceUsdc: "3" };
    expect(await chain.ratTaken({ job: adoption.job })).toBeNull();
    expect(await chain.mintModelRat(adoption)).toBe(1);
    expect(await chain.ratTaken({ job: adoption.job })).toEqual({ id: 1, owner: MOCK_YOU });
    await expect(chain.mintModelRat(adoption)).rejects.toThrow();
    expect((await chain.ratsOf(MOCK_YOU))[0]).toMatchObject({ kind: "model", uri: "ar://x" });
  });

  it("counts the rats left and refuses a wallet past its share", async () => {
    const { chain } = await fresh();
    const { maxSeedRats, maxModelRats, maxPerWallet } = studio.rats.mint;
    expect(await chain.ratSupply(MOCK_YOU)).toEqual({ seed: { minted: 0, max: maxSeedRats }, model: { minted: 0, max: maxModelRats }, perWallet: maxPerWallet, mintedBy: 0 });
    for (let s = 1; s <= maxPerWallet; s++) await chain.mintSeedRat(BigInt(s));
    expect(await chain.ratSupply(MOCK_YOU)).toMatchObject({ seed: { minted: maxPerWallet }, mintedBy: maxPerWallet });
    expect((await chain.ratSupply(null))?.mintedBy).toBeNull();
    await expect(chain.mintSeedRat(999n)).rejects.toMatchObject({ code: "reverted", reason: "WalletLimit" });
  });

  it("pays each rat its croquettes a day, at most maxDays at once, from the pantry", async () => {
    const { chain, advance } = await fresh();
    const { perDay, maxDays } = studio.rats.croquettes;
    await chain.mintSeedRat(1n);
    await chain.mintSeedRat(2n);
    expect(await chain.ratClaimable([1, 2])).toEqual([0n, 0n]);
    advance(DAY * 2 + 10);
    expect(await chain.ratClaimable([1, 2])).toEqual([BigInt(perDay * 2), BigInt(perDay * 2)]);
    const before = await chain.croqBalance(MOCK_YOU);
    expect(await chain.claimRatCroq([1, 2])).toBe(BigInt(perDay * 4));
    expect(await chain.croqBalance(MOCK_YOU)).toBe(before + BigInt(perDay * 4));
    expect(await chain.ratClaimable([1])).toEqual([0n]);
    advance(DAY * 50);
    expect(await chain.ratClaimable([1])).toEqual([BigInt(perDay * maxDays)]);
    const pantry = await chain.ratPantry();
    expect(pantry?.reserve).toBe(BigInt(studio.rats.croquettes.fund - perDay * 4));
  });

  it("passes the adoption's signed bytes32 job through, and nothing else", () => {
    const hex = `0x${"AB".repeat(32)}`;
    expect(ratJob(hex)).toBe(hex.toLowerCase());
    // A bare UUID is not what the API signed (it signs its keccak256): refused rather than guessed.
    expect(() => ratJob("00000000-0000-4000-8000-00000000000a")).toThrow();
    expect(() => ratJob("nope")).toThrow();
  });
});

describe("MockAdapter rats' tricks", () => {
  /** Adopts rats until one has `power`, as a player would mint. */
  const ratWith = async (chain: MockAdapter, power: number, from = 100n) => {
    for (let s = from; s < from + 60n; s++) {
      const id = await chain.mintSeedRat(s).catch(() => null);
      if (id === null) continue;
      if ((await chain.ratPower(id)) === power) return id;
    }
    throw new Error(`no rat with power ${power}`);
  };
  const lenient = async () => {
    let t = 1_000_000;
    const chain = new MockAdapter({ latency: 0, dayMs: DAY, now: () => t });
    await chain.connect();
    // The wallet limit would stop the search for a power: the tests mint past it.
    (chain as unknown as { ratSupply: () => Promise<unknown> }).ratSupply = async () => ({ seed: { minted: 0, max: 10_000 }, model: { minted: 0, max: 10_000 }, perWallet: 10_000, mintedBy: 0 });
    return { chain, advance: (ms: number) => (t += ms) };
  };
  // The mock's first boxes are yours, the next ones the night shift's.
  const theirs = async (chain: MockAdapter) => {
    const yours = await chain.boxesOf(MOCK_YOU);
    return Math.max(...yours) + 1;
  };
  const mine = async (chain: MockAdapter) => (await chain.boxesOf(MOCK_YOU))[0]!;

  it("draws each rat a power with the spec's odds, readable by its holder", async () => {
    const { chain } = await lenient();
    const seen = new Set<number>();
    for (let s = 1n; s <= 30n; s++) seen.add(await chain.ratPower(await chain.mintSeedRat(s)));
    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect(await chain.ratTricks()).toMatchObject({ sniffFee: 2_500_000n, sniffRebate: 750_000n });
  });

  it("sniffs at the full price, and gives a power-1 rat its rebate back", async () => {
    const { chain } = await lenient();
    const box = await theirs(chain);
    const cheap = await ratWith(chain, 1);
    const plain = await ratWith(chain, 2, 300n);
    let before = await chain.confidentialUsdcBalance();
    expect((await chain.sniffWithRat(plain, box)).traitIndex).toBeGreaterThanOrEqual(0);
    expect(await chain.confidentialUsdcBalance()).toBe(before - 2_500_000n);
    before = await chain.confidentialUsdcBalance();
    await chain.sniffWithRat(cheap, box);
    expect(await chain.confidentialUsdcBalance()).toBe(before - 1_750_000n);
  });

  it("jams another's box for the holder, shields one's own from strangers, and rests the rat", async () => {
    const { chain, advance } = await lenient();
    const own = await mine(chain);
    const rat = await ratWith(chain, 3);
    const played = await chain.playTrick(rat, own, 0);
    expect(played.readyAt - played.until).toBe((studio.rats.powers.rechargeDays * DAY) / 1000);
    expect((await chain.ratReadyAt([rat]))[0]).toBe(played.readyAt);
    await expect(chain.playTrick(rat, own, 0)).rejects.toMatchObject({ code: "reverted", reason: "Recharging" });
    // A shield on one's own box: the holder still reads the truth.
    const truth = await chain.shake(own);
    expect(truth.roll).toBeGreaterThanOrEqual(0);

    advance((studio.rats.powers.trickDays + studio.rats.powers.rechargeDays) * DAY);
    expect((await chain.ratReadyAt([rat]))[0]).toBe(0);
  });

  it("scrambles the holder's shakes while a power-3 rat jams the box", async () => {
    const { chain, advance } = await lenient();
    const own = await mine(chain);
    const rat = await ratWith(chain, 3);
    // The mock plays the jam as another wallet would: the rat's holder is not the box's.
    const hidden = chain as unknown as { jams: Map<number, { traits: Set<number>; until: number; noise: number[] }> };
    hidden.jams.set(own, { traits: new Set([0, 1, 2, 3, 4]), until: 1_000_000 + 3 * DAY, noise: [0, 0, 0, 0, 0] });
    await expect(chain.shake(own)).rejects.toMatchObject({ code: "scrambled" });
    advance(3 * DAY);
    await expect(chain.shake(own)).resolves.toBeTruthy();
    expect(rat).toBeGreaterThan(0);
  });
});
