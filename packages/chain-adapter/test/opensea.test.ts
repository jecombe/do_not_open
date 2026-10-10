import { describe, expect, it } from "vitest";
import { decodeAdvancedOrder, encodeAdvancedOrder, ITEM, MAINNET_WETH, marketOfferFromJson, marketOfferJson, OpenSeaError, OpenSeaOffers, OPENSEA_ZONE, SEAPORT_1_6, zoneExpiration, zoneFulfiller } from "../src/opensea";

const COLLECTION = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
const BUYER = "0x1111111111111111111111111111111111111111";
const FEES = "0x0000a26b00c1F0DF003000390027140000fAa719";
const FULFILLER = "0x2222222222222222222222222222222222222222";
const NOW = 1_800_000_000;

const item = (itemType: number, token: string, id: string, amount: string, recipient?: string) => ({
  itemType,
  token,
  identifierOrCriteria: id,
  startAmount: amount,
  endAmount: amount,
  ...(recipient ? { recipient } : {}),
});

/** A buyer's WETH offer as OpenSea's API lists it: `paid` WETH for `units` of `tokenId` (or any token, criteria 0), OpenSea's 1% in WETH. */
const order = (hash: string, paid: bigint, tokenId: string | null, units = "1", endTime = NOW + 3600) => ({
  order_hash: hash,
  protocol_address: SEAPORT_1_6,
  protocol_data: {
    parameters: {
      offerer: BUYER,
      zone: OPENSEA_ZONE,
      offer: [item(ITEM.ERC20, MAINNET_WETH, "0", paid.toString())],
      consideration: [
        tokenId === null ? item(ITEM.ERC721_WITH_CRITERIA, COLLECTION, "0", units, BUYER) : item(ITEM.ERC721, COLLECTION, tokenId, units, BUYER),
        item(ITEM.ERC20, MAINNET_WETH, "0", (paid / 100n).toString(), FEES),
      ],
      orderType: 2,
      startTime: String(NOW - 100),
      endTime: String(endTime),
      zoneHash: "0x" + "0".repeat(64),
      salt: "12345",
      conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      totalOriginalConsiderationItems: 2,
      counter: "0",
    },
    signature: "0x" + "ab".repeat(65),
  },
  criteria: tokenId === null ? { collection: { slug: "bayc" }, contract: { address: COLLECTION }, traits: null, numeric_traits: null, encoded_token_ids: null } : undefined,
});

/** OpenSea's signed zone's extraData (SIP-7): version 0, the fulfiller, the expiration, a 64-byte signature, context. */
const extraData = (fulfiller: string, expiration: number) => "0x00" + fulfiller.slice(2).toLowerCase() + expiration.toString(16).padStart(16, "0") + "cd".repeat(64) + "00";

