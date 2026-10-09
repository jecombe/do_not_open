import { describe, expect, it } from "vitest";
import { ChainError, MOCK_NIGHT_SHIFT, MOCK_VAULT_NFT, MOCK_YOU, MockAdapter, vaultLinks } from "../src";

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

  it("the night shift offers WETH for a sealed NFT; accepting it pays out at once", async () => {
    const { chain, vault } = await fresh();
    const boxId = await vault.deposit(MOCK_VAULT_NFT, await vault.mintTestNft(MOCK_VAULT_NFT));
    const [offer] = await vault.offers(boxId);
    expect(offer).toMatchObject({ buyer: MOCK_NIGHT_SHIFT, anyToken: false });
    const before = await chain.balance(FRESH);
    const paid = await vault.acceptOffer(boxId, offer!.orderHash, FRESH);
    expect(paid).toBe(offer!.amount - (offer!.amount * 250n) / 10_000n);
    expect((await chain.balance(FRESH)) - before).toBe(paid);
    expect((await vault.box(boxId)).state).toBe("claimed");
    expect(await vault.offers(boxId)).toEqual([]);
    expect(await code(vault.acceptOffer(boxId, offer!.orderHash, FRESH))).toBe("WrongState");
  });

  it("anyone may offer on someone else's box, and only its holder accepts", async () => {
    const { vault } = await fresh();
    const theirs = (await vault.boxes()).find((b) => b.state === "sealed")!;
    const orderHash = await vault.makeOffer(theirs.boxId, ETH / 50n, Math.floor(Date.now() / 1000) + 86_400);
    expect((await vault.offers(theirs.boxId)).map((o) => o.orderHash)).toContain(orderHash);
    expect(await code(vault.acceptOffer(theirs.boxId, orderHash, MOCK_YOU))).toBe("not-yours");
    await vault.cancelOffer(orderHash);
    expect((await vault.offers(theirs.boxId)).map((o) => o.orderHash)).not.toContain(orderHash);
  });

  it("delegates a box's NFT, and taking it out clears the delegate", async () => {
    const { vault } = await fresh();
    const boxId = await vault.deposit(MOCK_VAULT_NFT, await vault.mintTestNft(MOCK_VAULT_NFT));
    await vault.delegate(boxId, FRESH);
    expect((await vault.box(boxId)).delegate).toBe(FRESH);
    await vault.delegate(boxId, null);
    expect((await vault.box(boxId)).delegate).toBe(null);
    await vault.delegate(boxId, FRESH);
    await vault.withdraw(boxId, FRESH);
    expect((await vault.box(boxId)).delegate).toBe(null);
    const theirs = (await vault.boxes()).find((b) => b.state === "sealed" && b.boxId !== boxId)!;
    expect(await code(vault.delegate(theirs.boxId, MOCK_YOU))).toBe("not-yours");
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

describe("vaultLinks", () => {
  it("links addresses, transactions and NFTs where the chain has somewhere to look", () => {
    const links = vaultLinks({ explorer: "https://sepolia.etherscan.io", marketplace: null });
    expect(links.address(FRESH)).toBe(`https://sepolia.etherscan.io/address/${FRESH}`);
    expect(links.tx("0xabc")).toBe("https://sepolia.etherscan.io/tx/0xabc");
    expect(links.nft(MOCK_VAULT_NFT, 7n)).toBe(`https://sepolia.etherscan.io/nft/${MOCK_VAULT_NFT}/7`);
    expect(links.marketplace(MOCK_VAULT_NFT, 7n)).toBeNull();
    expect(vaultLinks({ explorer: null, marketplace: "https://opensea.io/item/ethereum" }).marketplace(MOCK_VAULT_NFT, 7n)).toBe(
      `https://opensea.io/item/ethereum/${MOCK_VAULT_NFT}/7`,
    );
  });

  it("has nothing to link in the demo", async () => {
    const { vault } = await fresh();
    const links = vaultLinks(await vault!.info());
    expect(links.address(FRESH)).toBeNull();
    expect(links.nft(MOCK_VAULT_NFT, 1n)).toBeNull();
  });
});
