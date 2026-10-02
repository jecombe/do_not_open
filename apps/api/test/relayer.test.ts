import { Wallet, type HDNodeWallet } from "ethers";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { SignIn } from "../src/application/auth";
import { Metadata } from "../src/application/metadata";
import type { RelayerUpstream, UpstreamReply } from "../src/application/ports/relayer";
import { Queries } from "../src/application/queries";
import { encodePermitToken, RelayerGate, RelayerRefused } from "../src/application/relayerGate";
import { allowanceOf, charge, dayOf, nextDayAt } from "../src/domain/relayer";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import { buildServer } from "../src/infrastructure/http/server";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { eip712PermitVerifier } from "../src/infrastructure/relayer/permit";
import { FakeChainState } from "./fixtures";

const CHAIN_ID = 11155111;
const DOMAIN = { chainId: CHAIN_ID, verifyingContract: "0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478" };
const GAME = "0x00000000000000000000000000000000000000aa";
const CUSDC = "0x00000000000000000000000000000000000000bb";
const OTHER = "0x00000000000000000000000000000000000000cc";
const NOW = 1_790_000_000;
const handle = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const wallet = Wallet.createRandom();
const ACCOUNT = wallet.address.toLowerCase();

/** A user-decryption permit for the game's contracts, signed by `signer`. */
async function permit(signer: Wallet | HDNodeWallet, start = NOW - 60) {
  const contractAddresses = [GAME, CUSDC];
  const startTimestamp = String(start);
  const publicKey = "0x" + "12".repeat(32);
  const signature = await signer.signTypedData(
    { name: "Decryption", version: "1", chainId: DOMAIN.chainId, verifyingContract: DOMAIN.verifyingContract },
    {
      UserDecryptRequestVerification: [
        { name: "publicKey", type: "bytes" },
        { name: "contractAddresses", type: "address[]" },
        { name: "startTimestamp", type: "uint256" },
        { name: "durationDays", type: "uint256" },
        { name: "extraData", type: "bytes" },
      ],
    },
    { publicKey, contractAddresses, startTimestamp, durationDays: "1", extraData: "0x00" },
  );
  return { publicKey, contractAddresses, startTimestamp, durationDays: "1", extraData: "0x00", signature };
}

/** The bearer token the app sends with an encrypted input. */
const bearer = async (signer: Wallet | HDNodeWallet, start?: number) => `Bearer ${encodePermitToken(await permit(signer, start))}`;

/** A user-decryption request as the Relayer SDK sends it, signed by `signer`. */
async function userDecrypt(signer: Wallet | HDNodeWallet, n: number, opts: { contract?: string; start?: number; userAddress?: string } = {}) {
  const { publicKey, contractAddresses, startTimestamp, signature } = await permit(signer, opts.start);
  return {
    handleContractPairs: Array.from({ length: n }, (_, i) => ({ handle: handle(i + 1), contractAddress: opts.contract ?? GAME })),
    requestValidity: { startTimestamp, durationDays: "1" },
    contractsChainId: String(CHAIN_ID),
    contractAddresses,
    userAddress: opts.userAddress ?? signer.address,
    signature: signature.slice(2),
    publicKey: publicKey.slice(2),
    extraData: "0x00",
  };
}

class FakeUpstream implements RelayerUpstream {
  calls: { method: string; path: string; body?: unknown }[] = [];
  status = 202;
  getStatus = 200;
  async post(path: string, body: unknown): Promise<UpstreamReply> {
    this.calls.push({ method: "POST", path, body });
    return { status: this.status, body: { status: "queued", requestId: "r1", result: { jobId: "job-1" } }, retryAfter: "1" };
  }
  async get(path: string): Promise<UpstreamReply> {
    this.calls.push({ method: "GET", path });
    return { status: this.getStatus, body: { status: "succeeded", path }, retryAfter: null };
  }
}

describe("relayer meter", () => {
  it("takes free units first, then credits, and nothing when both fall short", () => {
    expect(charge(3, { freeUsed: 0, spent: 0, bought: 0 }, 5)).toEqual({ free: 3, credits: 0 });
    expect(charge(3, { freeUsed: 4, spent: 0, bought: 10 }, 5)).toEqual({ free: 1, credits: 2 });
    expect(charge(3, { freeUsed: 5, spent: 9, bought: 10 }, 5)).toBeNull();
    expect(charge(0, { freeUsed: 5, spent: 10, bought: 10 }, 5)).toEqual({ free: 0, credits: 0 });
    expect(allowanceOf({ freeUsed: 2, spent: 1, bought: 4 }, 5, NOW, 5)).toEqual({ freePerDay: 5, freeLeft: 3, credits: 3, resetsAt: nextDayAt(NOW), inputUnits: 5 });
  });

  it("starts a new free allowance at UTC midnight", () => {
    expect(dayOf(NOW)).toBe("2026-09-21");
    expect(nextDayAt(NOW)).toBe(Date.UTC(2026, 8, 22) / 1000);
    expect(allowanceOf({ freeUsed: 7, spent: 3, bought: 10 }, 5, NOW, 5)).toEqual({ freePerDay: 5, freeLeft: 0, credits: 7, resetsAt: nextDayAt(NOW), inputUnits: 5 });
  });
});

