import { describe, expect, it } from "vitest";
import { RpcError, RpcPool, type RpcPoolOptions } from "../src/infrastructure/chain/RpcPool";

type Handler = (body: { method: string; params: unknown[] } | { method: string; params: unknown[] }[]) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | Error;

/** A fake network: each URL answers through its own handler; the clock only moves when slept. */
function harness(handlers: Record<string, Handler>, opts: Partial<RpcPoolOptions> = {}) {
  let clock = 0;
  const calls: { url: string; method: string }[] = [];
  const slept: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    for (const b of Array.isArray(body) ? body : [body]) calls.push({ url, method: b.method });
    const out = handlers[url]!(body);
    if (out instanceof Error) throw out;
    return new Response(out.text ?? JSON.stringify(out.json), { status: out.status ?? 200, headers: out.headers });
  }) as unknown as typeof globalThis.fetch;
  const pool = new RpcPool({
    urls: Object.keys(handlers),
    rps: 10,
    maxLogRange: 1000,
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    ...opts,
  });
  return { pool, calls, slept, advance: (ms: number) => (clock += ms) };
}

const ok = (result: unknown, id = 1) => ({ json: { jsonrpc: "2.0", id, result } });
const rpcError = (message: string, code = -32000) => ({ json: { jsonrpc: "2.0", id: 1, error: { code, message } } });
const single = (b: unknown) => b as { method: string; params: unknown[] };
const HEADER = { hash: "0xh", number: "0x1" };

