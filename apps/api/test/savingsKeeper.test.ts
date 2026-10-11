import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/application/ports/logger";
import {
  BATCH_CANCELED,
  BATCH_FINALIZED,
  WINDOW_CANCELED,
  WINDOW_JOINED,
  WINDOW_OPEN,
  WINDOW_SETTLED,
  type SavingsBatch,
  type SavingsChain,
  type SavingsSide,
  type SavingsWindow,
} from "../src/application/ports/savings";
import { SavingsKeeper } from "../src/application/savingsKeeper";

const BATCH_PENDING = 0;
const HOUR = 3480;

interface FakeWindow extends SavingsWindow {
  pockets: number[];
  unsettled: number[];
}

/** PocketSavings and two batchers in memory, with the rules the keeper depends on. */
class FakeChain implements SavingsChain {
  windows: FakeWindow[] = [];
  open: Record<SavingsSide, number> = { 0: 0, 1: 1 };
  last: Record<SavingsSide, number> = { 0: 0, 1: 0 };
  batch: Record<SavingsSide, SavingsBatch> = { 0: { id: 1, createdAt: 1000, minBatchAge: HOUR, paused: false }, 1: { id: 1, createdAt: 1000, minBatchAge: HOUR, paused: false } };
  batchStates = new Map<string, number>();
  calls: string[] = [];
  /** Calls that throw once, by name. */
  failing = new Set<string>();

  constructor() {
    this.openWindowFor(0);
    this.openWindowFor(1);
  }

  private openWindowFor(side: SavingsSide) {
    this.open[side] = this.windows.length;
    this.windows.push({ side, state: WINDOW_OPEN, batchId: 0, pocketCount: 0, left: 0, pockets: [], unsettled: [] });
  }

  /** A save of a set of pockets into the side's open window. */
  save(side: SavingsSide, set: number[]) {
    const w = this.windows[this.open[side]]!;
    for (const id of set) if (!w.pockets.includes(id)) w.pockets.push(id);
    w.pocketCount = w.pockets.length;
  }

  setBatchState(side: SavingsSide, batchId: number, state: number) {
    this.batchStates.set(`${side}:${batchId}`, state);
  }

  private maybeFail(name: string) {
    if (this.failing.delete(name)) throw new Error(`${name} failed`);
  }

  async windowCount() {
    return this.windows.length;
  }
  async openWindow(side: SavingsSide) {
    return this.open[side];
  }
  async lastBatch(side: SavingsSide) {
    return this.last[side];
  }
  async windowInfo(windowId: number) {
    this.maybeFail(`windowInfo:${windowId}`);
    const { side, state, batchId, pocketCount, left } = this.windows[windowId]!;
    return { side, state, batchId, pocketCount, left };
  }
  async unsettledPockets(windowId: number) {
    return [...this.windows[windowId]!.unsettled];
  }
  async currentBatch(side: SavingsSide) {
    return { ...this.batch[side] };
  }
  async batchState(side: SavingsSide, batchId: number) {
    return this.batchStates.get(`${side}:${batchId}`) ?? BATCH_PENDING;
  }

