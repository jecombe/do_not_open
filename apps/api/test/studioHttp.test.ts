import { Wallet } from "ethers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignIn } from "../src/application/auth";
import { ImageArchive } from "../src/application/archive";
import { Metadata } from "../src/application/metadata";
import { silentLogger } from "../src/application/ports/logger";
import { Queries } from "../src/application/queries";
import { Studio } from "../src/application/studio";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import { buildServer } from "../src/infrastructure/http/server";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { FakeChainState } from "./fixtures";

const wallet = Wallet.createRandom();
const WALLET = wallet.address.toLowerCase();
const other = Wallet.createRandom();

let app: FastifyInstance;
let store: MemoryStore;
let studio: Studio;
let fail = false;
const now = 1_790_000_000;
const fetched: string[] = [];

beforeAll(async () => {
  store = new MemoryStore();
  const queries = new Queries(store, new FakeChainState(), () => now);
  let n = 0;
  const signIn = new SignIn(store, ethersVerifier, new HmacSessions("x".repeat(32)), { now: () => now }, "donotopen.test", () => `nonce${++n}`);
  const service = {
    sketch: async () => {
      if (fail) throw new Error("down");
      return { url: "https://v3.fal.media/files/sketch.png" };
    },
    model: async () => ({ url: "https://v3.fal.media/files/cat.glb" }),
  };
  let ids = 0;
  studio = new Studio(store, service, service, { now: () => now }, {
    enabled: true,
    paused: false,
    dailyBudgetUsd: 20,
    allowlist: null,
    staleAfter: 600,
    refundsPerDay: 3,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  }, silentLogger);
  const fakeFetch = (async (url: string) => {
    fetched.push(url);
    if (url.endsWith(".glb")) return new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
    if (url.endsWith(".html")) return new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } });
    if (url.endsWith("huge.png")) return new Response(new Uint8Array(11 * 1024 * 1024), { headers: { "content-type": "image/png" } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;
  app = await buildServer({
    queries,
    metadata: new Metadata(queries, "https://api.test", new ImageArchive(store, "https://arweave.net")),
    signIn,
    studio: { studio, publicUrl: "https://api.test/", fetch: fakeFetch },
    corsOrigins: ["*"],
    rateLimitPerMinute: 10_000,
  });
});

afterAll(() => app.close());

async function tokenOf(w: Pick<Wallet, "address" | "signMessage">): Promise<string> {
  const { message } = (await app.inject({ method: "POST", url: "/v1/auth/nonce", payload: { address: w.address } })).json();
  return (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { address: w.address, signature: await w.signMessage(message) } })).json().token;
}

const call = async (method: "GET" | "POST", url: string, token?: string, payload?: object) => {
  const res = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
};

