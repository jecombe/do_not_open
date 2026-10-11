import type { Clock } from "./auth";
import type { Logger } from "./ports/logger";
import {
  BATCH_CANCELED,
  BATCH_FINALIZED,
  SAVINGS_SIDES,
  WINDOW_CANCELED,
  WINDOW_JOINED,
  WINDOW_OPEN,
  WINDOW_SETTLED,
  type SavingsChain,
  type SavingsSide,
} from "./ports/savings";

export interface SavingsKeeperOptions {
  /**
   * Seconds before a batch can be dispatched at which the open window joins it: late, when the
   * batch holds the most other participants, with room for a slow transaction. A batcher whose
   * batches have no minimum age (a test chain) is joined at once.
   */
  joinMarginS: number;
  /** Pockets settled per transaction: each costs about 2.1M HCU of a 20M budget. */
  pocketsPerTx?: number;
  /** `settlePockets` transactions one tick sends at most; the rest wait for the next. */
  txPerTick?: number;
}

/** What the keeper did since it started: the monitoring's counters. */
export interface SavingsKeeperCounts {
  joins: number;
  settles: number;
  pocketSettlements: number;
  failures: number;
}

export interface SavingsTick {
  joined: SavingsSide[];
  settled: number[];
  pocketsSettled: number;
  failed: number;
}

/**
 * The savings' keeper. `PocketSavings` leaves three things to anyone: joining the open window to
 * Zama's current batch, claiming the batch once the batcher settled it, and crediting each
 * pocket its part. The indexer does them, from the relayer's wallet, one tick at a time:
 *
 *  1. For each side, the open window joins the current batch when it has pockets, the batch is
 *     not the one it joined last, the batcher is not paused, and the batch is within
 *     `joinMarginS` of being old enough to dispatch: the window joins late, as one participant
 *     among the most, so the batch's total says the least about it.
 *  2. A joined window whose batch is finalized or canceled is settled.
 *  3. A settled or canceled window with pockets left gets them settled, a few per transaction,
 *     decoys included: a pocket settled alone would be the one that moved.
 *
 * Windows are walked from a cursor kept in memory (0 at boot: a scan of what is already done
 * is a few reads), moved past those fully settled. A failing call is logged and counted, never
 * stops the others, and is tried again next tick.
 */
export class SavingsKeeper {
  readonly counts: SavingsKeeperCounts = { joins: 0, settles: 0, pocketSettlements: 0, failures: 0 };
  /** Whether the last tick met no failure; null before the first. */
  lastTickOk: boolean | null = null;
  private cursor = 0;
  /** Fully settled windows past the cursor, so they are not read again. */
  private readonly done = new Set<number>();
  private readonly pocketsPerTx: number;
  private readonly txPerTick: number;

  constructor(
    private readonly chain: SavingsChain,
    private readonly clock: Clock,
    private readonly opts: SavingsKeeperOptions,
    private readonly log: Logger,
  ) {
    this.pocketsPerTx = opts.pocketsPerTx ?? 5;
    this.txPerTick = opts.txPerTick ?? 2;
  }

  async tick(): Promise<SavingsTick> {
    const tick: SavingsTick = { joined: [], settled: [], pocketsSettled: 0, failed: 0 };
    for (const side of SAVINGS_SIDES) await this.attempt(tick, { step: "join", side }, () => this.joinIfDue(side, tick));
    const count = await this.attempt(tick, { step: "windows" }, () => this.chain.windowCount());
    if (count !== undefined) {
      const budget = { tx: this.txPerTick };
      for (let windowId = this.cursor; windowId < count; windowId++) {
        if (this.done.has(windowId)) continue;
        await this.attempt(tick, { step: "window", windowId }, () => this.advance(windowId, budget, tick));
      }
      while (this.done.delete(this.cursor)) this.cursor++;
    }
    this.lastTickOk = tick.failed === 0;
    if (tick.joined.length || tick.settled.length || tick.pocketsSettled) this.log.info({ ...tick }, "savings keeper tick");
    return tick;
  }

  /** The side's open window joins the current batch when it is time. */
  private async joinIfDue(side: SavingsSide, tick: SavingsTick): Promise<void> {
    const window = await this.chain.windowInfo(await this.chain.openWindow(side));
    if (window.pocketCount === 0) return;
    const batch = await this.chain.currentBatch(side);
    if (batch.paused) return;
    if ((await this.chain.lastBatch(side)) === batch.id) return;
    const dueAt = batch.createdAt + Math.max(0, batch.minBatchAge - this.opts.joinMarginS);
    if (batch.minBatchAge > 0 && this.clock.now() < dueAt) return;
    const hash = await this.chain.join(side);
    this.counts.joins++;
    tick.joined.push(side);
    this.log.info({ side, batchId: batch.id, hash }, "savings window joined its batch");
  }

  /** Moves one window on, as far as its batch and the tick's budget of pocket settlements allow. */
  private async advance(windowId: number, budget: { tx: number }, tick: SavingsTick): Promise<void> {
    const w = await this.chain.windowInfo(windowId);
    if (w.state === WINDOW_OPEN) return;
    if (w.state === WINDOW_JOINED) {
      const state = await this.chain.batchState(w.side, w.batchId);
      if (state !== BATCH_FINALIZED && state !== BATCH_CANCELED) return;
      const hash = await this.chain.settle(windowId);
      this.counts.settles++;
      tick.settled.push(windowId);
      this.log.info({ windowId, batchId: w.batchId, batchState: state, hash }, "savings window settled");
      return;
    }
    if (w.state !== WINDOW_SETTLED && w.state !== WINDOW_CANCELED) return;
    if (w.left === 0) {
      this.done.add(windowId);
      return;
    }
    if (budget.tx === 0) return;
    const ids = await this.chain.unsettledPockets(windowId);
    let sent = 0;
    while (sent < ids.length && budget.tx > 0) {
      const part = ids.slice(sent, sent + this.pocketsPerTx);
      budget.tx--;
      const hash = await this.chain.settlePockets(windowId, part);
      sent += part.length;
      this.counts.pocketSettlements += part.length;
      tick.pocketsSettled += part.length;
      this.log.info({ windowId, pockets: part, hash }, "savings pockets settled");
    }
    if (sent === ids.length) this.done.add(windowId);
  }

  private async attempt<T>(tick: SavingsTick, what: object, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      tick.failed++;
      this.counts.failures++;
      this.log.error({ ...what, error: (error as Error).message }, "savings keeper call failed");
      return undefined;
    }
  }
}
