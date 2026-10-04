import { Interface } from "ethers";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/application/ports/logger";
import { deploymentFor } from "../src/infrastructure/chain/deployment";
import { EvmChainSource } from "../src/infrastructure/chain/EvmChainSource";
import { EvmChainState } from "../src/infrastructure/chain/EvmChainState";
import { MULTICALL3 } from "../src/infrastructure/chain/multicall";
import { RpcPool } from "../src/infrastructure/chain/RpcPool";

const d = deploymentFor("sepolia");
const collection = new Interface(d.collection.abi);
const pantry = new Interface(d.pantry!.abi);
const multicallAbi = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const ALICE = "0x6a18cfc3faeef453b295b12246d40a82593b3208";
const BOB = "0x590891f269720001435004a1089cab5b2c20029a";

function log(address: string, iface: Interface, name: string, args: unknown[], block: number, logIndex: number) {
  const { topics, data } = iface.encodeEventLog(name, args);
  return { address: address.toLowerCase(), topics, data, blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${"ab".repeat(31)}${logIndex.toString(16).padStart(2, "0")}`, logIndex: `0x${logIndex.toString(16)}` };
}

/** A node that serves `logs`, answers views through `views`, and counts what it was asked. */
function node(logs: ReturnType<typeof log>[], views: (target: string, fn: string, args: unknown[]) => unknown[] | null) {
  const asked: string[] = [];
  let multicallCalls = 0;
  const answer = (m: { id: number; method: string; params: any[] }) => {
    asked.push(m.method);
    switch (m.method) {
      case "eth_blockNumber":
        return "0x100";
      case "eth_getLogs": {
        const wanted: string[] = m.params[0].address.map((a: string) => a.toLowerCase());
        return logs.filter((l) => wanted.includes(l.address));
      }
      case "eth_getBlockByNumber":
        return { timestamp: `0x${(1_790_000_000 + Number(m.params[0])).toString(16)}` };
      case "eth_call": {
        expect(m.params[0].to).toBe(MULTICALL3);
        multicallCalls++;
        const [calls] = multicallAbi.decodeFunctionData("aggregate3", m.params[0].data);
        const results = (calls as { target: string; callData: string }[]).map((c) => {
          const iface = c.target.toLowerCase() === d.collection.address.toLowerCase() ? collection : pantry;
          const parsed = iface.parseTransaction({ data: c.callData })!;
          const out = views(c.target.toLowerCase(), parsed.name, [...parsed.args]);
          return out ? { success: true, returnData: iface.encodeFunctionResult(parsed.name, out) } : { success: false, returnData: "0x" };
        });
        return multicallAbi.encodeFunctionResult("aggregate3", [results]);
      }
    }
    throw new Error(`unexpected ${m.method}`);
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const out = Array.isArray(body) ? body.map((m) => ({ jsonrpc: "2.0", id: m.id, result: answer(m) })) : { jsonrpc: "2.0", id: body.id, result: answer(body) };
    return new Response(JSON.stringify(out));
  }) as unknown as typeof globalThis.fetch;
  const rpc = new RpcPool({ urls: ["https://node"], rps: 1000, maxLogRange: 10_000, fetch });
  return { rpc, asked, multicalls: () => multicallCalls };
}

describe("EvmChainSource", () => {
  it("decodes the protocol's logs and fills them in with one multicall", async () => {
    const c = d.collection.address;
    const p = d.pantry!.address;
    const logs = [
      log(c, collection, "MintPlaced", [10, ALICE, 3, "0x" + "11".repeat(32)], 200, 0),
      log(c, collection, "ConfidentialTransfer", [10, "0x0000000000000000000000000000000000000000", ALICE, "0x" + "22".repeat(32)], 200, 1),
      log(c, collection, "DuelPosted", [4, 10, 0, ALICE, false], 201, 2),
      log(c, collection, "RequestPlaced", [9, 10, BOB, 2], 202, 3),
      log(c, collection, "RequestSettled", [9, 3], 203, 4),
      log(c, collection, "Observed", [12, ALICE, 8177263914793887761n, 2, 1600, false], 204, 5),
      log(c, collection, "DuelResolved", [4, 11, 10, 1, 50], 205, 6),
      log(p, pantry, "Weighed", [12, 1200, 4, true, 1], 206, 7),
      log(p, pantry, "Purred", [12, 3], 206, 8),
    ];
    const views = (_target: string, fn: string, args: unknown[]) => {
      if (fn === "duelInfo") return [10, 11, ALICE, 4, BOB, false, 1_790_600_000];
      if (fn === "requestInfo") return [2, 3, BOB, 10, 12, []];
      if (fn === "contentsOf") return [{ seed: 8177263914793887761n, state: 2, traits: [232, 155, 52, 122, 123], score: 1600, affection: 3, golden: false }];
      if (fn === "weighIn") return [{ status: 2, build: 4, sick: true, disease: 1, weight: 1200, tolerance: 1100 }];
      throw new Error(`unexpected view ${fn}(${args})`);
    };
    const { rpc, asked, multicalls } = node(logs, views);
    const source = new EvmChainSource(rpc, d, silentLogger);

    const batch = await source.read(200, 206);
    expect(batch.to).toBe(206);
    expect(batch.events.map((e) => e.name)).toEqual(["MintPlaced", "ConfidentialTransfer", "DuelPosted", "RequestPlaced", "RequestSettled", "Observed", "DuelResolved", "Weighed", "Purred"]);
    expect(batch.events[0]).toMatchObject({ firstTokenId: 10, buyer: ALICE.toLowerCase(), count: 3, source: "collection", block: 200, timestamp: 1_790_000_200 });
    expect(batch.events[2]).toMatchObject({ duelId: 4, tokenA: 10, tokenB: 0, challenger: ALICE.toLowerCase(), reserved: false });
    expect(batch.events[3]).toMatchObject({ requestId: 9, kind: "entangle", requester: BOB.toLowerCase() });
    expect(batch.events[4]).toMatchObject({ status: "refused" });
    expect(batch.events[5]).toMatchObject({ tokenId: 12, seed: "8177263914793887761", score: 1600 });
    expect(batch.events[7]).toMatchObject({ source: "pantry", weight: "1200", build: 4, sick: true, disease: 1 });

    expect(batch.snapshots.duels.get(4)).toEqual({ tokenA: 10, tokenB: 11, reserved: false, challenger: ALICE.toLowerCase(), accepter: BOB.toLowerCase(), status: "resolved", openUntil: 1_790_600_000 });
    expect(batch.snapshots.requests.get(9)).toEqual({ kind: "entangle", status: "refused", requester: BOB.toLowerCase(), tokenId: 10, other: 11 });
    expect(batch.snapshots.contents.get(12)).toMatchObject({ affection: 3, traits: [232, 155, 52, 122, 123] });
    expect(batch.snapshots.weighIns.get(12)).toEqual({ weight: "1200", build: "huge", sick: true, disease: "arthritic", tolerance: "1100" });

    // One getLogs for the protocol and one for the ACL, one batch of block headers, one
    // multicall: whatever the number of events.
    expect(asked.filter((m) => m === "eth_getLogs")).toHaveLength(2);
    expect(multicalls()).toBe(1);
  });

  it("decodes a studio pack bought, once StudioPacks is in the deployment", async () => {
    const studioAbi = ["event PackBought(address indexed payer, address indexed account, uint256 indexed packId, uint256 sketches, uint256 models, uint256 paid)"];
    const studioAddress = "0x00000000000000000000000000000000005707d0";
    const withStudio = { ...d, studio: { address: studioAddress, abi: studioAbi } };
    const logs = [log(studioAddress, new Interface(studioAbi), "PackBought", [ALICE, BOB, 1, 50, 5, 8_000_000], 210, 0)];
    const { rpc } = node(logs, () => null);
    const batch = await new EvmChainSource(rpc, withStudio, silentLogger).read(210, 210);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ name: "PackBought", source: "studio", payer: ALICE.toLowerCase(), account: BOB.toLowerCase(), packId: 1, sketches: 50, models: 5, paid: "8000000" });
  });

  it("decodes the rats' mints, transfers and croquettes, once Rats and RatPantry are in the deployment", async () => {
    const ratsAbi = [
      "event RatMinted(uint256 indexed tokenId, address indexed minter, uint8 kind, bytes32 ref, string uri, uint256 paid)",
      "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    ];
    const pantryAbi = ["event RatsFed(address indexed owner, uint256[] ids, uint256 amount)"];
    const ratsAddress = "0x00000000000000000000000000000000000000a7";
    const pantryAddress = "0x00000000000000000000000000000000000000a8";
    const withRats = { ...d, rats: { address: ratsAddress, abi: ratsAbi }, ratPantry: { address: pantryAddress, abi: pantryAbi } };
    const job = "0x" + "ab".repeat(32);
    const logs = [
      log(ratsAddress, new Interface(ratsAbi), "Transfer", ["0x0000000000000000000000000000000000000000", ALICE, 1], 220, 0),
      log(ratsAddress, new Interface(ratsAbi), "RatMinted", [1, ALICE, 0, "0x" + (2n ** 64n - 1n).toString(16).padStart(64, "0"), "", 1_000_000], 220, 1),
      log(ratsAddress, new Interface(ratsAbi), "RatMinted", [2, BOB, 1, job, "ar://rec", 3_000_000], 221, 0),
      log(pantryAddress, new Interface(pantryAbi), "RatsFed", [ALICE, [1, 3], 70], 222, 0),
    ];
    const { rpc } = node(logs, () => null);
    const batch = await new EvmChainSource(rpc, withRats, silentLogger).read(220, 222);
    expect(batch.events).toHaveLength(4);
    expect(batch.events[0]).toMatchObject({ name: "RatTransfer", source: "rats", ratId: 1, to: ALICE.toLowerCase() });
    expect(batch.events[1]).toMatchObject({ name: "RatMinted", ratId: 1, kind: "seed", ref: "18446744073709551615", uri: "", paid: "1000000" });
    expect(batch.events[2]).toMatchObject({ name: "RatMinted", ratId: 2, kind: "model", ref: job, uri: "ar://rec", minter: BOB.toLowerCase() });
    expect(batch.events[3]).toMatchObject({ name: "RatsFed", source: "ratPantry", owner: ALICE.toLowerCase(), ratIds: [1, 3], amount: "70" });
    // A rat id is not a box id.
    expect(batch.events[0]).not.toHaveProperty("tokenId");
  });

  it("asks for the protocol's contracts and event topics only", async () => {
    const filters: { address: string[]; topics: (string | string[])[] }[] = [];
    const fetch = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "eth_getLogs") filters.push(body.params[0]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }));
    }) as unknown as typeof globalThis.fetch;
    const source = new EvmChainSource(new RpcPool({ urls: ["https://n"], rps: 100, maxLogRange: 100, fetch }), d, silentLogger);
    expect(await source.read(1, 50)).toMatchObject({ to: 50, events: [] });
    const [filter, acl] = filters;
    expect(filter!.address).toEqual([d.collection.address, d.pantry!.address, d.ramp!.address, ...(d.credits ? [d.credits.address] : []), ...(d.studio ? [d.studio.address] : []), ...(d.rats ? [d.rats.address] : []), ...(d.ratPantry ? [d.ratPantry.address] : [])].map((a) => a.toLowerCase()));
    const decryptionProof = collection.getEvent("PublicDecryptionVerified")!.topicHash;
    expect(filter!.topics[0]).not.toContain(decryptionProof);
    for (const name of ["DuelPosted", "DuelOpened", "DuelAccepted", "DuelReopened"]) expect(filter!.topics[0]).toContain(collection.getEvent(name)!.topicHash);
    // The ACL, only where the protocol's own contracts are the caller.
    expect(acl!.address).toEqual([d.fhevm.acl.toLowerCase()]);
    expect(acl!.topics[1]).toEqual([d.collection.address, d.pantry!.address, d.cCroq!.address].map((a) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`));
  });

  it("reads which handles the protocol made public from the ACL", async () => {
    const acl = new Interface(["event AllowedForDecryption(address indexed caller, bytes32[] handlesList)"]);
    const h1 = "0x" + "AB".repeat(32);
    const h2 = "0x" + "cd".repeat(32);
    const logs = [log(d.fhevm.acl, acl, "AllowedForDecryption", [d.collection.address, [h1, h2]], 300, 0)];
    const { rpc } = node(logs, () => null);
    const batch = await new EvmChainSource(rpc, d, silentLogger).read(300, 300);
    expect(batch.events).toEqual([expect.objectContaining({ name: "PubliclyDecryptable", source: "acl", caller: d.collection.address.toLowerCase(), handles: [h1.toLowerCase(), h2] })]);
  });
});

