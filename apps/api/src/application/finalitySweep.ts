import { byChainOrder, enrichmentOf, eventKey } from "../domain/events";
import type { ChainSource } from "./ports/chain";
import type { Logger } from "./ports/logger";
import type { Store } from "./ports/store";
import { readFully } from "./readFully";
import { replayAll } from "./replay";

export interface SweepOptions {
  startBlock: number;
  /** Most blocks one sweep checks. */
  maxBlocks: number;
}

export interface SweepResult {
  from: number;
  to: number;
  /** Events the first read missed, added now. */
  recovered: number;
  /** Events recorded from blocks a reorg dropped, removed now. */
  orphaned: number;
  /** Endpoints that answered this time; those that answered the first time were avoided. */
  servedBy: string[];
}

/**
 * The second look. Once blocks are final, they are read again, from other endpoints than the
 * ones that served them the first time, and compared with what was recorded: a missing event
 * is added, one from a block that is no longer in the chain is removed. If anything changed,
 * the read models are rebuilt from the events, so they are exactly what an index built in one
 * go would hold. All in one transaction.
 */
export class FinalitySweep {
  constructor(
    private readonly chain: ChainSource,
    private readonly store: Store,
    private readonly opts: SweepOptions,
    private readonly log: Logger,
  ) {}

  async run(): Promise<SweepResult | null> {
    const [finalized, swept, indexed] = await Promise.all([this.chain.finalized(), this.store.finalizedCursor(), this.store.cursor()]);
    if (indexed === null) return null;
    const from = Math.max(this.opts.startBlock, (swept ?? this.opts.startBlock - 1) + 1);
    const to = Math.min(finalized, indexed, from + this.opts.maxBlocks - 1);
    if (to < from) return null;

    const firstTime = await this.store.servedBy(from, to);
    const fresh = await readFully(this.chain, from, to, { exclude: firstTime });
    const freshByKey = new Map(fresh.events.map((e) => [eventKey(e), e]));

    const result = await this.store.transaction(async (tx) => {
      const recorded = await tx.eventsBetween(from, to);
      const recordedKeys = new Map(recorded.map((r) => [r.key, r.blockHash]));
      // Recorded, but not in the chain as it is final, or from another block with that position: dropped by a reorg.
      const orphans = recorded.filter((r) => {
        const now = freshByKey.get(r.key);
        return !now || (r.blockHash !== null && now.blockHash !== null && now.blockHash !== r.blockHash);
      });
      await tx.deleteEvents(orphans.map((o) => o.key));
      const orphanKeys = new Set(orphans.map((o) => o.key));
      let recovered = 0;
      for (const e of [...fresh.events].sort(byChainOrder)) {
        const key = eventKey(e);
        if (recordedKeys.has(key) && !orphanKeys.has(key)) continue;
        if (await tx.insertEvent(e, enrichmentOf(e, fresh.snapshots))) recovered++;
      }
      if (recovered || orphans.length) await replayAll(tx);
      await tx.setFinalizedCursor(to);
      await tx.pruneRanges(to);
      return { from, to, recovered, orphaned: orphans.length, servedBy: fresh.servedBy };
    });

    if (result.recovered || result.orphaned) this.log.warn({ ...result }, "finality sweep repaired the index");
    return result;
  }
}
