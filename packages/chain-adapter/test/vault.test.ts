import { describe, expect, it } from "vitest";
import { ChainError, MOCK_NIGHT_SHIFT, MOCK_VAULT_NFT, MOCK_YOU, MockAdapter } from "../src";

const ETH = 10n ** 18n;
const USD = 1_000_000n;
const FRESH = "0x000000000000000000000000000000000000f00d";

const fresh = async (now?: () => number) => {
  const chain = new MockAdapter({ latency: 0, now });
  await chain.connect();
  return { chain, vault: chain.vault() };
};

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ChainError ? (e.reason ?? e.code) : String(e);
  }
  return "ok";
};

describe("MockVault", () => {
  it("opens with the night shift's two boxes, one on Seaport", async () => {
    const { vault } = await fresh();
    const boxes = await vault.boxes();
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.depositor === MOCK_NIGHT_SHIFT)).toBe(true);
    expect(boxes.filter((b) => b.state === "listed")).toHaveLength(1);
    expect(await vault.myBoxes()).toEqual([]);
  });

  it("seals a minted NFT and sends it out to a fresh address", async () => {
    const { vault } = await fresh();
    const tokenId = await vault.mintTestNft(MOCK_VAULT_NFT);
    expect(await vault.walletNfts(MOCK_VAULT_NFT)).toEqual([tokenId]);
    const boxId = await vault.deposit(MOCK_VAULT_NFT, tokenId);
    expect(await vault.walletNfts(MOCK_VAULT_NFT)).toEqual([]);
    expect(await vault.myBoxes()).toEqual([boxId]);
    expect((await vault.box(boxId)).depositor).toBe(MOCK_YOU);

    await vault.withdraw(boxId, FRESH);
    expect((await vault.box(boxId)).state).toBe("withdrawn");
    expect(await vault.myBoxes()).toEqual([]);
  });

  it("refuses what someone else's box asks", async () => {
    const { vault } = await fresh();
    const theirs = (await vault.boxes()).find((b) => b.state === "sealed")!;
    expect(await code(vault.withdraw(theirs.boxId, MOCK_YOU))).toBe("not-yours");
    expect((await vault.box(theirs.boxId)).state).toBe("sealed");
  });

  it("sells on Seaport and pays the key's holder", async () => {
    let now = 1_000_000;
    const { chain, vault } = await fresh(() => now);
    const boxId = await vault.deposit(MOCK_VAULT_NFT, await vault.mintTestNft(MOCK_VAULT_NFT));
    const listing = await vault.list(boxId, ETH / 10n, Math.floor(now / 1000) + 86_400);
    expect(listing.price).toBe(ETH / 10n);
    expect(await code(vault.send(boxId, FRESH))).toBe("WrongState");

    now += 60_000;
    const sold = await vault.box(boxId);
    expect(sold.state).toBe("sold");
    const before = await chain.balance(FRESH);
    const paid = await vault.claim(boxId, FRESH);
    expect(paid).toBe(sold.proceeds);
    expect((await chain.balance(FRESH)) - before).toBe(paid);
    expect((await vault.box(boxId)).state).toBe("claimed");
  });

  it("buys the night shift's listing like any Seaport buyer", async () => {
    const { chain, vault } = await fresh();
    const listed = (await vault.boxes()).find((b) => b.state === "listed")!;
    const before = await chain.balance(MOCK_YOU);
    await vault.buy(listed.boxId);
    expect((await chain.balance(MOCK_YOU)) - before).toBe(-listed.listing!.price);
    expect(await vault.walletNfts(MOCK_VAULT_NFT)).toEqual([listed.tokenId]);
    expect((await vault.box(listed.boxId)).state).toBe("sold");
  });

  it("a box given away needs its new holder's key", async () => {
    const { vault } = await fresh();
    const boxId = await vault.deposit(MOCK_VAULT_NFT, await vault.mintTestNft(MOCK_VAULT_NFT));
    await vault.send(boxId, MOCK_NIGHT_SHIFT);
    expect(await vault.myBoxes()).toEqual([]);
    expect(await code(vault.withdraw(boxId, MOCK_YOU))).toBe("not-yours");
  });

  it("sells privately to the night shift for a secret price", async () => {
    const { chain, vault } = await fresh();
    const boxId = await vault.deposit(MOCK_VAULT_NFT, await vault.mintTestNft(MOCK_VAULT_NFT));
    const before = await chain.confidentialUsdcBalance();
    const saleId = await vault.offerSale(boxId, MOCK_NIGHT_SHIFT, 5n * USD);
    expect((await vault.sales())[0]).toMatchObject({ saleId, status: "settled" });
    expect(await vault.salePrices([saleId])).toEqual({ [saleId]: 5n * USD });
    expect(await vault.myBoxes()).toEqual([]);
    expect((await chain.confidentialUsdcBalance()) - before).toBe(5n * USD - (5n * USD * 250n) / 10_000n);
  });
});
