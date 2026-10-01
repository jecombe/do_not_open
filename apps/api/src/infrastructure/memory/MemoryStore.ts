import type { ActivityQuery, DuelQuery, EntangleProposal, Mint, ProjectionTx, Stats, Store, StoredEvent, Transfer } from "../../application/ports/store";
import type { Box } from "../../domain/box";
import { isOpen, type Duel } from "../../domain/duel";
import { actorsOf, byChainOrder, tokensOf } from "../../domain/events";
import type { Request } from "../../domain/request";
import type { Address } from "../../domain/types";
import type { User } from "../../domain/user";

interface State {
  cursor: number | null;
  finalized: number | null;
  events: Map<string, StoredEvent>;
  ranges: { from: number; to: number; servedBy: string[] }[];
  boxes: Map<number, Box>;
  duels: Map<number, Duel>;
  requests: Map<number, Request>;
  users: Map<Address, User>;
  proposals: Map<string, EntangleProposal>;
  mints: Map<number, Mint>;
  milestones: Map<number, { index: number; sold: number; block: number }>;
  transfers: Map<string, Transfer>;
  nonces: Map<Address, { nonce: string; expiresAt: number }>;
}

const emptyState = (): State => ({
  cursor: null,
  finalized: null,
  events: new Map(),
  ranges: [],
  boxes: new Map(),
  duels: new Map(),
  requests: new Map(),
  users: new Map(),
  proposals: new Map(),
  mints: new Map(),
  milestones: new Map(),
  transfers: new Map(),
  nonces: new Map(),
});

/** Copies every map, so a failed transaction can be thrown away. Values are never mutated in place. */
const fork = (s: State): State =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v instanceof Map ? new Map(v) : Array.isArray(v) ? [...v] : v])) as unknown as State;

const ref = (txHash: string, logIndex: number) => `${txHash}:${logIndex}`;
const clone = <T>(v: T): T => structuredClone(v);

/** The whole index in memory: for tests, and for running the API without Postgres. */
export class MemoryStore implements Store {
  private s = emptyState();

  async transaction<T>(run: (tx: ProjectionTx) => Promise<T>): Promise<T> {
    const draft = fork(this.s);
    const result = await run(this.txOn(draft));
    this.s = draft;
    return result;
  }

  private txOn(s: State): ProjectionTx {
    return {
      insertEvent: async (e, enrichment) => {
        const k = ref(e.txHash, e.logIndex);
        if (s.events.has(k)) return false;
        s.events.set(k, clone({ event: e, enrichment }));
        return true;
      },
      deleteEvents: async (keys) => keys.filter((k) => s.events.delete(k)).length,
      eventsBetween: async (from, to) =>
        [...s.events.entries()].filter(([, { event: e }]) => e.block >= from && e.block <= to).map(([key, { event: e }]) => ({ key, blockHash: e.blockHash })),
      storedEvents: async (after, limit) =>
        [...s.events.values()]
          .filter(({ event: e }) => !after || e.block > after.block || (e.block === after.block && e.logIndex > after.logIndex))
          .sort((a, b) => byChainOrder(a.event, b.event))
          .slice(0, limit)
          .map(clone),
      resetReadModels: async () => {
        for (const m of [s.boxes, s.duels, s.requests, s.proposals, s.mints, s.milestones, s.transfers] as Map<unknown, unknown>[]) m.clear();
        // Sign-ins stay; on-chain activity is counted again by the replay.
        for (const [a, u] of s.users) {
          if (u.registeredAt === null) s.users.delete(a);
          else s.users.set(a, { ...u, firstBlock: null, lastBlock: null, firstSeenAt: null, lastSeenAt: null, actions: 0 });
        }
      },
      setCursor: async (block) => void (s.cursor = block),
      setFinalizedCursor: async (block) => void (s.finalized = block),
      saveRange: async (from, to, servedBy) => void (to >= from && servedBy.length && s.ranges.push({ from, to, servedBy: [...servedBy] })),
      pruneRanges: async (upTo) => void (s.ranges = s.ranges.filter((r) => r.to > upTo)),
      box: async (id) => clone(s.boxes.get(id) ?? null),
      saveBox: async (b) => void s.boxes.set(b.tokenId, clone(b)),
      duel: async (id) => clone(s.duels.get(id) ?? null),
      saveDuel: async (d) => void s.duels.set(d.duelId, clone(d)),
      request: async (id) => clone(s.requests.get(id) ?? null),
      saveRequest: async (r) => void s.requests.set(r.requestId, clone(r)),
      user: async (a) => clone(s.users.get(a) ?? null),
      saveUser: async (u) => void s.users.set(u.address, clone(u)),
      saveProposal: async (p) => void s.proposals.set(`${p.tokenA}:${p.tokenB}`, clone(p)),
      deleteProposal: async (a, b) => void s.proposals.delete(`${a}:${b}`),
      saveMint: async (m) => void s.mints.set(m.firstTokenId, clone(m)),
      saveMilestone: async (m) => void s.milestones.set(m.index, clone(m)),
      saveTransfer: async (t) => void s.transfers.set(ref(t.txHash, t.logIndex), clone(t)),
    };
  }