  async join(side: SavingsSide) {
    this.calls.push(`join:${side}`);
    this.maybeFail("join");
    const w = this.windows[this.open[side]]!;
    if (w.pockets.length === 0) throw new Error("EmptyWindow");
    if (this.last[side] === this.batch[side].id) throw new Error("BatchAlreadyJoined");
    this.last[side] = this.batch[side].id;
    w.batchId = this.batch[side].id;
    w.state = WINDOW_JOINED;
    this.openWindowFor(side);
    return "0xjoin";
  }
  async settle(windowId: number) {
    this.calls.push(`settle:${windowId}`);
    this.maybeFail("settle");
    const w = this.windows[windowId]!;
    if (w.state !== WINDOW_JOINED) throw new Error("WindowNotJoined");
    const state = await this.batchState(w.side, w.batchId);
    if (state === BATCH_FINALIZED) w.state = WINDOW_SETTLED;
    else if (state === BATCH_CANCELED) w.state = WINDOW_CANCELED;
    else throw new Error("BatchNotDone");
    w.left = w.pockets.length;
    w.unsettled = [...w.pockets];
    return "0xsettle";
  }
  async settlePockets(windowId: number, ids: number[]) {
    this.calls.push(`settlePockets:${windowId}:${ids.join(",")}`);
    this.maybeFail("settlePockets");
    const w = this.windows[windowId]!;
    if (w.state !== WINDOW_SETTLED && w.state !== WINDOW_CANCELED) throw new Error("WindowNotSettled");
    for (const id of ids) {
      if (!w.unsettled.includes(id)) throw new Error(`NotCommitted ${id}`);
      w.unsettled = w.unsettled.filter((p) => p !== id);
      w.left--;
    }
    return "0xpockets";
  }
}

const keeperOn = (chain: FakeChain, clock: { now: number }, opts: { joinMarginS?: number; txPerTick?: number } = {}) =>
  new SavingsKeeper(chain, { now: () => clock.now }, { joinMarginS: 600, ...opts }, silentLogger);

