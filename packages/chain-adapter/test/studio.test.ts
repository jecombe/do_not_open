import { describe, expect, it } from "vitest";
import { studio } from "@dno/game-spec";
import { ChainError, MOCK_YOU, MockAdapter } from "../src";

const fresh = async () => {
  const chain = new MockAdapter({ latency: 0 });
  await chain.connect();
  return chain;
};

describe("MockAdapter studio", () => {
  it("sells the packs of studio.json, priced in plain USDC", async () => {
    const chain = await fresh();
    const packs = await chain.studioPacks();
    expect(packs?.map((p) => [p.id, p.key, p.sketches, p.models])).toEqual(studio.packs.map((p) => [p.id, p.key, p.sketches, p.models]));
    expect(packs?.[0]?.price).toBe(2_000_000n);
  });

  it("takes the price in USDC and counts the units bought, with no API in between", async () => {
    const chain = await fresh();
    const before = await chain.usdcBalance(MOCK_YOU);
    expect(chain.studioPending(null)).toEqual({ sketches: 0, models: 0 });
    await chain.buyStudioPack(0);
    await chain.buyStudioPack(1);
    expect(await chain.usdcBalance(MOCK_YOU)).toBe(before - 10_000_000n);
    expect(chain.studioPending(null)).toEqual({ sketches: 60, models: 6 });
    expect(await chain.apiSession()).toBeNull();
  });

  it("refuses an unknown pack and a wallet short of USDC, charging nothing", async () => {
    const chain = await fresh();
    await expect(chain.buyStudioPack(9)).rejects.toBeInstanceOf(ChainError);
    const held = await chain.usdcBalance(MOCK_YOU);
    await chain.shieldUsdc(held);
    await expect(chain.buyStudioPack(0)).rejects.toMatchObject({ code: "insufficient-usdc" });
    expect(chain.studioPending(null)).toEqual({ sketches: 0, models: 0 });
  });
});
