import { verifyTypedData, Wallet } from "ethers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { studio as spec } from "@dno/game-spec";
import { buildRatSpec } from "@dno/generator";
import { SignIn } from "../src/application/auth";
import { ImageArchive } from "../src/application/archive";
import { Metadata } from "../src/application/metadata";
import type { PermanentStorage } from "../src/application/ports/archive";
import { silentLogger } from "../src/application/ports/logger";
import type { ImageShrinker, ServiceFiles } from "../src/application/ports/rats";
import { project } from "../src/application/projector";
import { Queries } from "../src/application/queries";
import { RatRefused, Rats, type RatsConfig } from "../src/application/rats";
import { emptySnapshots } from "../src/domain/events";
import type { StudioJob } from "../src/domain/studio";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import { buildServer } from "../src/infrastructure/http/server";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { EthersAdoptionSigner } from "../src/infrastructure/rats/EthersAdoptionSigner";
import { ServiceFileFetcher } from "../src/infrastructure/rats/ServiceFileFetcher";
import { ALICE, BOB, ev, FakeChainState } from "./fixtures";

const RATS_ADDRESS = "0x00000000000000000000000000000000000000aa";
const ZERO = "0x0000000000000000000000000000000000000000";
const attester = Wallet.createRandom();
const DOMAIN = { name: "DO NOT OPEN Rats", version: "1", chainId: 11155111, verifyingContract: RATS_ADDRESS };
const ADOPT = { Adopt: [{ name: "minter", type: "address" }, { name: "job", type: "bytes32" }, { name: "uri", type: "string" }, { name: "deadline", type: "uint256" }] };
const now = 1_790_000_000;
const CFG: RatsConfig = { publicUrl: "https://api.test", gateway: "https://gw.test", studioUrl: "https://site.test/studio", ticketTtl: 1800, maxImageBytes: 1000, maxModelBytes: 5000 };

class FakeStorage implements PermanentStorage {
  readonly maxBytes = 100_000;
  puts: string[] = [];
  broke = false;
  async put(_data: Uint8Array, contentType: string) {
    if (this.broke) throw new Error("402 no credits");
    this.puts.push(contentType);
    return `ar${this.puts.length}`;
  }
}

const fakeFiles: ServiceFiles = {
  async get(url) {
    return { bytes: new Uint8Array([1, 2, 3]), contentType: url.endsWith(".glb") ? "application/octet-stream" : "image/jpeg" };
  },
};

/** Shrinks to a fixed small picture, and remembers the budget it was given. */
const shrunk: number[] = [];
const fakeShrinker: ImageShrinker = {
  shrink(_jpeg, maxBytes) {
    shrunk.push(maxBytes);
    return new Uint8Array([9, 9]);
  },
};

const job = (over: Partial<StudioJob>): StudioJob => ({
  id: "00000000-0000-4000-8000-000000000001", account: ALICE, kind: "model", status: "done", prompt: "a rat chef", sketchId: "00000000-0000-4000-8000-000000000000",
  resultUrl: "https://v3.fal.media/files/rat.glb", error: null, costUsd: 0.3, createdAt: now, finishedAt: now, ...over,
});

async function seedJobs(store: MemoryStore, jobs: StudioJob[]) {
  for (const j of jobs) {
    await store.startStudioJob(j.account, 0, () => ({ ...j, status: "running" }));
    await store.finishStudioJob(j.id, { status: j.status === "running" ? "done" : (j.status as "done"), resultUrl: j.resultUrl, error: null }, now);
  }
}

const SKETCH = job({ id: "00000000-0000-4000-8000-000000000000", kind: "sketch", sketchId: null, resultUrl: "https://v3.fal.media/files/rat.jpg" });