describe("studio routes", () => {
  it("describes the studio and its packs to anyone", async () => {
    const r = await call("GET", "/v1/studio");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, paused: null, testersOnly: false, allowlisted: null, block: null });
    expect(r.body.packs[0]).toEqual({ id: 0, key: "starter", name: "Starter", priceUsdc: "2", sketches: 10, models: 1 });
    // Cached for anyone, but never served to a signed-in call in its place.
    expect(r.headers["cache-control"]).toBe("public, max-age=30");
    expect(r.headers.vary).toMatch(/authorization/i);
    expect((await call("GET", "/v1/studio", await tokenOf(other))).headers["cache-control"]).toBe("private, no-store");
  });

  it("asks for a sign-in before credits and generations", async () => {
    expect((await call("GET", "/v1/studio/credits")).status).toBe(401);
    expect((await call("POST", "/v1/studio/sketches", undefined, { prompt: "a cat" })).status).toBe(401);
    expect((await call("GET", "/v1/studio/jobs")).status).toBe(401);
  });

  it("refuses without credits, and a bad or refused prompt", async () => {
    const token = await tokenOf(other);
    expect((await call("POST", "/v1/studio/sketches", token, { prompt: "a cat" })).body).toMatchObject({ error: "no-credits" });
    expect((await call("POST", "/v1/studio/sketches", token, { prompt: "a cat" })).status).toBe(402);
    expect(await call("POST", "/v1/studio/sketches", token, { prompt: "c" })).toMatchObject({ status: 400, body: { error: "bad-prompt" } });
    expect(await call("POST", "/v1/studio/sketches", token, { prompt: "garfield the cat" })).toMatchObject({ status: 403, body: { error: "refused-prompt" } });
  });

  it("draws a sketch, turns it into a model, and serves both files", async () => {
    await store.transaction((tx) => tx.addStudioUnits(WALLET, 10, 1));
    const token = await tokenOf(wallet);
    expect((await call("GET", "/v1/studio/credits", token)).body).toEqual({ sketches: { bought: 10, used: 0, left: 10 }, models: { bought: 1, used: 0, left: 1 }, block: null });

    const posted = await call("POST", "/v1/studio/sketches", token, { prompt: "a cat astronaut" });
    expect(posted.status).toBe(202);
    expect(posted.body.job).toMatchObject({ kind: "sketch", status: "running", prompt: "a cat astronaut", sketchId: null, imageUrl: null, modelUrl: null, error: null, createdAt: now });
    await studio.idle();
    const sketchId = posted.body.job.id;
    const done = await call("GET", `/v1/studio/jobs/${sketchId}`, token);
    expect(done.body.job).toMatchObject({ status: "done", imageUrl: `https://api.test/v1/studio/jobs/${sketchId}/image` });
    expect(done.headers["cache-control"]).toBe("private, no-store");

    const model = await call("POST", "/v1/studio/models", token, { sketchId });
    expect(model.status).toBe(202);
    expect(model.body.job).toMatchObject({ kind: "model", status: "running", sketchId, imageUrl: `https://api.test/v1/studio/jobs/${sketchId}/image`, modelUrl: null });
    await studio.idle();
    const modelId = model.body.job.id;
    const jobs = (await call("GET", "/v1/studio/jobs", token)).body.jobs;
    expect(jobs.map((j: { id: string }) => j.id)).toEqual([modelId, sketchId].sort().reverse());
    expect(jobs.find((j: { id: string }) => j.id === modelId).modelUrl).toBe(`https://api.test/v1/studio/jobs/${modelId}/model.glb`);

    const image = await app.inject({ method: "GET", url: `/v1/studio/jobs/${sketchId}/image` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["cache-control"]).toContain("immutable");
    const glb = await app.inject({ method: "GET", url: `/v1/studio/jobs/${modelId}/model.glb` });
    expect(glb.statusCode).toBe(200);
    expect(glb.headers["content-type"]).toBe("model/gltf-binary");
    expect(glb.rawPayload.subarray(0, 4).toString()).toBe("glTF");
    expect(fetched).toEqual(["https://v3.fal.media/files/sketch.png", "https://v3.fal.media/files/cat.glb"]);

    // A sketch has no mesh; an unknown id has nothing; a model needs a sketch left to make.
    expect((await app.inject({ method: "GET", url: `/v1/studio/jobs/${sketchId}/model.glb` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/studio/jobs/00000000-0000-4000-8000-999999999999/image" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/studio/jobs/not-a-uuid/image" })).statusCode).toBe(400);
    expect(await call("POST", "/v1/studio/models", token, { sketchId })).toMatchObject({ status: 402, body: { error: "no-credits" } });
  });

  it("hides another account's jobs", async () => {
    const mine = (await call("GET", "/v1/studio/jobs", await tokenOf(wallet))).body.jobs[0].id;
    const theirs = await tokenOf(other);
    expect((await call("GET", `/v1/studio/jobs/${mine}`, theirs)).status).toBe(404);
    expect((await call("POST", "/v1/studio/models", theirs, { sketchId: mine })).status).toBe(404);
  });

  it("serves only the service's own files, capped in size, never as a page", async () => {
    const done = async (id: string, url: string) => {
      await store.startStudioJob("0x00000000000000000000000000000000000000ee", 0, () => ({
        id, account: "0x00000000000000000000000000000000000000ee", kind: "sketch", status: "running", prompt: "a cat", sketchId: null,
        resultUrl: null, error: null, costUsd: 0, createdAt: now, finishedAt: null,
      }));
      await store.finishStudioJob(id, { status: "done", resultUrl: url, error: null }, now);
    };
    await done("00000000-0000-4000-8000-0000000000e1", "https://evil.example/fal.media/x.png");
    await done("00000000-0000-4000-8000-0000000000e2", "http://v3.fal.media/files/x.png");
    await done("00000000-0000-4000-8000-0000000000e3", "https://v3.fal.media/files/page.html");
    await done("00000000-0000-4000-8000-0000000000e4", "https://v3.fal.media/files/huge.png");
    const before = fetched.length;
    expect((await app.inject({ method: "GET", url: "/v1/studio/jobs/00000000-0000-4000-8000-0000000000e1/image" })).statusCode).toBe(502);
    expect((await app.inject({ method: "GET", url: "/v1/studio/jobs/00000000-0000-4000-8000-0000000000e2/image" })).statusCode).toBe(502);
    expect(fetched.length).toBe(before);
    const page = await app.inject({ method: "GET", url: "/v1/studio/jobs/00000000-0000-4000-8000-0000000000e3/image" });
    expect(page.headers["content-type"]).toBe("image/jpeg");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["content-security-policy"]).toContain("sandbox");
    expect((await app.inject({ method: "GET", url: "/v1/studio/jobs/00000000-0000-4000-8000-0000000000e4/image" })).statusCode).toBe(502);
  });

  it("reports a failed generation with its unit back", async () => {
    const token = await tokenOf(wallet);
    fail = true;
    const posted = await call("POST", "/v1/studio/sketches", token, { prompt: "a cat on a roof" });
    await studio.idle();
    fail = false;
    const job = (await call("GET", `/v1/studio/jobs/${posted.body.job.id}`, token)).body.job;
    expect(job).toMatchObject({ status: "failed", imageUrl: null });
    expect(job.error).toContain("unit is back");
    expect((await call("GET", "/v1/studio/credits", token)).body.sketches).toEqual({ bought: 10, used: 1, left: 9 });
  });
});
