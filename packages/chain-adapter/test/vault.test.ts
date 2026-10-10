import { describe, expect, it } from "vitest";
import { ChainError, decoySends, MOCK_DESK, MOCK_NIGHT_SHIFT, MOCK_VAULT_NFT, MOCK_YOU, MockAdapter, pocketGroup, pocketSet, vaultLinks } from "../src";

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

describe("MockVault pockets", () => {
  const withPocket = async () => {
    const { chain, vault } = await fresh();
    const pockets = vault.pockets()!;
    const id = await pockets.open();
    return { chain, vault, pockets, id };
  };

  it("opens one pocket per wallet, among strangers' pockets, empty", async () => {
    const { pockets, id } = await withPocket();
    expect(await pockets.mine()).toBe(id);
    expect(await pockets.open()).toBe(id);
    expect(await pockets.balance()).toBe(0n);
    expect((await pockets.info()).count).toBeGreaterThan(id);
  });

  it("deposits from the wallet's cUSDC, sends to another pocket and takes it out", async () => {
    const { chain, pockets } = await withPocket();
    const before = await chain.confidentialUsdcBalance();
    await pockets.deposit(12n * USD);
    expect(await pockets.balance()).toBe(12n * USD);
    expect(before - (await chain.confidentialUsdcBalance())).toBe(12n * USD);
    await pockets.send(0, 5n * USD);
    expect(await pockets.balance()).toBe(7n * USD);
    await pockets.withdraw(FRESH, 2n * USD);
    expect(await pockets.balance()).toBe(5n * USD);
    expect(await chain.confidentialUsdcBalance()).toBe(before - 12n * USD);
  });

  it("moves nothing, without an error, when the pocket is short", async () => {
    const { pockets } = await withPocket();
    await pockets.deposit(10n * USD);
    await pockets.send(0, 11n * USD);
    await pockets.withdraw(FRESH, 11n * USD);
    expect(await pockets.balance()).toBe(10n * USD);
  });

  it("asks for a pocket before any spend", async () => {
    const { vault } = await fresh();
    expect(await code(vault.pockets()!.send(0, 1n))).toBe("not-yours");
    expect(await vault.pockets()!.mine()).toBeNull();
  });

  it("buys the night shift's box offered to the pocket, and the box answers to the wallet's key", async () => {
    const { vault, pockets } = await withPocket();
    await pockets.deposit(15n * USD);
    const [sale] = await pockets.sales();
    expect(sale).toMatchObject({ status: "open", buyer: MOCK_DESK });
    const price = (await pockets.salePrices([sale!.saleId]))[sale!.saleId]!;
    expect(await pockets.buy(sale!.saleId)).toBe(true);
    expect(await pockets.balance()).toBe(15n * USD - price);
    expect(await pockets.boxes()).toEqual([sale!.boxId]);
    expect(await vault.myBoxes()).toEqual([]);
    // The key is the wallet's: the NFT comes out.
    await vault.withdraw(sale!.boxId, FRESH);
    expect(await pockets.boxes()).toEqual([]);
  });

  it("refuses a purchase the pocket cannot cover, and the sale stays open", async () => {
    const { pockets } = await withPocket();
    const [sale] = await pockets.sales();
    expect(await code(pockets.buy(sale!.saleId))).toBe("not-yours");
    expect((await pockets.sales())[0]).toMatchObject({ status: "open" });
  });

  it("sells a box privately to the night shift's pocket, which pays at once", async () => {
    const { chain, vault, pockets } = await withPocket();
    const boxId = await vault.deposit(MOCK_VAULT_NFT, await vault.mintTestNft(MOCK_VAULT_NFT));
    const before = await chain.confidentialUsdcBalance();
    const night = (await pockets.info()).count - 2;
    await pockets.offerSale(boxId, night, 10n * USD);
    expect(await vault.myBoxes()).toEqual([]);
    expect((await chain.confidentialUsdcBalance()) - before).toBe(10n * USD - (10n * USD * 250n) / 10_000n);
  });
});

