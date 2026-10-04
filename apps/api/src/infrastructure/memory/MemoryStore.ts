import type { ActivityQuery, DuelQuery, EntangleProposal, Mint, ProjectionTx, Stats, Store, StoredEvent, Transfer } from "../../application/ports/store";
import type { Box } from "../../domain/box";
import { isOpen, type Duel } from "../../domain/duel";
import { actorsOf, byChainOrder, QUIET_EVENTS, tokensOf } from "../../domain/events";
import type { Charge, Meter, PublicDecryption } from "../../domain/relayer";
import type { Request } from "../../domain/request";
import type { Address } from "../../domain/types";
import type { User } from "../../domain/user";
import type { TermsAcceptance } from "../../application/terms";
import type { EventPosition, Post, PostStore, QueuedDraft } from "../../application/ports/herald";
import type { ArchiveStore } from "../../application/ports/archive";

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
  published: Map<string, { caller: Address; block: number }>;
  credits: Map<Address, number>;
  /** Free units used, by `account:day`. Kept across replays, like the credits spent. */
  freeUsed: Map<string, number>;
  spent: Map<Address, number>;
  /** Public decryptions sent to Zama, by key, and how many named each handle. Kept across replays. */
  publicDecryptions: Map<string, PublicDecryption>;
  publicUses: Map<string, number>;
  /** Signed release forms, by `address:version`. Kept across replays. */
  terms: Map<string, TermsAcceptance>;
  /** The herald's queues, by id, and where each network read up to. Kept across replays. */
  posts: Map<number, Post>;
  heraldCursors: Map<string, EventPosition>;
  /** Images stored on Arweave: permanent id by SHA-256. Kept across replays. */
  archived: Map<string, string>;
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
  published: new Map(),
  credits: new Map(),
  freeUsed: new Map(),
  spent: new Map(),
  publicDecryptions: new Map(),
  publicUses: new Map(),
  terms: new Map(),
  posts: new Map(),
  heraldCursors: new Map(),
  archived: new Map(),
});

/** Copies every map, so a failed transaction can be thrown away. Values are never mutated in place. */
const fork = (s: State): State =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v instanceof Map ? new Map(v) : Array.isArray(v) ? [...v] : v])) as unknown as State;

const ref = (txHash: string, logIndex: number) => `${txHash}:${logIndex}`;
const clone = <T>(v: T): T => structuredClone(v);