function setup(opts: { storage?: FakeStorage | null; signer?: boolean } = {}) {
  const store = new MemoryStore();
  const storage = opts.storage === undefined ? new FakeStorage() : opts.storage;
  const signer = opts.signer === false ? null : new EthersAdoptionSigner(attester.privateKey, { chainId: DOMAIN.chainId, verifyingContract: RATS_ADDRESS });
  const rats = new Rats(store, store, storage, fakeFiles, fakeShrinker, signer, { now: () => now }, CFG, silentLogger);
  return { store, storage, signer, rats };
}

const fold = (store: MemoryStore, events: Parameters<typeof project>[0][]) =>
  store.transaction(async (tx) => {
    for (const e of events) await project(e, emptySnapshots(), tx);
  });

describe("rats in the index", () => {
  it("folds a mint (its transfer first) and follows the owner through transfers", async () => {
    const { store, rats } = setup();
    await fold(store, [
      ev("RatTransfer", 10, { ratId: 1, from: ZERO, to: ALICE }, { logIndex: 0 }),
      ev("RatMinted", 10, { ratId: 1, minter: ALICE, kind: "seed", ref: "42", uri: "", paid: "1000000" }, { logIndex: 1 }),
    ]);
    expect(await store.rat(1)).toMatchObject({ id: 1, kind: "seed", ref: "42", uri: null, owner: ALICE, minter: ALICE, mintedBlock: 10 });
    await fold(store, [ev("RatTransfer", 12, { ratId: 1, from: ALICE, to: BOB })]);
    expect((await store.ratsOf(BOB)).map((r) => r.id)).toEqual([1]);
    expect(await store.ratsOf(ALICE)).toEqual([]);
    expect((await rats.get(1)).owner).toBe(BOB);
  });

  it("counts a paid shake as a sniff of the payer's rats, a free one not", async () => {
    const { store, rats } = setup();
    await fold(store, [
      ev("RatTransfer", 10, { ratId: 1, from: ZERO, to: ALICE }),
      ev("RatMinted", 10, { ratId: 1, minter: ALICE, kind: "seed", ref: "5", uri: "", paid: "1000000" }, { logIndex: 1 }),
      ev("Shaken", 11, { tokenId: 3, viewer: ALICE, paid: true }),
      ev("Shaken", 11, { tokenId: 3, viewer: ALICE, paid: false }, { logIndex: 1 }),
      ev("Shaken", 12, { tokenId: 4, viewer: BOB, paid: true }),
    ]);
    expect((await rats.list(ALICE))[0]!.sniffs).toBe(1);
  });

  it("describes a seed rat from its seed, and draws it", async () => {
    const { store, rats } = setup();
    await fold(store, [ev("RatMinted", 10, { ratId: 7, minter: ALICE, kind: "seed", ref: "123456789", uri: "", paid: "1000000" })]);
    const view = await rats.get(7);
    expect(view).toMatchObject({ kind: "seed", seed: "123456789", job: null, imageUrl: "https://api.test/rats/7/image.svg", modelUrl: null });
    const meta = await rats.metadata(7);
    const s = buildRatSpec(123456789n);
    expect(meta).toMatchObject({ name: "Rat #7", image: "https://api.test/rats/7/image.svg", external_url: "https://site.test/studio" });
    expect(meta.attributes).toContainEqual({ trait_type: "Coat", value: s.coat });
    expect(meta.attributes).toContainEqual({ trait_type: "Kind", value: "Seed" });
    expect((await rats.svg(7)).startsWith("<svg")).toBe(true);
    await expect(rats.metadata(99)).rejects.toThrow(/does not exist/);
  });
});