describe("EvmChainState", () => {
  it("reads the collection's constants once, and batches claim times into one multicall", async () => {
    const views = (_t: string, fn: string, args: unknown[]) => {
      const constants: Record<string, unknown[]> = {
        mintPrice: [5_000_000], observeFee: [1_000_000], feedFee: [500_000], paidShakeFee: [2_500_000],
        maxSupply: [10000], maxPerTx: [10], milestones: [[100, 500]], feeBps: [30],
      };
      if (fn === "nextClaimAt") return [1_800_000_000 + Number(args[0])];
      return constants[fn] ?? null;
    };
    const { rpc, multicalls } = node([], views);
    const state = new EvmChainState(rpc, { ...d, ramp: null }, { economyTtlMs: 1000, claimTtlMs: 60_000 });
    const [a, b] = await Promise.all([state.collection(), state.collection()]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ fees: { mint: "5000000" }, maxSupply: 10000, milestones: [100, 500], rampFeeBps: null });
    expect(multicalls()).toBe(1);

    const claims = await Promise.all([1, 2, 3, 2].map((id) => state.nextClaimAt(id)));
    expect(claims).toEqual([1_800_000_001, 1_800_000_002, 1_800_000_003, 1_800_000_002]);
    expect(multicalls()).toBe(2);
    await state.nextClaimAt(3);
    expect(multicalls()).toBe(2);
  });
});