/** The whole index in memory: for tests, and for running the API without Postgres. */
export class MemoryStore implements Store, PostStore, ArchiveStore {
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
        for (const m of [s.boxes, s.duels, s.requests, s.proposals, s.mints, s.milestones, s.transfers, s.published, s.credits] as Map<unknown, unknown>[]) m.clear();
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
      savePublished: async (handles, caller, block) => {
        for (const h of handles) if (!s.published.has(h)) s.published.set(h, { caller, block });
      },
      addCredits: async (account, credits) => void s.credits.set(account, (s.credits.get(account) ?? 0) + credits),
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
      .filter((d) => (!q.account && !tokens.size) || (q.account && (d.challenger === q.account || d.accepter === q.account)) || tokens.has(d.tokenA) || (d.tokenB !== null && tokens.has(d.tokenB)))
      .filter((d) => !q.statuses || q.statuses.includes(d.status))
      .filter((d) => q.inTimeAt === undefined || d.status !== "open" || d.openUntil === null || d.openUntil >= q.inTimeAt)
      .sort((a, b) => b.duelId - a.duelId)
      .slice(0, q.limit)
      .map(clone);
  }

  async proposal(tokenA: number, tokenB: number) {
    return clone(this.s.proposals.get(`${tokenA}:${tokenB}`) ?? null);
  }

  async proposals(tokenIds: number[], limit: number) {
    const tokens = new Set(tokenIds);
    return [...this.s.proposals.values()]
      .filter((p) => tokens.has(p.tokenA) || tokens.has(p.tokenB))
      .sort((a, b) => b.block - a.block)
      .slice(0, limit)
      .map(clone);
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
      .filter((e) => !QUIET_EVENTS.includes(e.name))
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

  async publishedAmong(handles: string[]) {
    return handles.map((h) => h.toLowerCase()).filter((h) => this.s.published.has(h));
  }

  async creditsBought(account: Address) {
    return this.s.credits.get(account) ?? 0;
  }

  async meterOf(account: Address, day: string): Promise<Meter> {
    return this.meterNow(account, day);
  }

  private meterNow(account: Address, day: string): Meter {
    return { freeUsed: this.s.freeUsed.get(`${account}:${day}`) ?? 0, spent: this.s.spent.get(account) ?? 0, bought: this.s.credits.get(account) ?? 0 };
  }

  async meter(account: Address, day: string, apply: (m: Meter) => Charge | null) {
    // No await between the read and the write: no other call can come in between.
    const delta = apply(this.meterNow(account, day));
    if (delta) {
      const k = `${account}:${day}`;
      this.s.freeUsed.set(k, (this.s.freeUsed.get(k) ?? 0) + delta.free);
      this.s.spent.set(account, (this.s.spent.get(account) ?? 0) + delta.credits);
    }
    return delta;
  }

  async publicDecryption(key: string) {
    const d = this.s.publicDecryptions.get(key);
    return d ? clone(d) : null;
  }

  async publicDecryptionOfJob(jobId: string) {
    for (const d of this.s.publicDecryptions.values()) if (d.jobId === jobId) return clone(d);
    return null;
  }

  async savePublicDecryption(d: Omit<PublicDecryption, "result">, handles: string[]) {
    this.s.publicDecryptions.set(d.key, clone({ ...d, result: null }));
    for (const h of handles) this.s.publicUses.set(h, (this.s.publicUses.get(h) ?? 0) + 1);
  }

  async finishPublicDecryption(jobId: string, result: unknown) {
    for (const [k, d] of this.s.publicDecryptions) if (d.jobId === jobId) this.s.publicDecryptions.set(k, { ...d, result: clone(result) });
  }

  async dropPublicDecryption(jobId: string) {
    for (const [k, d] of this.s.publicDecryptions) if (d.jobId === jobId && d.result === null) this.s.publicDecryptions.delete(k);
  }

  async publicDecryptionsOf(handles: string[]) {
    return new Map(handles.filter((h) => this.s.publicUses.has(h)).map((h) => [h, this.s.publicUses.get(h)!]));
  }

  async saveTermsAcceptance(a: TermsAcceptance) {
    const key = `${a.address}:${a.version}`;
    const kept = this.s.terms.get(key);
    if (kept) return clone(kept);
    this.s.terms.set(key, clone(a));
    return null;
  }

  async termsAcceptances(address: Address) {
    return [...this.s.terms.values()].filter((a) => a.address === address).sort((a, b) => a.receivedAt - b.receivedAt).map(clone);
  }

  async takeNonce(address: Address) {
    const n = this.s.nonces.get(address) ?? null;
    this.s.nonces.delete(address);
    return n;
  }

  // --- the herald's queue

  async heraldCursor(network: string) {
    return clone(this.s.heraldCursors.get(network) ?? null);
  }

  async queuePosts(network: string, drafts: QueuedDraft[], cursor: EventPosition, now: number) {
    const keys = new Set(this.queue(network).map((p) => p.key));
    let added = 0;
    for (const d of drafts) {
      if (keys.has(d.key)) continue;
      keys.add(d.key);
      const id = this.s.posts.size + 1;
      this.s.posts.set(id, { id, network, key: d.key, kind: d.kind, text: d.text, status: d.skipped ? "skipped" : "queued", createdAt: now, postedAt: null, externalId: null, url: null, attempts: 0, error: d.skipped ?? null });
      if (!d.skipped) added++;
    }
    this.s.heraldCursors.set(network, { ...cursor });
    return added;
  }

  async nextQueuedPost(network: string) {
    return clone(this.queue(network).filter((p) => p.status === "queued").sort((a, b) => a.id - b.id)[0] ?? null);
  }

  async updatePost(id: number, patch: Partial<Post>) {
    const p = this.s.posts.get(id);
    if (p) this.s.posts.set(id, { ...p, ...patch });
  }

  async hasPost(network: string, key: string) {
    return this.queue(network).some((p) => p.key === key);
  }

  async postedSince(network: string, since: number) {
    return this.queue(network).filter((p) => p.status === "posted" && (p.postedAt ?? 0) >= since).length;
  }

  async lastPostedAt(network: string) {
    const times = this.queue(network).filter((p) => p.status === "posted").map((p) => p.postedAt ?? 0);
    return times.length ? Math.max(...times) : null;
  }

  async posts(limit: number, network?: string) {
    return (network ? this.queue(network) : [...this.s.posts.values()]).sort((a, b) => b.id - a.id).slice(0, limit).map(clone);
  }

  async postCounts() {
    const counts = new Map<string, { network: string; status: Post["status"]; count: number }>();
    for (const p of this.s.posts.values()) {
      const key = `${p.network}:${p.status}`;
      const c = counts.get(key) ?? { network: p.network, status: p.status, count: 0 };
      counts.set(key, { ...c, count: c.count + 1 });
    }
    return [...counts.values()];
  }

  private queue(network: string): Post[] {
    return [...this.s.posts.values()].filter((p) => p.network === network);
  }

  async archivedImages(hashes: string[]) {
    const found = new Map<string, string>();
    for (const h of hashes) {
      const id = this.s.archived.get(h);
      if (id) found.set(h, id);
    }
    return found;
  }

  async saveArchivedImage(hash: string, id: string, _archivedAt: number) {
    if (!this.s.archived.has(hash)) this.s.archived.set(hash, id);
  }

  async archivedCount() {
    return this.s.archived.size;
  }
}