describe("adopting an AI rat", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await seedJobs(ctx.store, [SKETCH, job({})]);
  });

  it("puts the shrunk picture on Arweave like a cat's, keeps the model here, then signs for the caller", async () => {
    const t = await ctx.rats.adopt(ALICE, job({}).id);
    // The picture and the record go to Arweave, within the free size; the GLB never does.
    expect(ctx.storage!.puts).toEqual(["image/jpeg", "application/json"]);
    expect(shrunk.at(-1)).toBe(ctx.storage!.maxBytes);
    expect(await ctx.rats.model(t.job)).toEqual(new Uint8Array([1, 2, 3]));
    expect(t).toMatchObject({ uri: "ar://ar2", deadline: now + 1800, priceUsdc: spec.rats.mint.modelPriceUsdc });
    expect(t.job).toBe(ctx.signer!.jobRef(job({}).id));
    const signer = verifyTypedData(DOMAIN, ADOPT, { minter: ALICE, job: t.job, uri: t.uri, deadline: t.deadline }, t.signature);
    expect(signer).toBe(attester.address);

    // Asked again: signed again, uploaded once.
    const again = await ctx.rats.adopt(ALICE, job({}).id);
    expect(again.uri).toBe(t.uri);
    expect(ctx.storage!.puts).toHaveLength(2);

    // Once minted, the rat shows its picture from Arweave and its model from this API.
    const modelUrl = `https://api.test/rats/models/${t.job}.glb`;
    await fold(ctx.store, [ev("RatMinted", 20, { ratId: 1, minter: ALICE, kind: "model", ref: t.job, uri: t.uri, paid: "3000000" })]);
    expect(await ctx.rats.get(1)).toMatchObject({ kind: "model", job: t.job, imageUrl: "https://gw.test/ar1", modelUrl });
    expect(await ctx.rats.metadata(1)).toMatchObject({ animation_url: modelUrl, description: expect.stringContaining("a rat chef") });
    await expect(ctx.rats.adopt(ALICE, job({}).id)).rejects.toMatchObject({ code: "already-adopted" });
  });

  it("refuses another account's job, a sketch, an unfinished model, and an unknown job", async () => {
    await expect(ctx.rats.adopt(BOB, job({}).id)).rejects.toMatchObject({ code: "not-found" });
    await expect(ctx.rats.adopt(ALICE, SKETCH.id)).rejects.toMatchObject({ code: "not-adoptable" });
    await ctx.store.startStudioJob(ALICE, 0, () => job({ id: "00000000-0000-4000-8000-000000000009", status: "running", resultUrl: null }));
    await expect(ctx.rats.adopt(ALICE, "00000000-0000-4000-8000-000000000009")).rejects.toMatchObject({ code: "not-adoptable" });
    await expect(ctx.rats.adopt(ALICE, "00000000-0000-4000-8000-00000000dead")).rejects.toMatchObject({ code: "not-found" });
    expect(ctx.storage!.puts).toEqual([]);
  });

  it("says when Arweave refuses the picture, and when adoption is not set up", async () => {
    ctx.storage!.broke = true;
    await expect(ctx.rats.adopt(ALICE, job({}).id)).rejects.toMatchObject({ code: "storage-failed" });
    const off = setup({ signer: false });
    await expect(off.rats.adopt(ALICE, job({}).id)).rejects.toBeInstanceOf(RatRefused);
    await expect(off.rats.adopt(ALICE, job({}).id)).rejects.toMatchObject({ code: "adopt-unavailable" });
  });
});

describe("the service's files", () => {
  it("are read only from its hosts, and never past the cap", async () => {
    const fetcher = new ServiceFileFetcher(["fal.media"], (async () => new Response(new Uint8Array(20), { headers: { "content-type": "image/png" } })) as unknown as typeof fetch);
    expect((await fetcher.get("https://v3.fal.media/x.png", 100)).bytes.length).toBe(20);
    await expect(fetcher.get("https://evil.test/x.png", 100)).rejects.toThrow(/hosts/);
    await expect(fetcher.get("http://v3.fal.media/x.png", 100)).rejects.toThrow(/hosts/);
    await expect(fetcher.get("https://v3.fal.media/x.png", 10)).rejects.toThrow(/too large/);
  });
});