/** OpenSea's API, canned: offers on token 1 and on the collection, a trait offer, an ended one, and the fulfillment. */
function fakeOpenSea(calls: { url: string; body?: unknown }[] = []) {
  const expiration = NOW + 120;
  return {
    calls,
    expiration,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (url.includes("/chain/ethereum/contract/")) return json({ address: COLLECTION, collection: "bayc" });
      if (url.endsWith("/offers/collection/bayc/nfts/1/best")) return json(order("0x" + "01".repeat(32), 10n ** 18n, "1"));
      if (url.endsWith("/offers/collection/bayc/nfts/2/best")) return json({ errors: ["not found"] }, 404);
      if (url.endsWith("/offers/collection/bayc")) {
        return json({
          offers: [
            order("0x" + "05".repeat(32), 4n * 10n ** 18n, null, "2"),
            { ...order("0x" + "06".repeat(32), 9n * 10n ** 18n, null), criteria: { traits: [{ type: "Fur", value: "Gold" }], encoded_token_ids: "1,2,3" } },
            { ...order("0x" + "02".repeat(32), 2n * 10n ** 18n, null), status: "cancelled" },
            order("0x" + "03".repeat(32), 3n * 10n ** 18n, null, "1", NOW - 1),
            order("0x" + "04".repeat(32), 10n ** 18n, "2"),
          ],
          next: null,
        });
      }
      if (url.endsWith("/offers/fulfillment_data")) {
        const body = JSON.parse(String(init!.body)) as { offer: { hash: string }; fulfiller: { address: string }; consideration: { token_id: string } };
        const hash = body.offer.hash;
        const wanted = hash === "0x" + "05".repeat(32) ? order(hash, 4n * 10n ** 18n, null, "2") : order(hash, 10n ** 18n, "1");
        const buyer = { parameters: wanted.protocol_data.parameters, numerator: "1", denominator: "1", signature: wanted.protocol_data.signature, extraData: extraData(body.fulfiller.address, expiration) };
        const mirror = { parameters: { ...wanted.protocol_data.parameters, offerer: body.fulfiller.address, offer: [item(ITEM.ERC721, COLLECTION, body.consideration.token_id, "1")], consideration: [] }, numerator: "1", denominator: "1", signature: "0x", extraData: "0x" };
        return json({
          protocol: "seaport1.6",
          fulfillment_data: {
            transaction: {
              function: "matchAdvancedOrders(...)",
              chain: 1,
              to: SEAPORT_1_6,
              value: 0,
              input_data: {
                orders: [mirror, buyer],
                criteriaResolvers: hash === "0x" + "05".repeat(32) ? [{ orderIndex: 1, side: 1, index: 0, identifier: body.consideration.token_id, criteriaProof: [] }] : [],
                fulfillments: [],
                recipient: body.fulfiller.address,
              },
            },
          },
        });
      }
      return json({ errors: ["no such route"] }, 404);
    }) as typeof fetch,
  };
}