describe("RpcPool", () => {
  it("spreads calls over healthy endpoints", async () => {
    const { pool, calls } = harness({ "https://a": () => ok("0x1"), "https://b": () => ok("0x1") });
    for (let i = 0; i < 4; i++) await pool.call("eth_blockNumber", []);
    expect(calls.map((c) => c.url)).toEqual(["https://a", "https://b", "https://a", "https://b"]);
  });

  it("favours the faster endpoint once it has measured both", async () => {
    let advance = (_ms: number) => 0;
    const h = harness({
      "https://slow": () => (advance(900), ok("0x1")),
      "https://fast": () => (advance(40), ok("0x1")),
    });
    advance = h.advance;
    for (let i = 0; i < 8; i++) await h.pool.call("eth_blockNumber", []);
    const slow = h.calls.filter((c) => c.url === "https://slow").length;
    expect(slow).toBe(1);
    expect(h.pool.status().map((e) => e.latencyMs)).toEqual([900, 40]);
  });

  it("benches an endpoint that answers 429, honouring Retry-After, and moves on", async () => {
    const { pool, calls, advance } = harness({
      "https://a": () => ({ status: 429, text: "slow down", headers: { "retry-after": "30" } }),
      "https://b": () => ok("0x2"),
    });
    expect(await pool.call("eth_blockNumber", [])).toBe("0x2");
    expect(pool.status()[0]).toMatchObject({ healthy: false, cooldownSeconds: 30, failed: 1 });
    await pool.call("eth_blockNumber", []);
    await pool.call("eth_blockNumber", []);
    expect(calls.filter((c) => c.url === "https://a")).toHaveLength(1);
    advance(31_000);
    expect(pool.status()[0]!.healthy).toBe(true);
  });

  it("treats rate-limit messages, outages and refused chains alike: next endpoint", async () => {
    for (const bad of [
      rpcError("Too many requests, rate limit exceeded"),
      new TypeError("fetch failed"),
      { status: 503, text: "<html>" },
      rpcError("chain is not available on free plan, please upgrade to paid plan"),
      // What 1rpc answers when it is overloaded: nothing to go on, so another endpoint is tried.
      rpcError("error", -32000),
    ]) {
      const { pool } = harness({ "https://a": () => bad, "https://b": () => ok("0x3") });
      expect(await pool.call("eth_chainId", [])).toBe("0x3");
      expect(pool.status()[0]!.healthy).toBe(false);
    }
  });

  it("throws the caller's own errors without benching anyone", async () => {
    const { pool, calls } = harness({ "https://a": () => rpcError("execution reverted", 3), "https://b": () => ok("0x") });
    await expect(pool.call("eth_call", [])).rejects.toMatchObject({ kind: "fatal" });
    expect(calls).toHaveLength(1);
    expect(pool.status()[0]!.healthy).toBe(true);
  });

  it("waits for an endpoint when all of them rest, then fails after its attempts", async () => {
    const { pool, slept } = harness({ "https://a": () => ({ status: 429, text: "" }) }, { attempts: 3 });
    await expect(pool.call("eth_blockNumber", [])).rejects.toBeInstanceOf(RpcError);
    // Slept through the cooldowns: 2s, then 4s.
    expect(slept.filter((ms) => ms >= 2000)).toEqual([2000, 4000]);
  });

  it("never sends one endpoint more than its rate", async () => {
    const { pool, slept } = harness({ "https://a": () => ok("0x1") }, { rps: 2, burst: 2 });
    for (let i = 0; i < 6; i++) await pool.call("eth_blockNumber", []);
    // Two from the bucket, then one every 500 ms.
    expect(slept.reduce((a, b) => a + b, 0)).toBe(2000);
  });

  it("learns an endpoint's log range from the limit it names, and keeps to it", async () => {
    const spans: number[] = [];
    const { pool } = harness({
      "https://a": (b) => {
        if (single(b).method === "eth_getBlockByNumber") return ok(HEADER);
        const { fromBlock, toBlock } = single(b).params[0] as { fromBlock: string; toBlock: string };
        const span = Number(toBlock) - Number(fromBlock) + 1;
        spans.push(span);
        return span > 50 ? rpcError("eth_getLogs is limited to 0 - 50 blocks range", -32602) : ok([]);
      },
    });
    expect(await pool.getLogs({ address: ["0x1"] }, 100, 999)).toEqual({ logs: [], to: 149, endpoint: "a" });
    expect(await pool.getLogs({ address: ["0x1"] }, 150, 999)).toEqual({ logs: [], to: 199, endpoint: "a" });
    expect(spans).toEqual([900, 50, 50]);
  });

  it("halves the range when the limit is in results, and grows it back slowly", async () => {
    const spans: number[] = [];
    let dense = true;
    const { pool } = harness({
      "https://a": (b) => {
        if (single(b).method === "eth_getBlockByNumber") return ok(HEADER);
        const { fromBlock, toBlock } = single(b).params[0] as { fromBlock: string; toBlock: string };
        const span = Number(toBlock) - Number(fromBlock) + 1;
        spans.push(span);
        return dense && span > 300 ? rpcError("query returned more than 10000 results") : ok([]);
      },
    });
    await pool.getLogs({ address: ["0x1"] }, 0, 5000);
    dense = false;
    await pool.getLogs({ address: ["0x1"] }, 250, 5000);
    expect(spans).toEqual([1000, 500, 250, 313]);
  });

  it("gives up on an endpoint that refuses every range, and asks another", async () => {
    const { pool } = harness({
      "https://a": () => rpcError("ranges over 10000 blocks are not supported on free plan", 35),
      "https://b": () => ok([{ address: "0x1", topics: [], data: "0x", blockNumber: "0x5", transactionHash: "0xab", logIndex: "0x0" }]),
    });
    const r = await pool.getLogs({ address: ["0x1"] }, 0, 99);
    expect(r.logs).toHaveLength(1);
    expect(pool.status()[0]!.healthy).toBe(false);
  });

  it("drops logs a node marks as removed", async () => {
    const { pool } = harness({
      "https://a": () => ok([{ blockNumber: "0x1", removed: true }, { blockNumber: "0x2", removed: false }]),
    });
    expect((await pool.getLogs({ address: [] }, 1, 2)).logs).toHaveLength(1);
  });

  it("sends batches as one request, or one by one where batches are refused", async () => {
    const batched = harness({ "https://a": (b) => ({ json: (b as { id?: number }[]).map((x, i) => ({ jsonrpc: "2.0", id: (x as { id: number }).id, result: `r${i}` })) }) });
    expect(await batched.pool.batch([{ method: "m", params: [] }, { method: "m", params: [] }])).toEqual(["r0", "r1"]);
    expect(new Set(batched.calls.map((c) => c.url)).size).toBe(1);

    const refusing = harness({ "https://a": (b) => (Array.isArray(b) ? rpcError("batch requests are not allowed", -32600) : ok("one")) });
    expect(await refusing.pool.batch([{ method: "m", params: [] }, { method: "m", params: [] }])).toEqual(["one", "one"]);
  });

  it("does not believe logs from an endpoint that has not seen the end of the range", async () => {
    const { pool, calls } = harness({
      // Behind: knows no block 500, and would answer "no logs" for it.
      "https://lagging": (b) => (single(b).method === "eth_getBlockByNumber" ? ok(null) : ok([])),
      "https://synced": (b) =>
        single(b).method === "eth_getBlockByNumber"
          ? ok(HEADER)
          : ok([{ address: "0x1", topics: [], data: "0x", blockNumber: "0x1f4", transactionHash: "0xab", logIndex: "0x0" }]),
    });
    const r = await pool.getLogs({ address: ["0x1"] }, 400, 500);
    expect(r).toMatchObject({ endpoint: "synced", to: 500 });
    expect(r.logs).toHaveLength(1);
    expect(calls.filter((c) => c.url === "https://lagging").map((c) => c.method)).toEqual(["eth_getBlockByNumber"]);
    // Resting a few seconds, without a strike: it is late, not broken.
    expect(pool.status()[0]).toMatchObject({ healthy: false, cooldownSeconds: 3 });
  });

  it("refuses logs outside the asked range, or from another fork than the header", async () => {
    for (const bad of [
      { blockNumber: "0x10", blockHash: "0xh" },
      { blockNumber: "0x64", blockHash: "0xother" },
    ]) {
      const { pool } = harness({
        "https://a": (b) => (single(b).method === "eth_getBlockByNumber" ? ok(HEADER) : ok([{ ...bad, address: "0x1", topics: [], data: "0x", transactionHash: "0xab", logIndex: "0x0" }])),
        "https://b": (b) => (single(b).method === "eth_getBlockByNumber" ? ok(HEADER) : ok([])),
      });
      expect(await pool.getLogs({ address: ["0x1"] }, 50, 100)).toMatchObject({ endpoint: "b", logs: [] });
    }
  });

  it("asks another endpoint than the excluded ones, while one can answer", async () => {
    const answer = (b: unknown) => (single(b).method === "eth_getBlockByNumber" ? ok(HEADER) : ok([]));
    const { pool } = harness({ "https://a": answer, "https://b": answer });
    for (let i = 0; i < 3; i++) expect((await pool.getLogs({ address: [] }, 1, 1, { exclude: ["a"] })).endpoint).toBe("b");
    // Everyone excluded: someone still has to answer.
    expect(["a", "b"]).toContain((await pool.getLogs({ address: [] }, 1, 1, { exclude: ["a", "b"] })).endpoint);
  });
});
