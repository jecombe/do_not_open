import type { ActivityQuery, DuelQuery, EntangleProposal, Mint, ProjectionTx, Stats, Store, Transfer } from "../../application/ports/store";
import type { Box } from "../../domain/box";
import { isOpen, type Duel } from "../../domain/duel";
import { actorsOf, byChainOrder, tokensOf, type ProtocolEvent } from "../../domain/events";
import type { Request } from "../../domain/request";
import type { Address } from "../../domain/types";
import type { User } from "../../domain/user";

interface State {
  cursor: number | null;
  events: Map<string, ProtocolEvent>;
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
  events: new Map(),
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
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v instanceof Map ? new Map(v) : v])) as unknown as State;

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
      insertEvent: async (e) => {
        const k = ref(e.txHash, e.logIndex);
        if (s.events.has(k)) return false;
        s.events.set(k, clone(e));
        return true;
      },
      setCursor: async (block) => void (s.cursor = block),
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
      .filter((d) => (q.account && d.challenger === q.account) || (q.account && d.accepter === q.account) || tokens.has(d.tokenA) || tokens.has(d.tokenB))
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
