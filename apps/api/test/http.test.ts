import { Wallet } from "ethers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignIn } from "../src/application/auth";
import { AcceptTerms } from "../src/application/terms";
import { AllowList } from "../src/application/allowList";
import { allowListMessage } from "@dno/chain-adapter/standings";
import { ImageArchive, sha256Hex } from "../src/application/archive";
import { Metadata, sealedImageOf } from "../src/application/metadata";
import { silentLogger } from "../src/application/ports/logger";
import { Queries } from "../src/application/queries";
import { SyncChain } from "../src/application/syncChain";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import { buildServer } from "../src/infrastructure/http/server";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ALICE, BOB, ev, FakeChain, FakeChainState } from "./fixtures";

const wallet = Wallet.createRandom();
const WALLET = wallet.address.toLowerCase();

let app: FastifyInstance;
let store: MemoryStore;
let chainState: FakeChainState;
let now = 1_790_000_000;
let nudges = 0;
const ADMIN = "admin-token-0123456789";

beforeAll(async () => {
  store = new MemoryStore();
  const chain = new FakeChain();
  chain.snapshots.duels.set(0, { tokenA: 0, tokenB: 1, reserved: false, challenger: ALICE, accepter: BOB, status: "resolved", openUntil: 1_800_000_000 });
  chain.snapshots.duels.set(1, { tokenA: 2, tokenB: 1, reserved: true, challenger: BOB, accepter: null, status: "open", openUntil: 1_800_000_000 });
  chain.snapshots.duels.set(2, { tokenA: 3, tokenB: null, reserved: false, challenger: BOB, accepter: null, status: "open", openUntil: 1_700_000_000 });
  chain.snapshots.contents.set(0, { seed: "8177263914793887761", state: 2, traits: [232, 155, 52, 122, 123], score: 1600, affection: 3, golden: false });
  chain.add(
    ev("MintPlaced", 100, { firstTokenId: 0, buyer: ALICE, count: 4 }),
    ev("ConfidentialTransfer", 100, { tokenId: 0, from: "0x0000000000000000000000000000000000000000", to: ALICE, moved: "0x01" }, { logIndex: 1 }),
    ev("DuelPosted", 101, { duelId: 0, tokenA: 0, tokenB: 0, challenger: ALICE, reserved: false }),
    ev("DuelOpened", 101, { duelId: 0, openUntil: 1_800_000_000 }, { logIndex: 1 }),
    ev("DuelAccepted", 102, { duelId: 0, tokenB: 1, accepter: BOB }),
    ev("DuelResolved", 103, { duelId: 0, winner: 0, loser: 1, traitIndex: 1, roll: 50 }),
    // Box 2 on the shelf for box 1 only; box 3 on the shelf for anyone, out of time.
    ev("DuelPosted", 104, { duelId: 1, tokenA: 2, tokenB: 1, challenger: BOB, reserved: true }),
    ev("DuelOpened", 104, { duelId: 1, openUntil: 1_800_000_000 }, { logIndex: 1 }),
    ev("DuelPosted", 104, { duelId: 2, tokenA: 3, tokenB: 0, challenger: BOB, reserved: false }, { logIndex: 2 }),
    ev("DuelOpened", 104, { duelId: 2, openUntil: 1_700_000_000 }, { logIndex: 3 }),
    ev("EntangleProposed", 105, { tokenA: 2, tokenB: 3, proposer: BOB }),
    ev("RequestPlaced", 106, { requestId: 0, tokenId: 0, requester: ALICE, kind: "open" }),
    ev("Observed", 107, { tokenId: 0, openedBy: ALICE, seed: "8177263914793887761", state: 2, score: 1600, golden: false }),
    ev("RequestSettled", 107, { requestId: 0, status: "done" }, { logIndex: 1 }),
    ev("RequestPlaced", 108, { requestId: 1, tokenId: 3, requester: BOB, kind: "aliveCheck" }),
  );
  await new SyncChain(chain, store, { startBlock: 100, confirmations: 0, rescan: 0, maxBlocksPerPass: 1000 }, silentLogger).pass();

  chainState = new FakeChainState();
  const queries = new Queries(store, chainState, () => now);
  let n = 0;
  const signIn = new SignIn(store, ethersVerifier, new HmacSessions("x".repeat(32)), { now: () => now }, "donotopen.test", () => `nonce${++n}`);
  app = await buildServer({
    queries,
    metadata: new Metadata(queries, "https://api.test", new ImageArchive(store, "https://arweave.net")),
    signIn,
    terms: new AcceptTerms(store, ethersVerifier, { now: () => now }),
    allowList: { list: new AllowList(store, ethersVerifier, { now: () => now }, 500), adminToken: ADMIN },
    indexer: { status: () => ({ running: true, lastPass: null, lastPassAt: null, lastError: null, failures: 0, tasks: {} }), nudge: () => void nudges++ },
    corsOrigins: ["https://donotopen.vercel.app", "https://donotopen-*.vercel.app"],
    rateLimitPerMinute: 10_000,
  });
});

