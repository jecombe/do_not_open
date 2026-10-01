import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/application/ports/logger";
import type { SyncResult } from "../src/application/syncChain";
import { Batcher, TtlCache } from "../src/infrastructure/cache";
import { Indexer } from "../src/infrastructure/Indexer";

/**
 * Runs the indexer's loop on a fake clock: each sleep returns at once (or is cut short by a
 * nudge when `nudgeDuringPoll`), and the loop is stopped after `maxSleeps` sleeps.
 */
async function run(passes: (() => Promise<SyncResult | null>)[], maxSleeps: number, nudgeDuringPoll = false) {
  let clock = 0;
  const sleeps: number[] = [];
  let calls = 0;
  let nudged = false;
  const sync = { pass: vi.fn(async () => passes[Math.min(calls++, passes.length - 1)]!()) };
  const indexer: Indexer = new Indexer(
    sync,
    { pollMs: 12_000, minGapMs: 3_000, maxBackoffMs: 60_000 },
    silentLogger,
    (ms, onWake) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        onWake(resolve);
        if (sleeps.length >= maxSleeps) void indexer.stop();
        if (nudgeDuringPoll && !nudged && ms === 12_000) {
          // A transaction lands while the indexer waits: it wakes without the clock moving.
          nudged = true;
          queueMicrotask(() => indexer.nudge());
          return;
        }
        clock += ms;
        resolve();
      }),
    () => clock,
  );
  indexer.start();
  await vi.waitFor(() => expect(indexer.status().running).toBe(false));
  await indexer.stop();
  return { indexer, sync, sleeps };
}

const result = (to: number, target: number): SyncResult => ({ from: 0, to, applied: 0, target });

describe("Indexer", () => {
  it("passes back to back while behind, then once per poll", async () => {
    const { sync, sleeps } = await run([async () => result(10, 30), async () => result(30, 30), async () => null], 3);
    // Behind: only the minimum gap; caught up: a full poll.
    expect(sleeps).toEqual([3_000, 12_000, 12_000]);
    expect(sync.pass).toHaveBeenCalledTimes(3);
  });

  it("backs off after failures, and reports them", async () => {
    const { indexer, sleeps } = await run([async () => Promise.reject(new Error("all endpoints rest")), async () => Promise.reject(new Error("again")), async () => null], 2);
    expect(sleeps).toEqual([24_000, 48_000]);
    expect(indexer.status()).toMatchObject({ lastError: "again", failures: 2 });
  });

  it("wakes on a nudge, but keeps its minimum gap", async () => {
    const { sync, sleeps } = await run([async () => null], 3, true);
    expect(sleeps).toEqual([12_000, 3_000, 12_000]);
    expect(sync.pass).toHaveBeenCalledTimes(2);
  });
});

describe("TtlCache", () => {
  it("shares a read in flight and keeps it for its ttl", async () => {
    let now = 0;
    const cache = new TtlCache<string, number>(1000, () => now);
    const load = vi.fn(async () => 42);
    expect(await Promise.all([cache.get("k", load), cache.get("k", load)])).toEqual([42, 42]);
    expect(load).toHaveBeenCalledTimes(1);
    now = 1001;
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("forgets a failed read", async () => {
    const cache = new TtlCache<string, number>(1000);
    await expect(cache.get("k", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await cache.get("k", async () => 1)).toBe(1);
  });

  it("stays within its size", async () => {
    let now = 0;
    const cache = new TtlCache<number, number>(10, () => now, 2);
    for (let i = 0; i < 5; i++) await cache.get(i, async () => i);
    now = 5;
    const load = vi.fn(async () => 9);
    await cache.get(0, load);
    expect(load).toHaveBeenCalled();
  });
});

describe("Batcher", () => {
  it("loads keys asked together in one call, once each", async () => {
    const loadMany = vi.fn(async (keys: number[]) => keys.map((k) => k * 10));
    const b = new Batcher(loadMany, 5);
    expect(await Promise.all([b.load(1), b.load(2), b.load(1)])).toEqual([10, 20, 10]);
    expect(loadMany).toHaveBeenCalledExactlyOnceWith([1, 2]);
  });

  it("fails every caller of a failed batch", async () => {
    const b = new Batcher<number, number>(async () => Promise.reject(new Error("rpc down")), 1);
    await expect(Promise.all([b.load(1), b.load(2)])).rejects.toThrow("rpc down");
  });
});
