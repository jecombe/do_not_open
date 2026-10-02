import { AbstractProvider, Interface, type PerformActionRequest } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { SEPOLIA, SEPOLIA_DEPLOYMENT } from "../src/evm/chains";
import { EvmFhevmAdapter } from "../src/evm/EvmFhevmAdapter";
import { IndexerClient } from "../src/evm/indexer";
import { MOCK_NIGHT_SHIFT, MOCK_YOU, MockAdapter } from "../src";

const iface = new Interface(SEPOLIA_DEPLOYMENT.abi);

/** A read-only node that answers the collection's views through `views`, and counts calls. */
class FakeNode extends AbstractProvider {
  calls: string[] = [];
  constructor(private readonly views: (fn: string, args: unknown[]) => unknown[]) {
    super(SEPOLIA.chainId, { staticNetwork: true } as never);
  }
  override async _perform<T>(req: PerformActionRequest): Promise<T> {
    if (req.method === "getBlockNumber") return 1000 as T;
    if (req.method === "chainId") return BigInt(SEPOLIA.chainId) as T;
    if (req.method === "call") {
      const parsed = iface.parseTransaction({ data: req.transaction.data! })!;
      this.calls.push(parsed.name);
      return iface.encodeFunctionResult(parsed.name, this.views(parsed.name, [...parsed.args])) as T;
    }
    throw new Error(`unexpected ${req.method}`);
  }
  override async _detectNetwork() {
    return { chainId: BigInt(SEPOLIA.chainId), name: "sepolia" } as never;
  }
}

const noWallet = { current: () => null, options: () => [], connect: async () => Promise.reject(new Error("no")), disconnect: async () => {}, onChange: () => () => {} };

function adapter(node: FakeNode, api: IndexerClient | undefined) {
  return new EvmFhevmAdapter({
    chain: SEPOLIA,
    address: SEPOLIA_DEPLOYMENT.address,
    abi: SEPOLIA_DEPLOYMENT.abi,
    readProvider: node,
    wallet: noWallet,
    loadRelayer: async () => Promise.reject(new Error("no relayer in tests")),
    indexer: api,
  });
}

/** An API answering canned bodies by path. */
function api(routes: Record<string, unknown>, opts: { now?: () => number } = {}) {
  const asked: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.test", "");
    asked.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/v1/sync/nudge") return new Response("{}", { status: 202 });
    if (!(path in routes)) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(routes[path]));
  });
  return { client: new IndexerClient("https://api.test/", { fetch: fetch as unknown as typeof globalThis.fetch, ...opts }), asked };
}

const DUEL = { duelId: 3, tokenA: 1, tokenB: 2, reserved: true, challenger: "0xaaa", accepter: null, status: "open", openUntil: 2_000_000_000, winner: null, createdBlock: 9 };

describe("IndexerClient", () => {
  it("turns the API's strings back into bigints", async () => {
    const { client } = api({
      "/v1/boxes/4": { block: 10, data: { tokenId: 4, status: "revealed", aliveCheck: "none", partner: null, wins: 2, publicTraits: [], revealed: { seed: "18446744073709551615", state: 1, traits: [1, 2, 3, 4, 5], score: 9, affection: 0, golden: false }, openedBy: "0x1" } },
      "/v1/boxes/4/pantry": { block: 10, data: { welcomed: true, nextClaimAt: 5, weighing: "done", weighIn: { weight: "1200", build: "huge", sick: true, disease: "arthritic", tolerance: "1100" } } },
    });
    const box = await client.box(4);
    expect(box).toMatchObject({ block: 10, data: { wins: 2, revealed: { seed: 18446744073709551615n } } });
    expect(box.data).not.toHaveProperty("openedBy");
    expect((await client.boxPantry(4)).data.weighIn).toEqual({ weight: 1200n, build: "huge", sick: true, disease: "arthritic", tolerance: 1100n });
  });

  it("steps aside for a while after a failure", async () => {
    let now = 0;
    const { client } = api({}, { now: () => now });
    expect(client.available()).toBe(true);
    await expect(client.box(1)).rejects.toThrow("API 500");
    expect(client.available()).toBe(false);
    now = 30_001;
    expect(client.available()).toBe(true);
  });

  it("nudges at most once every few seconds", async () => {
    let now = 0;
    const { client, asked } = api({}, { now: () => now });
    client.nudge();
    client.nudge();
    now = 3_001;
    client.nudge();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked.filter((a) => a === "POST /v1/sync/nudge")).toHaveLength(2);
  });

  it("sends a duel query with the account and the boxes", async () => {
    const { client, asked } = api({ "/v1/duels?account=0xaaa&tokens=1%2C2&open=true": { block: 10, data: [DUEL] } });
    expect((await client.duels({ account: "0xaaa", tokenIds: [1, 2], open: true })).data).toEqual([
      { duelId: 3, tokenA: 1, tokenB: 2, reserved: true, challenger: "0xaaa", accepter: null, status: "open", openUntil: 2_000_000_000 },
    ]);
    expect(asked).toEqual(["GET /v1/duels?account=0xaaa&tokens=1%2C2&open=true"]);
  });
});