  async cursor() {
    return this.s.cursor;
  }

  async finalizedCursor() {
    return this.s.finalized;
  }

  async servedBy(from: number, to: number) {
    return [...new Set(this.s.ranges.filter((r) => r.from <= to && r.to >= from).flatMap((r) => r.servedBy))];
  }

  async knownDuelIds() {
    return [...this.s.duels.keys()].sort((a, b) => a - b);
  }

  async knownRequestIds() {
    return [...this.s.requests.keys()].sort((a, b) => a - b);
  }

  async allPendingRequests() {
    return [...this.s.requests.values()].filter((r) => r.status === "pending").sort((a, b) => a.requestId - b.requestId).map(clone);
  }

  async box(tokenId: number) {
    return clone(this.s.boxes.get(tokenId) ?? null);
  }

  async boxes(from: number, to: number) {
    return [...this.s.boxes.values()].filter((b) => b.tokenId >= from && b.tokenId < to).sort((a, b) => a.tokenId - b.tokenId).map(clone);
  }

  async tokenCount() {
    return Math.max(0, ...[...this.s.mints.values()].map((m) => m.firstTokenId + m.count));
  }

  async milestonesReached() {
    return this.s.milestones.size;
  }

  async openedBoxes() {
    return [...this.s.boxes.values()].filter((b) => b.status === "revealed").sort((a, b) => a.tokenId - b.tokenId).map(clone);
  }

  async duel(duelId: number) {
    return clone(this.s.duels.get(duelId) ?? null);
  }

  async duels(q: DuelQuery) {
    const tokens = new Set(q.tokenIds ?? []);
    return [...this.s.duels.values()]
      .filter((d) => (!q.account && !tokens.size) || (q.account && (d.challenger === q.account || d.accepter === q.account)) || tokens.has(d.tokenA) || tokens.has(d.tokenB))
      .filter((d) => !q.statuses || q.statuses.includes(d.status))
      .sort((a, b) => b.duelId - a.duelId)
      .slice(0, q.limit)
      .map(clone);
  }

  async proposal(tokenA: number, tokenB: number) {
    return clone(this.s.proposals.get(`${tokenA}:${tokenB}`) ?? null);
  }

  async pendingRequests(requester: Address) {
    return [...this.s.requests.values()].filter((r) => r.requester === requester && r.status === "pending").sort((a, b) => a.requestId - b.requestId).map(clone);
  }

  async transfers(account: Address, afterBlock: number, limit: number) {
    return [...this.s.transfers.values()]
      .filter((t) => t.block > afterBlock && (t.from === account || t.to === account))
      .sort(byChainOrder)
      .slice(0, limit)
      .map(clone);
  }

  async user(address: Address) {
    return clone(this.s.users.get(address) ?? null);
  }

  async activity(q: ActivityQuery) {
    return [...this.s.events.values()]
      .map((s) => s.event)
      .filter((e) => q.beforeBlock === undefined || e.block < q.beforeBlock)
      .filter((e) => q.tokenId === undefined || tokensOf(e).includes(q.tokenId))
      .filter((e) => q.account === undefined || actorsOf(e).includes(q.account))
      .sort((a, b) => byChainOrder(b, a))
      .slice(0, q.limit)
      .map(clone);
  }

  async stats(): Promise<Stats> {
    const users = [...this.s.users.values()];
    const duels = [...this.s.duels.values()];
    return {
      users: users.length,
      registered: users.filter((u) => u.registeredAt !== null).length,
      minted: await this.tokenCount(),
      opened: (await this.openedBoxes()).length,
      duels: duels.length,
      openDuels: duels.filter(isOpen).length,
      events: this.s.events.size,
    };
  }

  async saveUser(user: User) {
    this.s.users.set(user.address, clone(user));
  }

  async saveNonce(address: Address, nonce: string, expiresAt: number) {
    this.s.nonces.set(address, { nonce, expiresAt });
  }

  async takeNonce(address: Address) {
    const n = this.s.nonces.get(address) ?? null;
    this.s.nonces.delete(address);
    return n;
  }
}