describe("OpenSeaOffers", () => {
  it("lists the best WETH offer on a token and the collection's, best first, trait, dead, ended and other tokens' ones left out", async () => {
    const sea = fakeOpenSea();
    const client = new OpenSeaOffers({ apiKey: "k", fetch: sea.fetch });
    const offers = await client.offers(COLLECTION, 1n, NOW);
    expect(offers.map((o) => o.orderHash)).toEqual(["0x" + "05".repeat(32), "0x" + "01".repeat(32)]);
    // 4 WETH for 2 tokens, 1% fee: (4 - 0.04) / 2 nets 1.98 each.
    expect(offers[0]).toMatchObject({ anyToken: true, buyer: BUYER, amount: 198n * 10n ** 16n, endTime: NOW + 3600, protocolAddress: SEAPORT_1_6 });
    expect(offers[1]).toMatchObject({ anyToken: false, amount: 99n * 10n ** 16n });
    expect(offers[1]!.parameters.consideration[0]!.identifierOrCriteria).toBe(1n);
    // The key goes in the header, never in the URL.
    expect(sea.calls.every((c) => !c.url.includes("k="))).toBe(true);
    expect(sea.calls.map((c) => c.url)).toEqual(expect.arrayContaining([expect.stringContaining("/chain/ethereum/contract/" + COLLECTION), expect.stringContaining("/offers/collection/bayc/nfts/1/best"), expect.stringMatching(/\/offers\/collection\/bayc$/)]));
    // A token OpenSea has no offer on: the collection's still show.
    expect((await client.offers(COLLECTION, 2n, NOW)).map((o) => o.orderHash)).toEqual(["0x" + "05".repeat(32), "0x" + "04".repeat(32)]);
  });

  it("asks OpenSea the order that fills an offer for the fulfiller, and encodes it with its criteria proof as finalizeOffer takes it", async () => {
    const sea = fakeOpenSea();
    const client = new OpenSeaOffers({ apiKey: "k", fetch: sea.fetch });
    const hash = "0x" + "05".repeat(32);
    const { offer, expiresAt } = await client.fulfillment(hash, SEAPORT_1_6, FULFILLER, COLLECTION, 7n);
    expect(expiresAt).toBe(sea.expiration);
    expect(sea.calls.at(-1)?.body).toEqual({
      offer: { hash, chain: "ethereum", protocol_address: SEAPORT_1_6 },
      fulfiller: { address: FULFILLER },
      consideration: { asset_contract_address: COLLECTION, token_id: "7" },
    });
    const decoded = decodeAdvancedOrder(offer);
    expect(decoded.order.parameters.offerer).toBe(BUYER);
    expect(decoded.order.parameters.offer[0]!.startAmount).toBe(4n * 10n ** 18n);
    expect(decoded.order.parameters.consideration[0]!.itemType).toBe(ITEM.ERC721_WITH_CRITERIA);
    expect(decoded.order.signature).toBe("0x" + "ab".repeat(65));
    expect(zoneFulfiller(decoded.order.extraData)).toBe(FULFILLER.toLowerCase());
    expect(zoneExpiration(decoded.order.extraData)).toBe(sea.expiration);
    expect(decoded.criteriaProof).toEqual([]);
  });

  it("refuses an order OpenSea signed for someone else", async () => {
    const sea = fakeOpenSea();
    const fetchFn: typeof fetch = async (input, init) => {
      const res = await sea.fetch(input, init);
      if (!String(input).endsWith("/offers/fulfillment_data")) return res;
      const data = await res.json();
      data.fulfillment_data.transaction.input_data.orders[1].extraData = extraData(BUYER, sea.expiration);
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const client = new OpenSeaOffers({ apiKey: "k", fetch: fetchFn });
    await expect(client.fulfillment("0x" + "01".repeat(32), SEAPORT_1_6, FULFILLER, COLLECTION, 1n)).rejects.toThrow(/signed for/);
  });

  it("turns OpenSea's refusals and outages into OpenSeaError with the status", async () => {
    const down = new OpenSeaOffers({ apiKey: "k", fetch: (async () => new Response("rate limited", { status: 429 })) as typeof fetch });
    await expect(down.offers(COLLECTION, 1n)).rejects.toMatchObject({ status: 429 });
    const gone = new OpenSeaOffers({
      apiKey: "k",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const error = await gone.offers(COLLECTION, 1n).catch((e) => e);
    expect(error).toBeInstanceOf(OpenSeaError);
    expect(error.status).toBe(503);
  });

  it("carries an offer through JSON and back, and an order through abi encoding and back", () => {
    const o = { orderHash: "0x" + "01".repeat(32), protocolAddress: SEAPORT_1_6, buyer: BUYER, amount: 5n, endTime: NOW, anyToken: false, parameters: decodeAdvancedOrder(encodeAdvancedOrder({ parameters: marketOfferFromJson(JSON.parse(JSON.stringify(marketOfferJson({ orderHash: "0x", protocolAddress: "", buyer: BUYER, amount: 0n, endTime: 0, anyToken: false, parameters: orderOf() })))).parameters, numerator: 1n, denominator: 1n, signature: "0x", extraData: "0x" })).order.parameters };
    expect(marketOfferFromJson(JSON.parse(JSON.stringify(marketOfferJson(o))))).toEqual(o);
    expect(zoneExpiration("0x")).toBeNull();
    expect(zoneFulfiller("0x1234")).toBeNull();
  });
});

function orderOf() {
  const raw = order("0x", 10n ** 18n, "1").protocol_data.parameters;
  return {
    offerer: raw.offerer,
    zone: raw.zone,
    offer: raw.offer.map((i) => ({ itemType: i.itemType, token: i.token, identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: BigInt(i.startAmount), endAmount: BigInt(i.endAmount) })),
    consideration: raw.consideration.map((i) => ({ itemType: i.itemType, token: i.token, identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: BigInt(i.startAmount), endAmount: BigInt(i.endAmount), recipient: i.recipient! })),
    orderType: raw.orderType,
    startTime: BigInt(raw.startTime),
    endTime: BigInt(raw.endTime),
    zoneHash: raw.zoneHash,
    salt: BigInt(raw.salt),
    conduitKey: raw.conduitKey,
    totalOriginalConsiderationItems: 2n,
  };
}
