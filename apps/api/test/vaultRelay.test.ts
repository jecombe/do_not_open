import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignIn } from "../src/application/auth";
import { ImageArchive } from "../src/application/archive";
import { Metadata } from "../src/application/metadata";
import { Queries } from "../src/application/queries";
import { VaultRelay, VaultRelayRefused } from "../src/application/vaultRelay";
import type { PocketCall, PocketTxs, VaultFinalizeTx, VaultRequestTx, VaultSender } from "../src/application/ports/vault";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import { buildServer } from "../src/infrastructure/http/server";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { FakeChainState } from "./fixtures";

const RELAYER = "0x00000000000000000000000000000000000a11e0";
const HANDLE = "0x" + "ab".repeat(32);

/** Records what it would send; a box id of 666 is one the vault refuses. */
class FakeSender implements VaultSender {
  readonly address = RELAYER;
  readonly sent: (VaultRequestTx | VaultFinalizeTx | { call: PocketCall; tx: unknown })[] = [];
  async request(tx: VaultRequestTx): Promise<string> {
    if (tx.boxId === 666) throw new VaultRelayRefused("reverted", "The vault would refuse it: BoxBusy.");
    this.sent.push(tx);
    return "0x" + String(this.sent.length).padStart(64, "0");
  }
  async finalize(tx: VaultFinalizeTx): Promise<string> {
    this.sent.push(tx);
    return "0x" + String(this.sent.length).padStart(64, "0");
  }
  async pockets<C extends PocketCall>(call: C, tx: PocketTxs[C]): Promise<string> {
    // A send naming pocket 666 is one the pockets refuse.
    if (call === "pocketSend" && (tx as PocketTxs["pocketSend"]).from.includes(666)) throw new VaultRelayRefused("reverted", "The vault would refuse it: NotAPocket.");
    this.sent.push({ call, tx });
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
    const refused = { boxId: 666, action: 0, to: RELAYER, price: 0n, endTime: 0, ref: HANDLE, handle: HANDLE, inputProof: "0x" };
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
    app = await buildServer({ ...deps, vaultRelay: new VaultRelay(sender, { now: () => 0 }, 100), vaultRelayRatePerMinute: 1000 } as Parameters<typeof buildServer>[0]);
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
    expect(sender.sent.at(-1)).toMatchObject({ boxId: 3, action: 1, price: 1_000_000_000_000_000n, handle: HANDLE, ref: "0x" + "0".repeat(64) });
  });

  it("relays accepting an offer: its order hash with the request, the order with the proof", async () => {
    const ref = "0x" + "ab".repeat(32);
    const args = { boxId: 4, action: 4, to: RELAYER, price: "1", endTime: 0, ref, handle: HANDLE, inputProof: "0xdead" };
    expect((await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "request", args } })).statusCode).toBe(200);
    expect(sender.sent.at(-1)).toMatchObject({ action: 4, ref });
    const fin = { requestId: 9, cleartexts: "0x01", proof: "0x02", offer: "0x" + "cd".repeat(600) };
    expect((await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "finalize", args: fin } })).statusCode).toBe(200);
    expect(sender.sent.at(-1)).toMatchObject({ requestId: 9, offer: fin.offer });
  });

  const spend = { amount: HANDLE, target: HANDLE, inputProof: "0xbeef", boundKey: HANDLE, keyProof: "0xcafe" };

  it("relays a pocket's open, send and withdrawal as given", async () => {
    const viewer = "0x00000000000000000000000000000000000b0c55";
    const calls = [
      { call: "pocketOpen", args: { handle: HANDLE, inputProof: "0xdead", viewer } },
      { call: "pocketSend", args: { from: [1, 4, 7], to: [0, 2], input: spend } },
      { call: "pocketWithdraw", args: { from: [3], to: RELAYER, input: spend } },
    ];
    for (const payload of calls) {
      const res = await app.inject({ method: "POST", url: "/v1/vault/relay", payload });
      expect(res.statusCode).toBe(200);
      expect(sender.sent.at(-1)).toEqual({ call: payload.call, tx: payload.args });
    }
  });

  it("passes on which token's pockets a call names, and checks it is an address", async () => {
    const pockets = "0x6d1585c58238daadf748558051bf368daa3ecee2";
    const payload = { call: "pocketWithdraw", args: { from: [3], to: RELAYER, input: spend, pockets } };
    expect((await app.inject({ method: "POST", url: "/v1/vault/relay", payload })).statusCode).toBe(200);
    expect(sender.sent.at(-1)).toMatchObject({ call: "pocketWithdraw", tx: { pockets: expect.stringMatching(/^0x6d1585c58238daadf748558051bf368daa3ecee2$/i) } });
    const bad = await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { ...payload, args: { ...payload.args, pockets: "cZAMA" } } });
    expect(bad.statusCode).toBe(400);
  });

  it("relays the desk's ask and purchase", async () => {
    const ask = { saleId: 5, handle: HANDLE, keyProof: "0xdead", boxKey: HANDLE };
    expect((await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "deskAsk", args: ask } })).statusCode).toBe(200);
    expect(sender.sent.at(-1)).toEqual({ call: "deskAsk", tx: ask });
    const buy = { askId: 2, cleartexts: "0x01", proof: "0x02", boxKey: HANDLE, boxKeyProof: "0x03" };
    expect((await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "deskBuy", args: buy } })).statusCode).toBe(200);
    expect(sender.sent.at(-1)).toEqual({ call: "deskBuy", tx: buy });
  });

  const funds = { set0: [1, 3], set1: [2], amount0: HANDLE, amount1: HANDLE, target0: HANDLE, target1: HANDLE, inputProof: "0xbeef", amount0Min: "990", amount1Min: "0", deadline: 1_790_003_600 };
  const keys = { boundKey0: HANDLE, boundKey1: HANDLE, keyProof: "0xcafe" };
  const out = { set0: [1, 3], set1: [2, 4], target0: HANDLE, target1: HANDLE, inputProof: "0xbeef" };
  const range = { token0: "0x9b5cd13b8efbb58dc25a05cf411d8056058adfff", token1: "0xff54739b16576fa5402f211d0b938469ab9a5f3f", fee: 3000, tickLower: -199_980, tickUpper: -198_000 };

  it("relays a position's open, add and settle, with plain amounts as numbers", async () => {
    const calls = [
      { call: "positionOpen", args: { range, controller: RELAYER, funds, keys } },
      { call: "positionAdd", args: { positionId: 3, funds, keys } },
      { call: "positionSettle", args: { fundingId: 7, clear0: "4000000000", proof0: "0x01", clear1: "0", proof1: "0x02" } },
    ];
    for (const payload of calls) {
      expect((await app.inject({ method: "POST", url: "/v1/vault/relay", payload })).statusCode).toBe(200);
      expect(sender.sent.at(-1)).toMatchObject({ call: payload.call });
    }
    expect(sender.sent.at(-1)).toMatchObject({ tx: { clear0: 4_000_000_000n, clear1: 0n } });
    expect(sender.sent.at(-3)).toMatchObject({ tx: { funds: { amount0Min: 990n, set0: [1, 3] } } });
  });

  it("relays a holder's signed collect, decrease, give and take-out", async () => {
    const signed = { deadline: 1_790_003_600, signature: "0x" + "11".repeat(65) };
    const calls = [
      { call: "positionCollect", args: { positionId: 3, out, ...signed } },
      { call: "positionDecrease", args: { positionId: 3, liquidity: "123456789", amount0Min: "1", amount1Min: "2", out, ...signed } },
      { call: "positionGive", args: { positionId: 3, to: RELAYER, ...signed } },
      { call: "positionTakeOut", args: { positionId: 3, to: RELAYER, ...signed } },
    ];
    for (const payload of calls) {
      expect((await app.inject({ method: "POST", url: "/v1/vault/relay", payload })).statusCode).toBe(200);
      expect(sender.sent.at(-1)).toMatchObject({ call: payload.call });
    }
  });

  it("refuses a position call with a bad range, pocket set or amount", async () => {
    const bad = [
      { call: "positionOpen", args: { range: { ...range, tickLower: 900_000 }, controller: RELAYER, funds, keys } },
      { call: "positionOpen", args: { range, controller: RELAYER, funds: { ...funds, set0: [] }, keys } },
      { call: "positionDecrease", args: { positionId: 3, liquidity: "-1", amount0Min: "0", amount1Min: "0", out, deadline: 0, signature: "0x" } },
      { call: "positionGive", args: { positionId: 3, to: "nobody", deadline: 0, signature: "0x" } },
    ];
    for (const payload of bad) expect((await app.inject({ method: "POST", url: "/v1/vault/relay", payload })).statusCode).toBe(400);
  });

  it("refuses pocket sets that are empty or longer than five, and says why the pockets would refuse", async () => {
    for (const from of [[], [1, 2, 3, 4, 5, 6]]) {
      const res = await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "pocketSend", args: { from, to: [0], input: spend } } });
      expect(res.statusCode).toBe(400);
    }
    const bad = await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "pocketOpen", args: { handle: HANDLE, inputProof: "0x", viewer: "nope" } } });
    expect(bad.statusCode).toBe(400);
    const refused = await app.inject({ method: "POST", url: "/v1/vault/relay", payload: { call: "pocketSend", args: { from: [666], to: [0], input: spend } } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("reverted");
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
