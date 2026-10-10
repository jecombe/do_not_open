import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenSeaError, type MarketOffer } from "@dno/chain-adapter/opensea";
import { SignIn } from "../src/application/auth";
import { ImageArchive } from "../src/application/archive";
import { Metadata } from "../src/application/metadata";
import { Queries } from "../src/application/queries";
import { VaultMarket, type OfferSource } from "../src/application/vaultMarket";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import { buildServer } from "../src/infrastructure/http/server";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { FakeChainState } from "./fixtures";

const COLLECTION = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";
const FULFILLER = "0x43b2e0d7a75100545556bad1b9fa6f926721898a";
const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395";
const BUYER = "0x1111111111111111111111111111111111111111";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const HASH = "0x" + "ab".repeat(32);

const offer = (orderHash: string, amount: bigint): MarketOffer => ({
  orderHash,
  protocolAddress: SEAPORT,
  buyer: BUYER,
  amount,
  endTime: 1_800_000_000,
  anyToken: false,
  parameters: {
    offerer: BUYER,
    zone: "0x000056f7000000ece9003ca63978907a00ffd100",
    offer: [{ itemType: 1, token: WETH, identifierOrCriteria: 0n, startAmount: amount, endAmount: amount }],
    consideration: [{ itemType: 2, token: COLLECTION, identifierOrCriteria: 1n, startAmount: 1n, endAmount: 1n, recipient: BUYER }],
    orderType: 2,
    startTime: 0n,
    endTime: 1_800_000_000n,
    zoneHash: "0x" + "0".repeat(64),
    salt: 1n,
    conduitKey: "0x" + "0".repeat(64),
    totalOriginalConsiderationItems: 1n,
  },
});

/** OpenSea, canned: what it was asked, and what it answers. */
class FakeSource implements OfferSource {
  reads = 0;
  fulfillments: { orderHash: string; protocolAddress: string; fulfiller: string; collection: string; tokenId: bigint }[] = [];
  fail: OpenSeaError | null = null;
  async offers(_collection: string, tokenId: bigint): Promise<MarketOffer[]> {
    this.reads++;
    if (this.fail) throw this.fail;
    return tokenId === 1n ? [offer(HASH, 10n ** 18n), offer("0x" + "cd".repeat(32), 5n * 10n ** 17n)] : [];
  }
  async fulfillment(orderHash: string, protocolAddress: string, fulfiller: string, collection: string, tokenId: bigint) {
    this.fulfillments.push({ orderHash, protocolAddress, fulfiller, collection, tokenId });
    return { offer: "0x" + "ef".repeat(400), expiresAt: 1_790_000_120 };
  }
}

describe("the marketplace's offers for the vault's page", () => {
  let app: FastifyInstance;
  let bare: FastifyInstance;
  const source = new FakeSource();
  let now = 1_790_000_000;
  const market = new VaultMarket("opensea", source, FULFILLER, { now: () => now }, 15);

  beforeAll(async () => {
    const store = new MemoryStore();
    const queries = new Queries(store, new FakeChainState());
    const deps = {
      queries,
      metadata: new Metadata(queries, "http://api.test", new ImageArchive(store, "https://arweave.test")),
      signIn: new SignIn(store, ethersVerifier, new HmacSessions("x".repeat(32)), { now: () => 0 }, "donotopen.test", () => "nonce"),
      corsOrigins: ["*"],
      rateLimitPerMinute: 1000,
    };
    app = await buildServer({ ...deps, vaultMarket: market, vaultRelayRatePerMinute: 1000 } as Parameters<typeof buildServer>[0]);
    bare = await buildServer(deps as Parameters<typeof buildServer>[0]);
  });

  afterAll(async () => {
    await app.close();
    await bare.close();
  });

  it("names the marketplace and the contract it signs for, or none", async () => {
    expect((await app.inject({ url: "/v1/vault/market" })).json().data).toEqual({ name: "opensea", fulfiller: FULFILLER });
    expect((await bare.inject({ url: "/v1/vault/market" })).json().data).toEqual({ name: null, fulfiller: null });
    expect((await bare.inject({ url: `/v1/vault/offers/${COLLECTION}/1` })).statusCode).toBe(404);
    expect((await bare.inject({ method: "POST", url: "/v1/vault/offers/fulfillment", payload: {} })).statusCode).toBe(404);
  });

  it("lists a token's offers as JSON, read from the marketplace once every few seconds", async () => {
    const res = await app.inject({ url: `/v1/vault/offers/${COLLECTION}/1` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=10");
    const { offers } = res.json().data;
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({ orderHash: HASH, buyer: BUYER, amount: "1000000000000000000", endTime: 1_800_000_000, anyToken: false, protocolAddress: SEAPORT });
    expect(offers[0].parameters.offer[0]).toEqual({ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: "1000000000000000000", endAmount: "1000000000000000000" });
    const reads = source.reads;
    await app.inject({ url: `/v1/vault/offers/${COLLECTION}/1` });
    expect(source.reads).toBe(reads);
    now += 20;
    await app.inject({ url: `/v1/vault/offers/${COLLECTION}/1` });
    expect(source.reads).toBe(reads + 1);
    expect((await app.inject({ url: `/v1/vault/offers/${COLLECTION}/2` })).json().data.offers).toEqual([]);
    expect((await app.inject({ url: `/v1/vault/offers/not-an-address/1` })).statusCode).toBe(400);
  });

  it("asks the marketplace the order that fills an offer, for the vault's filler, and never caches it", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/vault/offers/fulfillment", payload: { orderHash: HASH, collection: COLLECTION, tokenId: "1" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ offer: "0x" + "ef".repeat(400), expiresAt: 1_790_000_120 });
    expect(source.fulfillments.at(-1)).toEqual({ orderHash: HASH, protocolAddress: SEAPORT, fulfiller: FULFILLER, collection: COLLECTION, tokenId: 1n });
    const again = await app.inject({ method: "POST", url: "/v1/vault/offers/fulfillment", payload: { orderHash: HASH, collection: COLLECTION, tokenId: "1" } });
    expect(again.statusCode).toBe(200);
    expect(source.fulfillments).toHaveLength(2);
  });

  it("refuses an offer the marketplace does not hold on that token, and a malformed body", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/vault/offers/fulfillment", payload: { orderHash: HASH, collection: COLLECTION, tokenId: "2" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not-found");
    expect((await app.inject({ method: "POST", url: "/v1/vault/offers/fulfillment", payload: { orderHash: "0x12", collection: COLLECTION, tokenId: "1" } })).statusCode).toBe(400);
  });

  it("passes the marketplace's refusals on as 429 or 502, without caching them", async () => {
    now += 20;
    source.fail = new OpenSeaError(429, "slow down");
    const res = await app.inject({ url: `/v1/vault/offers/${COLLECTION}/1` });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("marketplace");
    source.fail = new OpenSeaError(503, "down");
    expect((await app.inject({ url: `/v1/vault/offers/${COLLECTION}/1` })).statusCode).toBe(502);
    source.fail = null;
    expect((await app.inject({ url: `/v1/vault/offers/${COLLECTION}/1` })).statusCode).toBe(200);
  });
});
