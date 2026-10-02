import type { Box } from "../domain/box";
import { OPEN_DUEL } from "../domain/duel";
import { byChainOrder, enrichmentOf } from "../domain/events";
import type { BoxView, ChainSource, ChainState, Counters } from "./ports/chain";
import type { Logger } from "./ports/logger";
import type { Store } from "./ports/store";
import { replayAll } from "./replay";

export interface ReconcileOptions {
  startBlock: number;
  /** Boxes compared with the contract per run, in turn: the whole collection over many runs. */
  boxesPerRun: number;
}

export interface Drift {
  kind: "token" | "duel" | "request" | "box" | "milestones";
  id: number;
  /** What differed, for the logs. */
  detail: string;
}

export interface ReconcileResult {
  /** The block both sides were read at. */
  block: number;
  checked: { duels: number; requests: number; boxes: number };
  drift: Drift[];
  /** Events fetched for the drifting entities and added. */
  recovered: number;
  /** Still different after the repair: needs a look. */
  unresolved: Drift[];
}

/**
 * Compares the index with the contract, both as of the last indexed block: the counters, every
 * open duel, every pending request, and a slice of boxes in turn. Where they differ, the
 * events of that entity are fetched again, whatever block they are in, added if missing, and
 * the read models rebuilt. Whatever still differs is reported.
 */
export class Reconciler {
  private nextBox = 0;

  constructor(
    private readonly chain: ChainSource,
    private readonly state: ChainState,
    private readonly store: Store,
    private readonly opts: ReconcileOptions,
    private readonly log: Logger,
  ) {}

  async run(): Promise<ReconcileResult | null> {
    const block = await this.store.cursor();
    if (block === null) return null;
    const drift = await this.compare(block);
    let recovered = 0;
    let unresolved: Drift[] = [];
    if (drift.drift.length) {
      recovered = await this.repair(drift.drift, block);
      // Compared again, the same way: what is left is not explained by a missed event.
      const again = await this.compare(block, drift.boxIds);
      unresolved = again.drift;
      const level = unresolved.length ? "error" : "warn";
      this.log[level]({ block, drift: drift.drift, recovered, unresolved }, unresolved.length ? "index drifts from the contract" : "reconciliation repaired the index");
    }
    return { block, checked: drift.checked, drift: drift.drift, recovered, unresolved };
  }

  private async compare(block: number, onlyBoxes?: number[]) {
    const [counters, duelIds, requestIds, pending, tokenCount, milestones] = await Promise.all([
      this.state.counters(block),
      this.store.knownDuelIds(),
      this.store.knownRequestIds(),
      this.store.allPendingRequests(),
      this.store.tokenCount(),
      this.store.milestonesReached(),
    ]);
    const drift: Drift[] = [...this.countDrift(counters, tokenCount, milestones, duelIds, requestIds)];

    const open = await this.store.duels({ statuses: [...OPEN_DUEL], limit: 10_000 });
    const [duelViews, requestViews] = await Promise.all([
      this.state.duelViews(open.map((d) => d.duelId), block),
      this.state.requestViews(pending.map((r) => r.requestId), block),
    ]);
    for (const d of open) {
      const v = duelViews.get(d.duelId);
      if (v?.status && v.status !== d.status) drift.push({ kind: "duel", id: d.duelId, detail: `index ${d.status}, contract ${v.status}` });
    }
    for (const r of pending) {
      const v = requestViews.get(r.requestId);
      if (v?.status && v.status !== "pending") drift.push({ kind: "request", id: r.requestId, detail: `index pending, contract ${v.status}` });
    }

    const boxIds = onlyBoxes ?? this.boxSlice(Math.min(tokenCount, counters.tokenCount));
    const views = await this.state.boxViews(boxIds, block);
    const indexed = new Map((await Promise.all(boxIds.map((id) => this.store.box(id)))).flatMap((b) => (b ? [[b.tokenId, b] as const] : [])));
    for (const v of views) {
      const why = boxDiff(indexed.get(v.tokenId) ?? null, v);
      if (why) drift.push({ kind: "box", id: v.tokenId, detail: why });
    }
    return { drift, boxIds, checked: { duels: open.length, requests: pending.length, boxes: views.length } };
  }

  private *countDrift(c: Counters, tokenCount: number, milestones: number, duelIds: number[], requestIds: number[]): Generator<Drift> {
    // Ids the contract handed out and the index does not have.
    const missing = (count: number, known: number[]) => {
      const have = new Set(known);
      return Array.from({ length: count }, (_, i) => i).filter((i) => !have.has(i));
    };
    for (let id = tokenCount; id < c.tokenCount; id++) yield { kind: "token", id, detail: "minted on the contract, not in the index" };
    for (const id of missing(c.duelCount, duelIds)) yield { kind: "duel", id, detail: "missing from the index" };
    for (const id of missing(c.requestCount, requestIds)) yield { kind: "request", id, detail: "missing from the index" };
    if (milestones !== c.milestonesReached) yield { kind: "milestones", id: c.milestonesReached, detail: `index ${milestones}, contract ${c.milestonesReached}` };
  }

  /** The next slice of boxes, wrapping around: every box is checked once per `count / boxesPerRun` runs. */
  private boxSlice(count: number): number[] {
    if (count === 0) return [];
    const n = Math.min(this.opts.boxesPerRun, count);
    const start = this.nextBox % count;
    this.nextBox = start + n;
    return Array.from({ length: n }, (_, i) => (start + i) % count);
  }

  /** Fetches the drifting entities' events from the deployment on, adds the missing ones, and replays. */
  private async repair(drift: Drift[], block: number): Promise<number> {
    const tokenIds = drift.filter((d) => d.kind === "token" || d.kind === "box").map((d) => d.id);
    const duelIds = drift.filter((d) => d.kind === "duel").map((d) => d.id);
    const requestIds = drift.filter((d) => d.kind === "request").map((d) => d.id);
    const milestones = drift.some((d) => d.kind === "milestones");
    // A milestone has no entity to look up by: its events are few, take them all.
    const found = await this.chain.eventsOf({ tokenIds, duelIds, requestIds, ...(milestones ? { milestones: true } : {}) }, this.opts.startBlock, block);
    return this.store.transaction(async (tx) => {
      let added = 0;
      for (const e of [...found.events].sort(byChainOrder)) {
        if (e.block > block) continue;
        if (await tx.insertEvent(e, enrichmentOf(e, found.snapshots))) added++;
      }
      if (added) await replayAll(tx);
      return added;
    });
  }
}

/** Why the index and the contract disagree about a box, or null if they agree. */
function boxDiff(b: Box | null, v: BoxView): string | null {
  if (!b) return "missing from the index";
  if (b.status !== v.status) return `status: index ${b.status}, contract ${v.status}`;
  if (b.aliveCheck !== v.aliveCheck) return `alive check: index ${b.aliveCheck}, contract ${v.aliveCheck}`;
  if (b.wins !== v.wins) return `wins: index ${b.wins}, contract ${v.wins}`;
  if (b.status === "sealed" && b.partner !== v.partner) return `partner: index ${b.partner}, contract ${v.partner}`;
  // By value: a database may hand the objects back with their keys in another order.
  const traits = (t: { traitIndex: number; roll: number }[]) => t.map((x) => `${x.traitIndex}:${x.roll}`).sort().join(",");
  if (traits(b.publicTraits) !== traits(v.publicTraits)) return "public traits differ";
  return null;
}