afterAll(() => app.close());

const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
};

describe("reads", () => {
  it("wraps every answer with the block it is true at", async () => {
    const r = await get("/v1/stats");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ block: 108, data: expect.objectContaining({ minted: 4, opened: 1, duels: 3, openDuels: 2, users: 2 }) });
    expect(r.headers["cache-control"]).toContain("max-age=5");
  });

  it("serves the collection with its sale state", async () => {
    const { body } = await get("/v1/collection");
    expect(body.data).toMatchObject({ tokenCount: 4, maxSupply: 10000, sale: { milestones: [100, 500, 1000], reached: 0, soldOut: false }, payment: { ramp: { feeBps: 30 } } });
  });

  it("serves boxes, one or a window, clipped to what exists", async () => {
    expect((await get("/v1/boxes/0")).body.data).toMatchObject({ status: "revealed", openedBy: ALICE, wins: 1 });
    expect((await get("/v1/boxes/1")).body.data).toMatchObject({ status: "sealed", publicTraits: [{ traitIndex: 1, roll: 50 }] });
    expect((await get("/v1/boxes?from=0&to=50")).body.data.map((b: { tokenId: number }) => b.tokenId)).toEqual([0, 1, 2, 3]);
    expect((await get("/v1/boxes/99")).status).toBe(404);
    expect((await get("/v1/boxes?from=0&to=5000")).status).toBe(400);
    expect((await get("/v1/boxes/abc")).status).toBe(400);
  });

  it("finds the open duel and the proposal between two boxes", async () => {
    const { body } = await get("/v1/pairs/1/2");
    expect(body.data.duels).toMatchObject([{ duelId: 1, challenger: BOB, status: "open", reserved: true, tokenB: 1 }]);
    // Box 3's duel ran out of time: nothing to settle with it.
    expect((await get("/v1/pairs/1/3")).body.data.duels).toEqual([]);
    expect((await get("/v1/pairs/3/2")).body.data.entangleProposal).toEqual({ from: 2, to: 3, proposer: BOB });
    expect((await get("/v1/pairs/1/1")).status).toBe(400);
  });

  it("lists duels by challenger or by boxes, without caching a box list", async () => {
    expect((await get(`/v1/duels?account=${ALICE.toUpperCase().replace("0X", "0x")}`)).body.data.map((d: { duelId: number }) => d.duelId)).toEqual([0]);
    const byBoxes = await get("/v1/duels?tokens=1&open=true");
    expect(byBoxes.body.data.map((d: { duelId: number }) => d.duelId)).toEqual([1]);
    expect(byBoxes.headers["cache-control"]).toBe("private, no-store");
    expect((await get("/v1/duels")).status).toBe(400);
    expect((await get("/v1/duels?account=nope")).status).toBe(400);
  });

  it("lists the entanglements proposed to or by some boxes, without caching the list", async () => {
    const r = await get("/v1/proposals?tokens=3");
    expect(r.body.data).toEqual([{ from: 2, to: 3, proposer: BOB }]);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    // Box 0 is open: nothing to propose with it.
    expect((await get("/v1/proposals?tokens=0,1")).body.data).toEqual([]);
    expect((await get("/v1/proposals")).status).toBe(400);
  });

  it("serves the duel shelf: only what can still be taken up", async () => {
    const { body, headers } = await get("/v1/duels/shelf");
    expect(body.data.map((d: { duelId: number }) => d.duelId)).toEqual([1]);
    expect(headers["cache-control"]).toContain("max-age=5");
    expect((await get("/v1/duels/0")).body.data).toMatchObject({ status: "resolved", tokenB: 1, accepter: BOB });
  });

  it("ranks opened cats", async () => {
    expect((await get("/v1/leaderboard")).body.data).toEqual([expect.objectContaining({ tokenId: 0, openedBy: ALICE, revealed: expect.objectContaining({ score: 1600 }) })]);
  });

  it("serves an account's pending requests, receipts and profile", async () => {
    expect((await get(`/v1/accounts/${BOB}/requests`)).body.data).toEqual([{ requestId: 1, kind: "aliveCheck", tokenId: 3, other: null }]);
    expect((await get(`/v1/accounts/${ALICE}/requests`)).body.data).toEqual([]);
    expect((await get(`/v1/accounts/${ALICE}/transfers`)).body.data).toEqual([expect.objectContaining({ tokenId: 0, moved: "0x01", block: 100 })]);
    expect((await get(`/v1/accounts/${ALICE}/transfers?after=100`)).body.data).toEqual([]);
    const profile = (await get(`/v1/accounts/${ALICE}`)).body.data;
    expect(profile.user).toMatchObject({ address: ALICE });
    expect(profile.opened.map((c: { tokenId: number }) => c.tokenId)).toEqual([0]);
  });

  it("pages the activity feed, newest first", async () => {
    const page = (await get("/v1/activity?limit=2")).body.data;
    expect(page.map((e: { block: number }) => e.block)).toEqual([108, 107]);
    const box = (await get("/v1/boxes/1/activity")).body.data;
    expect(box.map((e: { name: string }) => e.name)).toEqual(["DuelPosted", "DuelResolved", "DuelAccepted", "MintPlaced"]);
  });

  it("batches nothing it does not need: the pantry reads the claim time once per box", async () => {
    const before = chainState.claimReads;
    expect((await get("/v1/boxes/2/pantry")).body.data).toEqual({ welcomed: false, nextClaimAt: 1_800_000_002, weighing: "none", weighIn: null });
    expect(chainState.claimReads).toBe(before + 1);
  });

  it("answers 404 for an economy that is not deployed", async () => {
    expect((await get("/v1/economy")).status).toBe(404);
  });

  it("allows the app's origin only", async () => {
    const ok = await app.inject({ method: "GET", url: "/v1/stats", headers: { origin: "https://donotopen.vercel.app" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://donotopen.vercel.app");
    const preview = await app.inject({ method: "GET", url: "/v1/stats", headers: { origin: "https://donotopen-abc123-team.vercel.app" } });
    expect(preview.headers["access-control-allow-origin"]).toBe("https://donotopen-abc123-team.vercel.app");
    for (const origin of ["https://evil.example", "https://donotopen-x.vercel.app.evil.example", "https://donotopen-a.b.vercel.app"]) {
      const other = await app.inject({ method: "GET", url: "/v1/stats", headers: { origin } });
      expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });
});

describe("metadata", () => {
  it("describes a sealed box from public facts only", async () => {
    const { body } = await get("/metadata/1");
    expect(body.image).toBe("https://api.test/metadata/1/image.svg");
    expect(body.attributes).toContainEqual({ trait_type: "Status", value: "Sealed" });
    expect(JSON.stringify(body)).not.toMatch(/seed/i);
  });

  it("links the image on Arweave once it is stored there", async () => {
    await store.saveArchivedImage(sha256Hex(sealedImageOf(2)), "abc", 1);
    expect((await get("/metadata/2")).body.image).toBe("https://arweave.net/abc");
    expect((await get("/metadata/3")).body.image).toBe("https://api.test/metadata/3/image.svg");
  });

  it("describes an opened cat, and draws it", async () => {
    const { body } = await get("/metadata/0.json");
    expect(body.attributes).toContainEqual({ trait_type: "Status", value: "Opened" });
    expect(body.attributes).toContainEqual({ trait_type: "Duels won", value: 1, display_type: "number" });
    const svg = await app.inject({ method: "GET", url: "/metadata/0/image.svg" });
    expect(svg.headers["content-type"]).toContain("image/svg+xml");
    expect(svg.body.startsWith("<svg")).toBe(true);
  });
});

describe("sign-in", () => {
  beforeEach(() => {
    now = 1_790_000_000;
  });

  const challenge = async (address = wallet.address) => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/nonce", payload: { address } });
    return res.json() as { message: string };
  };
  const verify = (signature: string, address = wallet.address) => app.inject({ method: "POST", url: "/v1/auth/verify", payload: { address, signature } });

  it("signs a wallet in, registers it, and opens its profile", async () => {
    const { message } = await challenge();
    expect(message).toContain(WALLET);
    expect(message).toContain("donotopen.test");
    const res = await verify(await wallet.signMessage(message));
    expect(res.statusCode).toBe(200);
    const { token, user } = res.json();
    expect(user).toMatchObject({ address: WALLET, registeredAt: now, lastLoginAt: now });

    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.address).toBe(WALLET);
    expect((await get("/v1/stats")).body.data.registered).toBe(1);
  });

  it("refuses a replayed signature", async () => {
    const { message } = await challenge();
    const signature = await wallet.signMessage(message);
    expect((await verify(signature)).statusCode).toBe(200);
    expect((await verify(signature)).statusCode).toBe(401);
  });

  it("refuses a signature from another account, and an expired challenge", async () => {
    const { message } = await challenge();
    expect((await verify(await Wallet.createRandom().signMessage(message))).statusCode).toBe(401);
    const second = await challenge();
    now += 3600;
    expect((await verify(await wallet.signMessage(second.message))).statusCode).toBe(401);
  });

  it("refuses a forged or missing session", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
    const forged = `${WALLET}.${now + 1000}.AAAA`;
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${forged}` } })).statusCode).toBe(401);
  });
});

describe("indexer hooks", () => {
  it("takes a nudge and reports health", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/sync/nudge" });
    expect(res.statusCode).toBe(202);
    expect(nudges).toBe(1);
    expect((await get("/health")).body).toMatchObject({ ok: true, block: 108, indexer: { running: true } });
  });
});

describe("duel ranking and allow list", () => {
  it("ranks the boxes by their duels", async () => {
    expect((await get("/v1/leaderboard/duels")).body.data).toEqual([
      { tokenId: 0, wins: 1, losses: 0 },
      { tokenId: 1, wins: 0, losses: 1 },
    ]);
  });

  it("files a claim signed by the address it names, and ranks it", async () => {
    const message = allowListMessage(wallet.address, new Date(now * 1000));
    const signature = await wallet.signMessage(message);
    const res = await app.inject({ method: "POST", url: "/v1/allowlist", payload: { address: wallet.address, message, signature } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ points: 0, claimedAt: now, rank: 1, claimants: 1, places: 500 });
    expect((await get(`/v1/allowlist/${wallet.address}`)).body.data).toMatchObject({ rank: 1 });
    // Someone who never claimed sees their points, unranked.
    expect((await get(`/v1/allowlist/${ALICE}`)).body.data).toMatchObject({ points: 6, live: { beaten: 1, faced: 1, opened: 1 }, rank: null, claimants: 1 });
  });

  it("refuses a claim signed by someone else or naming someone else", async () => {
    const other = Wallet.createRandom();
    const message = allowListMessage(wallet.address, new Date());
    const post = (payload: object) => app.inject({ method: "POST", url: "/v1/allowlist", payload });
    expect((await post({ address: wallet.address, message, signature: await other.signMessage(message) })).statusCode).toBe(401);
    expect((await post({ address: other.address, message, signature: await other.signMessage(message) })).statusCode).toBe(400);
    expect((await post({ address: wallet.address, message: "hello", signature: await wallet.signMessage("hello") })).statusCode).toBe(400);
  });

  it("lists every claimant only for whoever holds the token", async () => {
    expect((await get("/v1/allowlist")).status).toBe(401);
    expect((await get("/v1/allowlist?token=wrong")).status).toBe(401);
    expect((await get(`/v1/allowlist?token=${ADMIN}`)).body.data).toMatchObject([{ rank: 1, address: WALLET, inPlace: true }]);
  });
});

describe("release form", () => {
  const form = (who: string, version = "2026-10-03") =>
    [
      `DO NOT OPEN · Release form ${version}`,
      "",
      `I, ${who}, have read and accept the terms of DO NOT OPEN, version ${version}, whose full English text has this SHA-256:`,
      "c0ffee".padEnd(64, "0"),
      "",
      "Signed on 2026-10-03T10:00:00.000Z. This signature is free and sends no transaction.",
    ].join("\n");

  it("files a release form signed by the address it names, once", async () => {
    const message = form(wallet.address);
    const signature = await wallet.signMessage(message);
    const res = await app.inject({ method: "POST", url: "/v1/terms", payload: { address: wallet.address, message, signature } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ address: WALLET, version: "2026-10-03", hash: "c0ffee".padEnd(64, "0") });
    const again = await app.inject({ method: "POST", url: "/v1/terms", payload: { address: wallet.address, message, signature } });
    expect(again.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: `/v1/terms/${wallet.address}` });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).toMatchObject({ version: "2026-10-03", signature, message });
  });

  it("refuses a form signed by someone else, naming someone else, or not a form at all", async () => {
    const other = Wallet.createRandom();
    const message = form(wallet.address, "v2");
    const post = (payload: object) => app.inject({ method: "POST", url: "/v1/terms", payload });
    expect((await post({ address: wallet.address, message, signature: await other.signMessage(message) })).statusCode).toBe(401);
    expect((await post({ address: other.address, message, signature: await other.signMessage(message) })).statusCode).toBe(400);
    expect((await post({ address: wallet.address, message: "hello", signature: await wallet.signMessage("hello") })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/v1/terms/${other.address}` })).json().data).toEqual([]);
  });
});