describe("pocketGroup and pocketSet", () => {
  it("groups pockets by number, the same set for every member, however many times it is asked", () => {
    expect(pocketGroup(7, 20, 5)).toEqual([5, 6, 7, 8, 9]);
    for (const member of [5, 6, 8, 9]) expect(pocketGroup(member, 20, 5)).toEqual([5, 6, 7, 8, 9]);
    expect(pocketGroup(3, 20, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(pocketSet(7, 20, 5)).toEqual(pocketSet(7, 20, 5));
    expect(pocketSet(7, 20, 5)).toEqual([5, 6, 7, 8, 9]);
  });

  it("gives the last group the pockets opened so far, and never names one that does not exist", () => {
    expect(pocketGroup(12, 13, 5)).toEqual([10, 11, 12]);
    expect(pocketGroup(0, 1, 5)).toEqual([0]);
    expect(pocketGroup(10, 11, 5)).toEqual([10]);
  });

  it("names fewer others, when asked, still the same ones every time, in order", () => {
    expect(pocketSet(7, 20, 5, 2)).toEqual([5, 6, 7]);
    expect(pocketSet(9, 20, 5, 2)).toEqual([5, 6, 9]);
    expect(pocketSet(7, 20, 5, 0)).toEqual([7]);
    expect(pocketSet(7, 20, 5, 9)).toEqual([5, 6, 7, 8, 9]);
  });
});

describe("decoySends", () => {
  const crowd = ["0x00000000000000000000000000000000000000A1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000A3"] as const;

  it("sends to the crowd's wallets first, none twice, then to fresh addresses", () => {
    const sends = decoySends(5, [...crowd]);
    expect(sends).toHaveLength(5);
    expect(sends.every((s) => !s.really)).toBe(true);
    const named = sends.map((s) => s.to.toLowerCase());
    expect(new Set(named).size).toBe(5);
    expect(crowd.every((a) => named.includes(a.toLowerCase()))).toBe(true);
  });

  it("picks at random among a crowd larger than the decoys, and caps the count", () => {
    const big = Array.from({ length: 40 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const picks = new Set<string>();
    for (let i = 0; i < 30; i++) for (const s of decoySends(2, big)) picks.add(s.to);
    expect(picks.size).toBeGreaterThan(4);
    expect(decoySends(9, big)).toHaveLength(5);
    expect(decoySends(0, big)).toEqual([]);
  });
});

describe("MockVault crowd", () => {
  it("counts the wallets that use the vault, the connected one left out, and who may hold each box", async () => {
    const { vault } = await fresh();
    const before = await vault.crowd();
    expect(before.wallets).not.toContain(MOCK_YOU);
    expect(before.wallets).toContain(MOCK_NIGHT_SHIFT);
    expect(before.wallets.length).toBeGreaterThanOrEqual(3);
    // The night shift's boxes went to nobody else: it is their obvious holder.
    for (const b of await vault.boxes()) expect(before.holders[b.boxId]).toBe(1);

    const alone = await vault.deposit(MOCK_VAULT_NFT, await vault.mintTestNft(MOCK_VAULT_NFT));
    const hidden = await vault.deposit(MOCK_VAULT_NFT, await vault.mintTestNft(MOCK_VAULT_NFT), { decoys: 3 });
    const after = await vault.crowd();
    expect(after.holders[alone]).toBe(1);
    expect(after.holders[hidden]).toBe(4);
    // A decoy sent to a fresh address nobody uses does not count as a holder.
    const sent = await vault.deposit(MOCK_VAULT_NFT, await vault.mintTestNft(MOCK_VAULT_NFT));
    await vault.send(sent, FRESH);
    expect((await vault.crowd()).holders[sent]).toBe(1);
  });

  it("tells a pocket's group, always the same, and the wallets that fed it", async () => {
    const { vault } = await fresh();
    const pockets = vault.pockets()!;
    const id = await pockets.open();
    const { count, maxSet } = await pockets.info();
    const group = await pockets.group(id);
    expect(group.size).toBe(maxSet);
    expect(group.members).toEqual(pocketGroup(id, count, maxSet));
    expect(group.members).toContain(id);
    // The strangers fed their own pockets; this wallet has not yet.
    const feeders = group.feeders;
    await pockets.deposit(3n * USD);
    expect((await pockets.group(id)).feeders).toBe(feeders + 1);
    await pockets.deposit(3n * USD);
    expect((await pockets.group(id)).feeders).toBe(feeders + 1);
  });
});

describe("MockVault pockets of other tokens", () => {
  it("holds cUSDC, cUSDT, cWETH and cZAMA, the cUSDC pockets first and the only ones with the desk", async () => {
    const { vault } = await fresh();
    expect(vault.pocketTokens().map((t) => t.symbol)).toEqual(["cUSDC", "cUSDT", "cWETH", "cZAMA"]);
    expect(vault.pocketTokens().map((t) => t.desk)).toEqual([true, false, false, false]);
    expect(vault.pockets()!.token.symbol).toBe("cUSDC");
    expect(vault.pockets("czama")!.token.symbol).toBe("cZAMA");
    expect(vault.pockets("cDOGE")).toBeNull();
    expect((await vault.pockets("cWETH")!.info()).desk).toBeNull();
  });

  it("mints, wraps 18-decimal WETH to 6-decimal cWETH, and moves it between pockets", async () => {
    const { vault } = await fresh();
    const weth = vault.pockets("cWETH")!;
    const id = await weth.open();
    await weth.faucet();
    expect(await weth.plainBalance()).toBe(10n ** 18n);
    await weth.shield(250_000n);
    expect(await weth.plainBalance()).toBe(10n ** 18n - 250_000n * 10n ** 12n);
    await weth.deposit(200_000n);
    expect(await weth.balance()).toBe(200_000n);
    await weth.send(0, 50_000n);
    await weth.withdraw(FRESH, 25_000n);
    expect(await weth.balance()).toBe(125_000n);
    // The cUSDC pocket is another pocket: empty, its number its own.
    const usdc = vault.pockets()!;
    expect(await usdc.mine()).toBeNull();
    expect(id).toBeGreaterThan(0);
    await expect(weth.shield(10n ** 9n)).rejects.toThrow(/WETH/);
  });

  it("buys no private sales outside cUSDC", async () => {
    const { vault } = await fresh();
    const zama = vault.pockets("cZAMA")!;
    await zama.open();
    expect(await zama.sales()).toEqual([]);
    expect(await zama.boxes()).toEqual([]);
    await expect(zama.buy(0)).rejects.toThrow(/cUSDC/);
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