describe("EvmFhevmAdapter with the API", () => {
  const views = (fn: string) => {
    if (fn === "duelCount") return [1];
    if (fn === "entangleProposer") return ["0x0000000000000000000000000000000000000000"];
    // Box 5 on the shelf, reserved for box 6, until far ahead.
    if (fn === "duelInfo") return [5, 6, "0x00000000000000000000000000000000000000aa", 2, "0x0000000000000000000000000000000000000000", true, 4_000_000_000];
    throw new Error(fn);
  };

  it("reads through the API, without touching the RPC", async () => {
    const node = new FakeNode(views);
    const { client } = api({ "/v1/pairs/1/2": { block: 10, data: { openDuel: DUEL, entangleProposal: null } } });
    expect((await adapter(node, client).pair(1, 2)).openDuel).toMatchObject({ duelId: 3 });
    expect(node.calls).toEqual([]);
  });

  it("reads the chain when the API is down", async () => {
    const node = new FakeNode(views);
    const { client } = api({});
    const pair = await adapter(node, client).pair(5, 6);
    expect(pair.openDuel).toMatchObject({ duelId: 0, tokenA: 5, tokenB: 6, reserved: true, status: "open" });
    expect(node.calls).toContain("duelInfo");
  });

  it("scans recent duels on the chain when there is no API", async () => {
    const node = new FakeNode(views);
    const duels = await adapter(node, undefined).duels({ tokenIds: [6] });
    expect(duels.map((d) => d.duelId)).toEqual([0]);
    expect(await adapter(node, undefined).duels({ tokenIds: [7] })).toEqual([]);
    expect(await adapter(node, undefined).duels({})).toEqual([]);
  });

  it("reads the duel shelf from the API, or scans the chain without it", async () => {
    const { client, asked } = api({ "/v1/duels/shelf": { block: 10, data: [DUEL] } });
    expect((await adapter(new FakeNode(views), client).duelShelf()).map((d) => d.duelId)).toEqual([3]);
    expect(asked).toContain("GET /v1/duels/shelf");
    expect((await adapter(new FakeNode(views), undefined).duelShelf()).map((d) => d.duelId)).toEqual([0]);
  });
});

describe("MockAdapter.duels", () => {
  it("lists the duels an account posted or that touch its boxes, newest first", async () => {
    const chain = new MockAdapter({ latency: 0 });
    await chain.connect();
    const mine = await chain.mint(2);
    const ids = (await chain.boxSummaries(0, 50)).filter((b) => !b.mine).map((b) => b.tokenId);
    const first = (await chain.postDuel(mine[0]!, { reservedFor: ids[0]! })).duelId;
    const second = (await chain.postDuel(mine[1]!, { reservedFor: ids[1]! })).duelId;
    expect((await chain.duels({ account: MOCK_YOU })).map((d) => d.duelId)).toEqual([second, first]);
    expect((await chain.duels({ tokenIds: [ids[1]!] })).map((d) => d.duelId)).toContain(second);
    expect((await chain.duels({ tokenIds: [ids[1]!] })).map((d) => d.duelId)).not.toContain(first);
    // The night shift took both up at once.
    expect((await chain.duels({ account: MOCK_NIGHT_SHIFT, open: true })).map((d) => d.duelId).slice(0, 2)).toEqual([second, first]);
  });
});