describe("RelayerGate", () => {
  let store: MemoryStore;
  let upstream: FakeUpstream;
  let published: string[];
  let gate: RelayerGate;

  beforeEach(() => {
    store = new MemoryStore();
    upstream = new FakeUpstream();
    published = [];
    gate = new RelayerGate(
      store,
      upstream,
      eip712PermitVerifier(DOMAIN),
      { recentlyPublished: async (hs) => hs.filter((h) => published.includes(h)) },
      { now: () => NOW },
      { chainId: CHAIN_ID, contracts: async () => [GAME, CUSDC], freePerDay: 5, newcomerPerDay: 5, inputUnits: 2, maxHandles: 10, clockSkew: 600, publicPerHandle: 3 },
    );
  });

  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof RelayerRefused ? e.code : String(e)));

  it("decrypts for the wallet that signed, out of its free units, then its credits", async () => {
    await gate.submit("user-decrypt", await userDecrypt(wallet, 4));
    expect(upstream.calls).toHaveLength(1);
    expect((await gate.allowance(ACCOUNT)).freeLeft).toBe(1);

    expect(await refusal(gate.submit("user-decrypt", await userDecrypt(wallet, 2)))).toBe("no-credits");
    expect(upstream.calls).toHaveLength(1);

    await store.transaction((tx) => tx.addCredits(ACCOUNT, 10));
    await gate.submit("user-decrypt", await userDecrypt(wallet, 2));
    expect(await gate.allowance(ACCOUNT)).toMatchObject({ freeLeft: 0, credits: 9 });
  });

  it("gives the units back when Zama turns the request away", async () => {
    upstream.status = 400;
    await gate.submit("user-decrypt", await userDecrypt(wallet, 3));
    expect((await gate.allowance(ACCOUNT)).freeLeft).toBe(5);
  });

  it("refuses a permit signed by someone else, an expired one, and another app's contracts", async () => {
    const other = Wallet.createRandom();
    expect(await refusal(gate.submit("user-decrypt", await userDecrypt(other, 1, { userAddress: wallet.address })))).toBe("bad-permit");
    expect(await refusal(gate.submit("user-decrypt", await userDecrypt(wallet, 1, { start: NOW - 2 * 86_400 })))).toBe("bad-permit");
    expect(await refusal(gate.submit("user-decrypt", await userDecrypt(wallet, 1, { contract: OTHER })))).toBe("not-ours");
    expect(await refusal(gate.submit("user-decrypt", await userDecrypt(wallet, 11)))).toBe("bad-request");
    expect(await refusal(gate.submit("user-decrypt", { nope: true }))).toBe("bad-request");
    expect(upstream.calls).toHaveLength(0);
  });

  it("publicly decrypts only what the protocol made public, from the index or the latest blocks", async () => {
    await store.transaction((tx) => tx.savePublished([handle(1)], GAME, 10));
    await gate.submit("public-decrypt", { ciphertextHandles: [handle(1)], extraData: "0x00" });
    expect(await refusal(gate.submit("public-decrypt", { ciphertextHandles: [handle(1), handle(2)], extraData: "0x00" }))).toBe("not-ours");
    published = [handle(2)];
    await gate.submit("public-decrypt", { ciphertextHandles: [handle(1), handle(2)], extraData: "0x00" });
    expect(upstream.calls.map((c) => c.path)).toEqual(["public-decrypt", "public-decrypt"]);
    // Free: it settles something already on-chain.
    expect((await gate.allowance(ACCOUNT)).freeLeft).toBe(5);
  });

  it("sends each public decryption to Zama once, and answers the same request from the cache", async () => {
    await store.transaction((tx) => tx.savePublished([handle(1), handle(2)], GAME, 10));
    const ask = (hs: string[]) => gate.submit("public-decrypt", { ciphertextHandles: hs, extraData: "0x00" });
    const first = await ask([handle(1), handle(2)]);
    expect(first.status).toBe(202);
    // Asked again while the job runs: the same job, nothing sent.
    expect(await ask([handle(1), handle(2)])).toMatchObject({ status: 202, body: first.body });
    expect((await gate.poll("public-decrypt", "job-1")).status).toBe(200);
    // Done: the request and its polls are answered from the cache.
    expect(await ask([handle(1), handle(2)])).toMatchObject({ status: 202, body: first.body });
    expect(await gate.poll("public-decrypt", "job-1")).toMatchObject({ status: 200, body: { status: "succeeded", path: "public-decrypt/job-1" } });
    expect(upstream.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST public-decrypt", "GET public-decrypt/job-1"]);
  });

  it("refuses a handle already sent to Zama in too many different requests", async () => {
    await store.transaction((tx) => tx.savePublished([handle(1), handle(2), handle(3)], GAME, 10));
    const ask = (hs: string[]) => gate.submit("public-decrypt", { ciphertextHandles: hs, extraData: "0x00" });
    await ask([handle(1)]);
    await ask([handle(1), handle(2)]);
    await ask([handle(2), handle(1)]);
    expect(await refusal(ask([handle(1), handle(3)]))).toBe("bad-request");
    // The requests already made are still answered.
    expect((await ask([handle(2), handle(1)])).status).toBe(202);
    expect(upstream.calls).toHaveLength(3);
  });

  it("sends a public decryption again when Zama lost the job", async () => {
    await store.transaction((tx) => tx.savePublished([handle(1)], GAME, 10));
    const ask = () => gate.submit("public-decrypt", { ciphertextHandles: [handle(1)], extraData: "0x00" });
    await ask();
    upstream.getStatus = 404;
    await gate.poll("public-decrypt", "job-1");
    await ask();
    expect(upstream.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  const input = (contractAddress: string, chain = CHAIN_ID, userAddress = wallet.address) => ({
    contractAddress,
    userAddress,
    ciphertextWithInputVerification: "abcd",
    contractChainId: `0x${chain.toString(16)}`,
    extraData: "0x00",
  });

  it("makes encrypted inputs for the protocol's contracts only", async () => {
    const auth = await bearer(wallet);
    await gate.submit("input-proof", input(GAME), auth);
    expect(await refusal(gate.submit("input-proof", input(OTHER), auth))).toBe("not-ours");
    expect(await refusal(gate.submit("input-proof", input(GAME, 1), auth))).toBe("bad-request");
    expect(upstream.calls).toHaveLength(1);
  });

  it("charges an input inputUnits to the wallet whose permit comes with it", async () => {
    await gate.submit("input-proof", input(GAME), await bearer(wallet));
    await gate.submit("input-proof", input(GAME), await bearer(wallet));
    expect((await gate.allowance(ACCOUNT)).freeLeft).toBe(1);
    expect(await refusal(gate.submit("input-proof", input(GAME), await bearer(wallet)))).toBe("no-credits");
    await store.transaction((tx) => tx.addCredits(ACCOUNT, 1));
    await gate.submit("input-proof", input(GAME), await bearer(wallet));
    expect(await gate.allowance(ACCOUNT)).toMatchObject({ freeLeft: 0, credits: 0, inputUnits: 2 });
    expect(upstream.calls).toHaveLength(3);
  });

  it("refuses an input without a permit, or with someone else's: it would spend their units", async () => {
    const other = Wallet.createRandom();
    expect(await refusal(gate.submit("input-proof", input(GAME)))).toBe("bad-permit");
    expect(await refusal(gate.submit("input-proof", input(GAME), "Bearer not-base64-json"))).toBe("bad-permit");
    expect(await refusal(gate.submit("input-proof", input(GAME), await bearer(other)))).toBe("bad-permit");
    expect(await refusal(gate.submit("input-proof", input(GAME), await bearer(wallet, NOW - 2 * 86_400)))).toBe("bad-permit");
    expect(upstream.calls).toHaveLength(0);
    expect((await gate.allowance(ACCOUNT)).freeLeft).toBe(5);
  });

  it("gives a wallet the index has never seen act the smaller newcomer allowance", async () => {
    const strict = new RelayerGate(store, upstream, eip712PermitVerifier(DOMAIN), { recentlyPublished: async () => [] }, { now: () => NOW }, {
      chainId: CHAIN_ID,
      contracts: async () => [GAME, CUSDC],
      freePerDay: 5,
      newcomerPerDay: 2,
      inputUnits: 2,
      maxHandles: 10,
      clockSkew: 600,
      publicPerHandle: 3,
    });
    expect((await strict.allowance(ACCOUNT)).freePerDay).toBe(2);
    await strict.submit("input-proof", input(GAME), await bearer(wallet));
    expect(await refusal(strict.submit("user-decrypt", await userDecrypt(wallet, 1)))).toBe("no-credits");
    // Its mint is indexed: it is a player now, and gets the rest of a player's day.
    await store.transaction((tx) => tx.saveUser({ address: ACCOUNT, firstBlock: 1, lastBlock: 1, firstSeenAt: NOW, lastSeenAt: NOW, actions: 1, registeredAt: null, lastLoginAt: null }));
    expect(await strict.allowance(ACCOUNT)).toMatchObject({ freePerDay: 5, freeLeft: 3 });
  });

  it("passes polling through, and keeps the key URL a while", async () => {
    await gate.poll("user-decrypt", "job-1");
    expect(await refusal(gate.poll("user-decrypt", "../admin"))).toBe("bad-request");
    await gate.keyUrl();
    await gate.keyUrl();
    expect(upstream.calls.map((c) => c.path)).toEqual(["user-decrypt/job-1", "keyurl"]);
  });
});

describe("relayer proxy over HTTP", () => {
  let app: FastifyInstance;
  let upstream: FakeUpstream;

  beforeEach(async () => {
    const store = new MemoryStore();
    upstream = new FakeUpstream();
    const clock = { now: () => NOW };
    const queries = new Queries(store, new FakeChainState());
    app = await buildServer({
      queries,
      metadata: new Metadata(queries, "http://api"),
      signIn: new SignIn(store, ethersVerifier, new HmacSessions("x".repeat(32)), clock, "test", () => "n"),
      relayer: new RelayerGate(store, upstream, eip712PermitVerifier(DOMAIN), { recentlyPublished: async () => [] }, clock, {
        chainId: CHAIN_ID,
        contracts: async () => [GAME, CUSDC],
        freePerDay: 1,
        newcomerPerDay: 1,
        inputUnits: 5,
        maxHandles: 10,
        clockSkew: 600,
        publicPerHandle: 3,
      }),
      corsOrigins: ["*"],
      rateLimitPerMinute: 1000,
    });
  });

  it("passes Zama's answer on, Retry-After included", async () => {
    const res = await app.inject({ method: "POST", url: "/relayer/v2/user-decrypt", payload: await userDecrypt(wallet, 1) });
    expect(res.statusCode).toBe(202);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.json()).toMatchObject({ status: "queued", result: { jobId: "job-1" } });
    const poll = await app.inject({ method: "GET", url: "/relayer/v2/user-decrypt/job-1" });
    expect(poll.json()).toMatchObject({ status: "succeeded" });
  });

  it("refuses in the relayer's own error shape, with a code the app reads", async () => {
    await app.inject({ method: "POST", url: "/relayer/v2/user-decrypt", payload: await userDecrypt(wallet, 1) });
    const res = await app.inject({ method: "POST", url: "/relayer/v2/user-decrypt", payload: await userDecrypt(wallet, 1) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ status: "failed", requestId: "dno-gate", error: { label: "request_error", message: expect.stringMatching(/^dno:no-credits: /) } });
    const allowance = await app.inject({ method: "GET", url: `/v1/relayer/allowance/${wallet.address}` });
    expect(allowance.json().data).toMatchObject({ freePerDay: 1, freeLeft: 0, credits: 0 });
  });

  it("hands the Authorization header to the gate, so an input is charged to its wallet", async () => {
    const payload = { contractAddress: GAME, userAddress: wallet.address, ciphertextWithInputVerification: "abcd", contractChainId: `0x${CHAIN_ID.toString(16)}`, extraData: "0x00" };
    const without = await app.inject({ method: "POST", url: "/relayer/v2/input-proof", payload });
    expect(without.json().error.message).toMatch(/^dno:bad-permit: /);
    const res = await app.inject({ method: "POST", url: "/relayer/v2/input-proof", payload, headers: { authorization: await bearer(wallet) } });
    // Five units an input, one free a day: refused for credits, so the token was read.
    expect(res.json().error.message).toMatch(/^dno:no-credits: /);
  });

  it("lets the Relayer SDK's headers through CORS and exposes Retry-After", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/relayer/v2/user-decrypt",
      headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,zama-sdk-version,zama-sdk-name" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-headers"]).toContain("zama-sdk-version");
    const post = await app.inject({ method: "POST", url: "/relayer/v2/public-decrypt", headers: { origin: "https://app.example" }, payload: { ciphertextHandles: [handle(1)], extraData: "0x00" } });
    expect(post.headers["access-control-expose-headers"]).toContain("retry-after");
  });
});
