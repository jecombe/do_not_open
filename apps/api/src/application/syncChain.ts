import { byChainOrder } from "../domain/events";
import type { ChainSource } from "./ports/chain";
import type { Logger } from "./ports/logger";
import type { Store } from "./ports/store";
import { project } from "./projector";

export interface SyncOptions {
  /** First block worth reading: the collection's deployment. */
  startBlock: number;
  /** Blocks left between the head and what is indexed, so a reorg or a lagging node rarely matters. */
  confirmations: number;
  /** Blocks already indexed that each pass reads again. A log a lagging node missed shows up
   *  then; one recorded already is skipped. */
  rescan: number;
  /** Most new blocks one pass covers, so a long catch-up commits as it goes. */
  maxBlocksPerPass: number;
}

export interface SyncResult {
  from: number;
  to: number;
  /** Events projected for the first time. */
  applied: number;
  /** The confirmed head at the time of the pass: the index is caught up when `to` reaches it. */
  target: number;
}

/**
 * One pass of the indexer: reads the confirmed blocks after the cursor (plus a few before it)
 * and projects their events, all in one transaction with the new cursor. A crash anywhere
 * leaves the index as it was before the pass.
 */
export class SyncChain {
  constructor(
    private readonly chain: ChainSource,
    private readonly store: Store,
    private readonly opts: SyncOptions,
    private readonly log: Logger,
  ) {}

  async pass(): Promise<SyncResult | null> {
    const target = (await this.chain.head()) - this.opts.confirmations;
    const cursor = (await this.store.cursor()) ?? this.opts.startBlock - 1;
    if (target <= cursor) return null;

    const from = Math.max(this.opts.startBlock, cursor + 1 - this.opts.rescan);
    const end = Math.min(target, cursor + this.opts.maxBlocksPerPass);
    // A source may cover fewer blocks than asked; keep reading until the pass gets past the cursor.
    const batch = await this.chain.read(from, end);
    while (batch.to <= cursor && batch.to < end) {
      const more = await this.chain.read(batch.to + 1, end);
      batch.events.push(...more.events);
      for (const key of ["duels", "requests", "contents", "weighIns"] as const) {
        for (const [k, v] of more.snapshots[key]) (batch.snapshots[key] as Map<number, unknown>).set(k, v);
      }
      batch.to = more.to;
    }
    const events = [...batch.events].sort(byChainOrder);

    const applied = await this.store.transaction(async (tx) => {
      let n = 0;
      for (const e of events) {
        if (!(await tx.insertEvent(e))) continue;
        await project(e, batch.snapshots, tx);
        n++;
      }
      // Never move back: a short read in the rescan window does not undo progress.
      await tx.setCursor(Math.max(cursor, batch.to));
      return n;
    });
    if (applied) this.log.info({ from, to: batch.to, applied }, "indexed");
    return { from, to: Math.max(cursor, batch.to), applied, target };
  }
}
