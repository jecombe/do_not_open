import { emptySnapshots } from "../domain/events";
import type { ChainBatch, ChainSource, ReadOptions } from "./ports/chain";

/** Reads `from..to` to the end, however few blocks each read covers. */
export async function readFully(chain: ChainSource, from: number, to: number, opts?: ReadOptions): Promise<ChainBatch> {
  const out: ChainBatch = { to: from - 1, events: [], snapshots: emptySnapshots(), servedBy: [] };
  while (out.to < to) {
    const b = await chain.read(out.to + 1, to, opts);
    merge(out, b);
  }
  return out;
}

/** Folds `b` into `into`: its events, snapshots and endpoints, and how far it reached. */
export function merge(into: ChainBatch, b: ChainBatch | Pick<ChainBatch, "events" | "snapshots">): void {
  into.events.push(...b.events);
  for (const key of ["duels", "requests", "contents", "weighIns"] as const) {
    for (const [k, v] of b.snapshots[key]) (into.snapshots[key] as Map<number, unknown>).set(k, v);
  }
  if ("to" in b) into.to = Math.max(into.to, b.to);
  if ("servedBy" in b) into.servedBy = [...new Set([...into.servedBy, ...b.servedBy])];
}
