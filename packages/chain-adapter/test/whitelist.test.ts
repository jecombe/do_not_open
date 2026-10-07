import { describe, expect, it } from "vitest";
import { spec } from "@dno/game-spec";
import { MOCK_YOU, MockAdapter } from "../src";

const fresh = async (whitelistGifts?: "open" | "waiting" | "off") => {
  let t = 1_000_000;
  const chain = new MockAdapter({ latency: 0, now: () => t, whitelistGifts });
  await chain.connect();
  return { chain, advance: (ms: number) => (t += ms) };
};

describe("MockAdapter whitelist gifts", () => {
  it("gives a claimant their rank's gift once: hidden croquettes in range, a box and a rat", async () => {
    const { chain } = await fresh();
    expect(await chain.whitelistGift()).toMatchObject({ status: "none", tier: null });
    expect(await chain.claimAllowList()).toMatchObject({ rank: 1, tier: 0 });
    expect(await chain.whitelistGift()).toMatchObject({ status: "ready", tier: 0, box: null, rat: null });
    expect(await chain.whitelistGiftCroq()).toBeNull();

    const supply = await chain.ratSupply(MOCK_YOU);
    const before = await chain.confidentialBalance();
    const gift = await chain.claimWhitelistGift();
    expect(gift).toMatchObject({ status: "claimed", tier: 0 });
    expect(gift.box).not.toBeNull();
    expect(gift.rat).not.toBeNull();

    const croq = (await chain.whitelistGiftCroq())!;
    const first = spec.whitelist.tiers[0]!;
    expect(croq >= BigInt(first.croqMin) && croq <= BigInt(first.croqMax)).toBe(true);
    expect(await chain.confidentialBalance()).toBe(before + croq);
    expect((await chain.ratsOf(MOCK_YOU)).map((r) => r.id)).toContain(gift.rat);
    // A gift rat is outside the paid caps and the wallet limit.
    expect(await chain.ratSupply(MOCK_YOU)).toEqual(supply);
    await expect(chain.claimWhitelistGift()).rejects.toThrow();
  });

  it("waits while the list is not frozen, closes after claimDays, and is absent when off", async () => {
    expect(await (await fresh("off")).chain.whitelistGift()).toBeNull();
    const waiting = (await fresh("waiting")).chain;
    await waiting.claimAllowList();
    expect(await waiting.whitelistGift()).toMatchObject({ status: "waiting", tier: null });
    await expect(waiting.claimWhitelistGift()).rejects.toThrow();

    const { chain, advance } = await fresh();
    await chain.claimAllowList();
    advance(spec.whitelist.claimDays * 86_400_000);
    expect(await chain.whitelistGift()).toMatchObject({ status: "closed", tier: 0 });
    await expect(chain.claimWhitelistGift()).rejects.toThrow();
  });
});
