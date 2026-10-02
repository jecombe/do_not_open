import { Wallet, type HDNodeWallet } from "ethers";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { SignIn } from "../src/application/auth";
import { Metadata } from "../src/application/metadata";
import type { RelayerUpstream, UpstreamReply } from "../src/application/ports/relayer";
import { Queries } from "../src/application/queries";
import { RelayerGate, RelayerRefused } from "../src/application/relayerGate";
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

/** A user-decryption request as the Relayer SDK sends it, signed by `signer`. */
async function userDecrypt(signer: Wallet | HDNodeWallet, n: number, opts: { contract?: string; start?: number; userAddress?: string } = {}) {
  const contractAddresses = [GAME, CUSDC];
  const startTimestamp = String(opts.start ?? NOW - 60);
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
  async post(path: string, body: unknown): Promise<UpstreamReply> {
    this.calls.push({ method: "POST", path, body });
    return { status: this.status, body: { status: "queued", requestId: "r1", result: { jobId: "job-1" } }, retryAfter: "1" };
  }
  async get(path: string): Promise<UpstreamReply> {
    this.calls.push({ method: "GET", path });
    return { status: 200, body: { status: "succeeded", path }, retryAfter: null };
  }
}

describe("relayer meter", () => {
  it("takes free units first, then credits, and nothing when both fall short", () => {
    expect(charge(3, { freeUsed: 0, spent: 0, bought: 0 }, 5)).toEqual({ free: 3, credits: 0 });
    expect(charge(3, { freeUsed: 4, spent: 0, bought: 10 }, 5)).toEqual({ free: 1, credits: 2 });
    expect(charge(3, { freeUsed: 5, spent: 9, bought: 10 }, 5)).toBeNull();
    expect(charge(0, { freeUsed: 5, spent: 10, bought: 10 }, 5)).toEqual({ free: 0, credits: 0 });
  });

  it("starts a new free allowance at UTC midnight", () => {
    expect(dayOf(NOW)).toBe("2026-09-21");
    expect(nextDayAt(NOW)).toBe(Date.UTC(2026, 8, 22) / 1000);
    expect(allowanceOf({ freeUsed: 7, spent: 3, bought: 10 }, 5, NOW)).toEqual({ freePerDay: 5, freeLeft: 0, credits: 7, resetsAt: nextDayAt(NOW) });
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
      { chainId: CHAIN_ID, contracts: async () => [GAME, CUSDC], freePerDay: 5, maxHandles: 10, clockSkew: 600 },
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

  it("makes encrypted inputs for the protocol's contracts only", async () => {
    const input = (contractAddress: string, chain = CHAIN_ID) => ({
      contractAddress,
      userAddress: wallet.address,
      ciphertextWithInputVerification: "abcd",
      contractChainId: `0x${chain.toString(16)}`,
      extraData: "0x00",
    });
    await gate.submit("input-proof", input(GAME));
    expect(await refusal(gate.submit("input-proof", input(OTHER)))).toBe("not-ours");
    expect(await refusal(gate.submit("input-proof", input(GAME, 1)))).toBe("bad-request");
    expect(upstream.calls).toHaveLength(1);
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
        maxHandles: 10,
        clockSkew: 600,
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
