import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignIn } from "../src/application/auth";
import { ImageArchive } from "../src/application/archive";
import { Metadata } from "../src/application/metadata";
import { Queries } from "../src/application/queries";
import { VaultRelay, VaultRelayRefused } from "../src/application/vaultRelay";
import type { VaultFinalizeTx, VaultRequestTx, VaultSender } from "../src/application/ports/vault";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import { buildServer } from "../src/infrastructure/http/server";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { FakeChainState } from "./fixtures";

const RELAYER = "0x00000000000000000000000000000000000a11e0";
const HANDLE = "0x" + "ab".repeat(32);

/** Records what it would send; a box id of 666 is one the vault refuses. */
class FakeSender implements VaultSender {
  readonly address = RELAYER;
  readonly sent: (VaultRequestTx | VaultFinalizeTx)[] = [];
  async request(tx: VaultRequestTx): Promise<string> {
    if (tx.boxId === 666) throw new VaultRelayRefused("reverted", "The vault would refuse it: BoxBusy.");
    this.sent.push(tx);
    return "0x" + String(this.sent.length).padStart(64, "0");
  }
  async finalize(tx: VaultFinalizeTx): Promise<string> {
    this.sent.push(tx);
    return "0x" + String(this.sent.length).padStart(64, "0");
  }
}

describe("VaultRelay", () => {
  it("stops at its daily cap and starts again the next day", async () => {
    let now = 1_790_000_000;
    const relay = new VaultRelay(new FakeSender(), { now: () => now }, 2);
    await relay.finalize({ requestId: 0, cleartexts: "0x01", proof: "0x" });
    await relay.finalize({ requestId: 1, cleartexts: "0x01", proof: "0x" });
    await expect(relay.finalize({ requestId: 2, cleartexts: "0x01", proof: "0x" })).rejects.toMatchObject({ code: "daily-cap" });
    now += 86_400;
    await expect(relay.finalize({ requestId: 2, cleartexts: "0x01", proof: "0x" })).resolves.toMatch(/^0x/);
  });

  it("does not count what the vault refused", async () => {
    const relay = new VaultRelay(new FakeSender(), { now: () => 0 }, 1);
    const refused = { boxId: 666, action: 0, to: RELAYER, price: 0n, endTime: 0, handle: HANDLE, inputProof: "0x" };
    await expect(relay.request(refused)).rejects.toBeInstanceOf(VaultRelayRefused);
    await expect(relay.finalize({ requestId: 0, cleartexts: "0x01", proof: "0x" })).resolves.toMatch(/^0x/);
  });
});

describe("vault relay routes", () => {
  let app: FastifyInstance;
  let bare: FastifyInstance;
  const sender = new FakeSender();

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
    app = await buildServer({ ...deps, vaultRelay: new VaultRelay(sender, { now: () => 0 }, 100) } as Parameters<typeof buildServer>[0]);
    bare = await buildServer(deps as Parameters<typeof buildServer>[0]);
  });

  afterAll(async () => {
    await app.close();
    await bare.close();
  });

  it("names the relayer, or none", async () => {
    expect((await app.inject({ url: "/v1/vault/relayer" })).json().data).toEqual({ address: RELAYER });
    expect((await bare.inject({ url: "/v1/vault/relayer" })).json().data).toEqual({ address: null });
    expect((await bare.inject({ method: "POST", url: "/v1/vault/relay", payload: {} })).statusCode).toBe(404);
  });

  it("sends a request with its terms as given", async () => {
    const args = { boxId: 3, action: 1, to: RELAYER, price: "1000000000000000", endTime: 1_800_000_000, handle: HANDLE, inputProof: "0xdead" };
    const res = await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "request", args } });
    expect(res.statusCode).toBe(200);
    expect(res.json().hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sender.sent.at(-1)).toMatchObject({ boxId: 3, action: 1, price: 1_000_000_000_000_000n, handle: HANDLE });
  });

  it("refuses a malformed body and says why the vault would refuse", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "request", args: { boxId: 1 } } });
    expect(bad.statusCode).toBe(400);
    const args = { boxId: 666, action: 0, to: RELAYER, price: "0", endTime: 0, handle: HANDLE, inputProof: "0x" };
    const refused = await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "request", args } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("reverted");
  });
});
