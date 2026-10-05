import { describe, expect, it } from "vitest";
import { spec } from "@dno/game-spec";
import { ChainError, MOCK_MARKET, MOCK_NIGHT_SHIFT, MOCK_YOU, MockAdapter } from "../src";

const USD = 1_000_000n;
const fee = (price: bigint) => (price * BigInt(spec.market.feeBps)) / 10_000n;

const fresh = async (fleaMarket = false) => {
  const chain = new MockAdapter({ latency: 0, fleaMarket });
  await chain.connect();
  return chain;
};

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ChainError ? (e.reason ?? e.code) : String(e);
  }
  return "ok";
};

describe("MockAdapter flea market", () => {
  it("states the spec's terms", async () => {
    const chain = await fresh();
    expect(await chain.fleaMarket()).toMatchObject({ feeBps: spec.market.feeBps, maxPrice: BigInt(spec.market.maxPriceUsdc) * USD });
  });

  it("opens the night shift's stalls when asked: a sealed box, a cat and two rats", async () => {
    const chain = await fresh(true);
    const listings = await chain.listings({ status: "active" });
    expect(listings).toHaveLength(4);
    expect(listings.every((l) => l.seller === MOCK_NIGHT_SHIFT)).toBe(true);
    const boxes = listings.filter((l) => l.collection === "boxes");
    const statuses = await Promise.all(boxes.map(async (l) => (await chain.box(l.tokenId)).status));
    expect(statuses.sort()).toEqual(["revealed", "sealed"]);
    for (const l of listings.filter((l) => l.collection === "rats")) expect((await chain.rat(l.tokenId)).owner).toBe(MOCK_MARKET);
  });

  it("lists your box, which leaves your boxes until it is sold or taken back", async () => {
    const chain = await fresh();
    const [box] = await chain.boxesOf(MOCK_YOU);
    const listing = await chain.listItem("boxes", box!, 10n * USD);
    expect(listing).toMatchObject({ status: "active", seller: MOCK_YOU, price: 10n * USD, collection: "boxes" });
    expect(await chain.boxesOf(MOCK_YOU)).not.toContain(box);
    await chain.repriceListing(listing.listingId, 8n * USD);
    expect((await chain.listings({ seller: MOCK_YOU }))[0]!.price).toBe(8n * USD);
    await chain.cancelListing(listing.listingId);
    expect(await chain.boxesOf(MOCK_YOU)).toContain(box);
    expect(await code(chain.cancelListing(listing.listingId))).toBe("ListingNotActive");
  });

  it("refuses a box you do not hold, as the arrival proof would", async () => {
    const chain = await fresh();
    const theirs = (await chain.boxSummaries(0, 6)).find((b) => !b.mine)!.tokenId;
    expect(await code(chain.listItem("boxes", theirs, USD))).toBe("not-yours");
    expect((await chain.listings())[0]!.status).toBe("refused");
  });

  it("refuses prices out of range", async () => {
    const chain = await fresh();
    const [box] = await chain.boxesOf(MOCK_YOU);
    expect(await code(chain.listItem("boxes", box!, 0n))).toBe("BadPrice");
    expect(await code(chain.listItem("boxes", box!, (BigInt(spec.market.maxPriceUsdc) + 1n) * USD))).toBe("BadPrice");
  });

  it("buys at the asking price: paid in cUSDC, the item delivered, the seller paid less the fee", async () => {
    const chain = await fresh(true);
    const cat = (await chain.listings({ status: "active", collection: "boxes" })).find((l) => l.price === 30n * USD)!;
    expect(await code(chain.buyListing(cat.listingId))).toBe("unpaid");
    await chain.shieldUsdc(50n * USD);
    const before = await chain.confidentialUsdcBalance();
    await chain.buyListing(cat.listingId);
    expect(await chain.confidentialUsdcBalance()).toBe(before - 30n * USD);
    expect(await chain.boxesOf(MOCK_YOU)).toContain(cat.tokenId);
    expect((await chain.box(cat.tokenId)).revealed).not.toBeNull();
    expect(await code(chain.buyListing(cat.listingId))).toBe("ListingNotActive");
  });

  it("refuses buying your own listing", async () => {
    const chain = await fresh();
    const [box] = await chain.boxesOf(MOCK_YOU);
    const listing = await chain.listItem("boxes", box!, 10n * USD);
    expect(await code(chain.buyListing(listing.listingId))).toBe("OwnListing");
  });

  it("sells a rat to the night shift's secret offer, which only you and they can read", async () => {
    const chain = await fresh(true);
    const rat = await chain.mintSeedRat(77n);
    const listing = await chain.listItem("rats", rat, 4n * USD);
    expect(await chain.ratsOf(MOCK_YOU)).toHaveLength(0);
    const [offer] = await chain.offers({ listingId: listing.listingId, status: "open" });
    expect(offer!.buyer).toBe(MOCK_NIGHT_SHIFT);
    const amounts = await chain.offerAmounts([offer!.offerId]);
    const amount = amounts[offer!.offerId]!;
    expect(amount).toBeGreaterThan(0n);
    expect(amount).toBeLessThan(4n * USD);
    const before = await chain.confidentialUsdcBalance();
    await chain.acceptOffer(offer!.offerId);
    expect(await chain.confidentialUsdcBalance()).toBe(before + amount - fee(amount));
    expect((await chain.rat(rat)).owner).toBe(MOCK_NIGHT_SHIFT);
    expect((await chain.listings())[0]!.status).toBe("sold");
  });

  it("has your fair offer taken by the night shift, and a low one left open to withdraw", async () => {
    const chain = await fresh(true);
    const rats = (await chain.listings({ status: "active", collection: "rats" })).sort((a, b) => Number(a.price - b.price));
    const [cheap, dear] = rats as [(typeof rats)[0], (typeof rats)[0]];
    const before = await chain.confidentialUsdcBalance();
    const low = await chain.makeOffer(dear.listingId, USD);
    expect((await chain.offers({ buyer: MOCK_YOU, status: "open" })).map((o) => o.offerId)).toEqual([low]);
    expect(await chain.offerAmounts([low])).toEqual({ [low]: USD });
    await chain.withdrawOffer(low);
    expect(await chain.confidentialUsdcBalance()).toBe(before);
    expect(await code(chain.withdrawOffer(low))).toBe("OfferNotOpen");

    await chain.makeOffer(cheap.listingId, (cheap.price * 8n) / 10n);
    expect(await chain.ratsOf(MOCK_YOU)).toHaveLength(1);
    expect(await chain.confidentialUsdcBalance()).toBe(before - (cheap.price * 8n) / 10n);
  });

  it("refuses to sell a box whose public state changed in escrow", async () => {
    const chain = await fresh(true);
    const [a, b] = await chain.boxesOf(MOCK_YOU);
    // The mock's night shift accepts every entanglement; here both boxes are yours.
    await chain.proposeEntangle(a!, b!);
    await chain.acceptEntangle(a!, b!);
    const listing = await chain.listItem("boxes", a!, 5n * USD);
    await chain.observe(b!);
    expect((await chain.box(a!)).status).toBe("revealed");
    const [offer] = await chain.offers({ listingId: listing.listingId });
    expect(await code(chain.acceptOffer(offer!.offerId))).toBe("StateChanged");
    await chain.cancelListing(listing.listingId);
    expect(await chain.boxesOf(MOCK_YOU)).toContain(a);
  });
});
