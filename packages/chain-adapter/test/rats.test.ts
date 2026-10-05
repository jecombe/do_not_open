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