describe("rat routes", () => {
  let app: FastifyInstance;
  const wallet = Wallet.createRandom();
  const WALLET = wallet.address.toLowerCase();
  let ctx: ReturnType<typeof setup>;

  beforeAll(async () => {
    ctx = setup();
    await seedJobs(ctx.store, [{ ...SKETCH, account: WALLET }, job({ account: WALLET })]);
    await fold(ctx.store, [
      ev("RatTransfer", 10, { ratId: 1, from: ZERO, to: WALLET }),
      ev("RatMinted", 10, { ratId: 1, minter: WALLET, kind: "seed", ref: "42", uri: "", paid: "1000000" }, { logIndex: 1 }),
    ]);
    const queries = new Queries(ctx.store, new FakeChainState(), () => now);
    let n = 0;
    const signIn = new SignIn(ctx.store, ethersVerifier, new HmacSessions("x".repeat(32)), { now: () => now }, "donotopen.test", () => `nonce${++n}`);
    app = await buildServer({
      queries,
      metadata: new Metadata(queries, "https://api.test", new ImageArchive(ctx.store, "https://arweave.net")),
      signIn,
      rats: ctx.rats,
      corsOrigins: ["*"],
      rateLimitPerMinute: 10_000,
    });
  });
  afterAll(() => app.close());

  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? res.json() : res.body, headers: res.headers };
  };

  it("lists an owner's rats and shows one", async () => {
    const list = await get(`/v1/rats?owner=${WALLET}`);
    expect(list.status).toBe(200);
    expect(list.body.rats).toHaveLength(1);
    expect(list.body.rats[0]).toMatchObject({ id: 1, kind: "seed", seed: "42", owner: WALLET, imageUrl: "https://api.test/rats/1/image.svg", modelUrl: null, sniffs: 0 });
    expect(list.body).toHaveProperty("block");
    expect((await get(`/v1/rats?owner=${BOB}`)).body.rats).toEqual([]);
    expect((await get("/v1/rats")).status).toBe(400);
    expect((await get("/v1/rats/1")).body.rat).toMatchObject({ id: 1 });
    expect((await get("/v1/rats/2")).status).toBe(404);
  });

  it("serves the ERC-721 metadata and the seed rat's picture", async () => {
    expect((await get("/rats/1")).body).toMatchObject({ name: "Rat #1" });
    expect((await get("/rats/1.json")).status).toBe(200);
    const svg = await get("/rats/1/image.svg");
    expect(svg.headers["content-type"]).toContain("image/svg+xml");
    expect(svg.body).toContain("<svg");
    expect((await get("/rats/9")).status).toBe(404);
  });

  it("adopts the caller's own AI rat", async () => {
    expect((await app.inject({ method: "POST", url: `/v1/studio/jobs/${job({}).id}/adopt` })).statusCode).toBe(401);
    const { message } = (await app.inject({ method: "POST", url: "/v1/auth/nonce", payload: { address: wallet.address } })).json();
    const token = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { address: wallet.address, signature: await wallet.signMessage(message) } })).json().token;
    const res = await app.inject({ method: "POST", url: `/v1/studio/jobs/${job({}).id}/adopt`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ uri: "ar://ar2", priceUsdc: spec.rats.mint.modelPriceUsdc });
    // The model is served by this API, as a GLB.
    const glb = await app.inject({ method: "GET", url: `/rats/models/${res.json().job}.glb` });
    expect(glb.statusCode).toBe(200);
    expect(glb.headers["content-type"]).toContain("model/gltf-binary");
    expect((await app.inject({ method: "GET", url: `/rats/models/0x${"0".repeat(64)}.glb` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/rats/models/nope.glb" })).statusCode).toBe(400);
    const sketch = await app.inject({ method: "POST", url: `/v1/studio/jobs/${SKETCH.id}/adopt`, headers: { authorization: `Bearer ${token}` } });
    expect(sketch.statusCode).toBe(400);
    expect(sketch.json()).toMatchObject({ error: "not-adoptable" });
  });
});
