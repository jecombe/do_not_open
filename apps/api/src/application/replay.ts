import { snapshotsFrom } from "../domain/events";
import type { ProjectionTx } from "./ports/store";
import { project } from "./projector";

const PAGE = 2000;

/**
 * Rebuilds every read model from the events table alone, in chain order, with what each event
 * was enriched with when indexed. No RPC call. Used after events were added late or removed,
 * when folding them in place could not give the same result as folding them in order.
 */
export async function replayAll(tx: ProjectionTx): Promise<number> {
  await tx.resetReadModels();
  let after: { block: number; logIndex: number } | null = null;
  let n = 0;
  for (;;) {
    const page = await tx.storedEvents(after, PAGE);
    for (const { event, enrichment } of page) await project(event, snapshotsFrom(event, enrichment), tx);
    n += page.length;
    if (page.length < PAGE) return n;
    const last = page[page.length - 1]!.event;
    after = { block: last.block, logIndex: last.logIndex };
  }
}