describe("SavingsKeeper", () => {
  it("joins the open window late in the batch, not before, and not when it is empty", async () => {
    const chain = new FakeChain();
    const clock = { now: 1000 };
    const keeper = keeperOn(chain, clock);
    // Nothing saved: nothing to join, however late.
    clock.now = 1000 + HOUR;
    await keeper.tick();
    expect(chain.calls).toEqual([]);

    chain.save(0, [3, 7, 9]);
    clock.now = 1000 + HOUR - 601;
    await keeper.tick();
    expect(chain.calls).toEqual([]);
    clock.now = 1000 + HOUR - 600;
    const tick = await keeper.tick();
    expect(chain.calls).toEqual(["join:0"]);
    expect(tick.joined).toEqual([0]);
    expect(chain.windows[0]!.state).toBe(WINDOW_JOINED);
    expect(keeper.counts.joins).toBe(1);
    expect(keeper.lastTickOk).toBe(true);
  });

  it("joins at once when the batcher has no minimum batch age, once per batch, and not while paused", async () => {
    const chain = new FakeChain();
    chain.batch[1] = { id: 4, createdAt: 5000, minBatchAge: 0, paused: false };
    const clock = { now: 5000 };
    const keeper = keeperOn(chain, clock);
    chain.save(1, [2]);
    await keeper.tick();
    expect(chain.calls).toEqual(["join:1"]);
    // The next unsave window has pockets too, but this batch already took a window of this side.
    chain.save(1, [5]);
    await keeper.tick();
    expect(chain.calls).toEqual(["join:1"]);
    // A new batch, but the batcher is paused.
    chain.batch[1] = { id: 5, createdAt: 5100, minBatchAge: 0, paused: true };
    await keeper.tick();
    expect(chain.calls).toEqual(["join:1"]);
    chain.batch[1].paused = false;
    await keeper.tick();
    expect(chain.calls).toEqual(["join:1", "join:1"]);
    expect(chain.last[1]).toBe(5);
  });

  it("settles a finalized window and a canceled one, then their pockets five at a time, decoys included", async () => {
    const chain = new FakeChain();
    chain.batch[0].minBatchAge = 0;
    chain.batch[1].minBatchAge = 0;
    const clock = { now: 1000 };
    const keeper = keeperOn(chain, clock, { txPerTick: 2 });
    chain.save(0, [1, 2, 3, 4, 5]);
    chain.save(0, [6, 7]);
    chain.save(1, [8, 9, 10]);
    await keeper.tick();
    expect(chain.calls).toEqual(["join:0", "join:1"]);
    chain.calls = [];

    // Pending batches: nothing to settle yet.
    await keeper.tick();
    expect(chain.calls).toEqual([]);

    chain.setBatchState(0, 1, BATCH_FINALIZED);
    chain.setBatchState(1, 1, BATCH_CANCELED);
    let tick = await keeper.tick();
    expect(chain.calls).toEqual(["settle:0", "settle:1"]);
    expect(tick.settled).toEqual([0, 1]);
    expect(chain.windows[0]!.state).toBe(WINDOW_SETTLED);
    expect(chain.windows[1]!.state).toBe(WINDOW_CANCELED);
    chain.calls = [];

    // Two transactions a tick: the save window's seven pockets take 5 + 2, the unsave window waits.
    tick = await keeper.tick();
    expect(chain.calls).toEqual(["settlePockets:0:1,2,3,4,5", "settlePockets:0:6,7"]);
    expect(tick.pocketsSettled).toBe(7);
    chain.calls = [];
    tick = await keeper.tick();
    expect(chain.calls).toEqual(["settlePockets:1:8,9,10"]);
    expect(chain.windows.every((w) => w.left === 0 || w.state === WINDOW_OPEN)).toBe(true);
    chain.calls = [];

    // Everything settled: nothing more is sent, and the done windows are not read again.
    await keeper.tick();
    expect(chain.calls).toEqual([]);
    expect(keeper.counts).toEqual({ joins: 2, settles: 2, pocketSettlements: 10, failures: 0 });
  });

  it("skips the pockets already settled by someone else and picks up where it left", async () => {
    const chain = new FakeChain();
    chain.batch[0].minBatchAge = 0;
    const clock = { now: 1000 };
    const keeper = keeperOn(chain, clock, { txPerTick: 1 });
    chain.save(0, [1, 2, 3, 4, 5, 6, 7, 8]);
    await keeper.tick();
    chain.setBatchState(0, 1, BATCH_FINALIZED);
    await keeper.tick();
    // Another keeper settled 2 and 3 in the meantime.
    await chain.settlePockets(0, [2, 3]);
    chain.calls = [];
    await keeper.tick();
    expect(chain.calls).toEqual(["settlePockets:0:1,4,5,6,7"]);
    chain.calls = [];
    await keeper.tick();
    expect(chain.calls).toEqual(["settlePockets:0:8"]);
    expect(chain.windows[0]!.left).toBe(0);
    // A fresh keeper (a restart) scans from 0 and finds nothing to do.
    const again = keeperOn(chain, clock);
    chain.calls = [];
    await again.tick();
    expect(chain.calls).toEqual([]);
  });

  it("keeps going past a failing call and tries it again next tick", async () => {
    const chain = new FakeChain();
    chain.batch[0].minBatchAge = 0;
    chain.batch[1].minBatchAge = 0;
    const clock = { now: 1000 };
    const keeper = keeperOn(chain, clock);
    chain.save(0, [1]);
    chain.save(1, [2]);
    chain.failing.add("join");
    let tick = await keeper.tick();
    // The save side's join threw; the unsave side's went through.
    expect(chain.calls).toEqual(["join:0", "join:1"]);
    expect(tick.joined).toEqual([1]);
    expect(tick.failed).toBe(1);
    expect(keeper.lastTickOk).toBe(false);
    expect(keeper.counts.failures).toBe(1);

    tick = await keeper.tick();
    expect(tick.joined).toEqual([0]);
    expect(keeper.lastTickOk).toBe(true);

    chain.setBatchState(0, 1, BATCH_FINALIZED);
    chain.setBatchState(1, 1, BATCH_FINALIZED);
    chain.failing.add("windowInfo:0");
    chain.calls = [];
    tick = await keeper.tick();
    // Window 0 could not be read; window 1 was settled all the same.
    expect(chain.calls).toEqual(["settle:1"]);
    expect(tick.failed).toBe(1);
    chain.calls = [];
    await keeper.tick();
    expect(chain.calls).toEqual(["settle:0", "settlePockets:1:2"]);
    chain.calls = [];
    await keeper.tick();
    expect(chain.calls).toEqual(["settlePockets:0:1"]);
  });
});
