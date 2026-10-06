import { duelStandings, type DuelStanding } from "@dno/chain-adapter/standings";
import { minted, type Box } from "../domain/box";
import { OPEN_DUEL, settles, shelfBoxes, type Duel } from "../domain/duel";
import type { ProtocolEvent } from "../domain/events";
import { ALL_DUELS, settledDuels } from "../domain/standings";
import type { Address, DuelStatus } from "../domain/types";
import type { User } from "../domain/user";
import type { ChainState, CollectionConstants, EconomyState } from "./ports/chain";
import type { EntangleProposal, ReadStore, Stats, Transfer } from "./ports/store";

/** Most token ids one `boxes` call returns. */
export const MAX_BOX_WINDOW = 1000;
/** How far back `pair` looks: an open duel between two boxes is a recent one. */
const PAIR_DUEL_SCAN = 200;
/** Most proposals one `proposals` call returns. */
const PROPOSAL_LIMIT = 200;
/** Most duels the shelf shows. */
const SHELF_LIMIT = 500;

export class NotFound extends Error {}
export class BadRequest extends Error {}

export interface CollectionView extends Omit<CollectionConstants, "milestones" | "rampFeeBps" | "usdcFaucet"> {
  currency: { symbol: string; decimals: number };
  payment: { symbol: string; confidentialSymbol: string; decimals: number; faucet: string | null; ramp: { feeBps: number } | null };
  tokenCount: number;
  sale: { milestones: number[]; reached: number; soldOut: boolean };
}

export interface BoxSummaryView {
  tokenId: number;
  status: Box["status"];
  /** Only for sealed boxes, like the contract-backed reader. */
  partner: number | null;
}

export interface PairView {
  /** Newest first: both boxes can be on the shelf at once. */
  duels: Duel[];
  entangleProposal: { from: number; to: number; proposer: Address } | null;
}

export interface ProposalView {
  from: number;
  to: number;
  proposer: Address;
}

export interface OpenedCatView {
  tokenId: number;
  openedBy: Address;
  openedBlock: number | null;
  revealed: NonNullable<Box["revealed"]>;
}

export interface PendingRequestView {
  requestId: number;
  kind: string;
  tokenId: number;
  other: number | null;
}

export interface BoxPantryView {
  welcomed: boolean;
  nextClaimAt: number;
  weighing: Box["weighing"];
  weighIn: Box["weighIn"];
}

export interface AccountView {
  user: User | null;
  duels: Duel[];
  pending: PendingRequestView[];
  opened: OpenedCatView[];
  activity: ProtocolEvent[];
}

/** Every read the app makes, served from the index and a few cached contract views. */
export class Queries {
  constructor(
    private readonly store: ReadStore,
    private readonly chain: ChainState,
    /** Unix seconds: when a duel on the shelf runs out of time. */
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Last block indexed: every answer is true as of this block. */
  indexedBlock(): Promise<number | null> {
    return this.store.cursor();
  }

  async collection(): Promise<CollectionView> {
    const [c, tokenCount, reached] = await Promise.all([this.chain.collection(), this.store.tokenCount(), this.store.milestonesReached()]);
    const { milestones, rampFeeBps, usdcFaucet, ...rest } = c;
    return {
      ...rest,
      currency: { symbol: "ETH", decimals: 18 },
      payment: {
        symbol: "USDC",
        confidentialSymbol: "cUSDC",
        decimals: 6,
        faucet: usdcFaucet,
        ramp: rampFeeBps === null ? null : { feeBps: rampFeeBps },
      },
      tokenCount,
      sale: { milestones, reached, soldOut: reached >= milestones.length },
    };
  }

  async box(tokenId: number): Promise<Box> {
    const box = await this.store.box(tokenId);
    if (box) return box;
    // Minted before this index looked, or by a mint whose log is still in the confirmation window.
    if (tokenId < (await this.store.tokenCount())) return minted(tokenId, 0);
    throw new NotFound(`box ${tokenId} does not exist`);
  }

  /** Token ids `from` to `to` (exclusive), clipped to what exists. */
  async boxes(from: number, to: number): Promise<BoxSummaryView[]> {
    if (!(from >= 0 && to >= from)) throw new BadRequest("need 0 <= from <= to");
    if (to - from > MAX_BOX_WINDOW) throw new BadRequest(`at most ${MAX_BOX_WINDOW} boxes per call`);
    const end = Math.min(to, await this.store.tokenCount());
    const known = new Map((await this.store.boxes(from, end)).map((b) => [b.tokenId, b]));
    const out: BoxSummaryView[] = [];
    for (let id = from; id < end; id++) {
      const b = known.get(id);
      out.push({ tokenId: id, status: b?.status ?? "sealed", partner: b && b.status === "sealed" ? b.partner : null });
    }
    return out;
  }

  async boxPantry(tokenId: number): Promise<BoxPantryView> {
    const [box, nextClaimAt] = await Promise.all([this.box(tokenId), this.chain.nextClaimAt(tokenId)]);
    return { welcomed: box.welcomed, nextClaimAt, weighing: box.weighing, weighIn: box.weighIn };
  }

  async pair(a: number, b: number): Promise<PairView> {
    if (a === b) throw new BadRequest("a pair needs two boxes");
    const now = this.now();
    const [duels, ab, ba] = await Promise.all([
      this.store.duels({ tokenIds: [a, b], statuses: [...OPEN_DUEL], inTimeAt: now, limit: PAIR_DUEL_SCAN }),
      this.store.proposal(a, b),
      this.store.proposal(b, a),
    ]);
    const proposal: EntangleProposal | null = ab ?? ba;
    return {
      duels: duels.filter((d) => settles(d, a, b, now)),
      entangleProposal: proposal ? { from: proposal.tokenA, to: proposal.tokenB, proposer: proposal.proposer } : null,
    };
  }

  async duel(duelId: number): Promise<Duel> {
    const d = await this.store.duel(duelId);
    if (!d) throw new NotFound(`duel ${duelId} not found`);
    return d;
  }

  /**
   * Duels an account posted or took up, or that involve the boxes it lists. The boxes it holds
   * are its secret: they are passed with the query and never stored.
   */
  duels(q: { account?: Address; tokenIds?: number[]; open?: boolean; limit?: number }): Promise<Duel[]> {
    if (!q.account && !q.tokenIds?.length) throw new BadRequest("give an account, some token ids, or both");
    const statuses: DuelStatus[] | undefined = q.open ? [...OPEN_DUEL] : undefined;
    return this.store.duels({ account: q.account, tokenIds: q.tokenIds, statuses, inTimeAt: q.open ? this.now() : undefined, limit: Math.min(q.limit ?? 100, 500) });
  }

  /** The duel shelf: every box up for a duel that can still be taken up, newest first. */
  /**
   * Entanglements proposed to or by any of these boxes and still open to acceptance: both boxes
   * sealed and neither entangled yet. Whether the proposer still holds theirs is checked, encrypted,
   * at acceptance.
   */
  async proposals(tokenIds: number[]): Promise<ProposalView[]> {
    const listed = await this.store.proposals(tokenIds, PROPOSAL_LIMIT);
    const ids = [...new Set(listed.flatMap((p) => [p.tokenA, p.tokenB]))];
    const boxes = new Map((await Promise.all(ids.map((id) => this.store.box(id)))).flatMap((b) => (b ? [[b.tokenId, b] as const] : [])));
    const free = (id: number) => {
      const b = boxes.get(id);
      return !!b && b.status === "sealed" && b.partner === null;
    };
    return listed.filter((p) => free(p.tokenA) && free(p.tokenB)).map((p) => ({ from: p.tokenA, to: p.tokenB, proposer: p.proposer }));
  }

  /** Duels someone can still take up: in time, and their boxes still sealed. */
  async duelShelf(): Promise<Duel[]> {
    const listed = await this.store.duels({ statuses: ["open"], inTimeAt: this.now(), limit: SHELF_LIMIT });
    const ids = [...new Set(listed.flatMap(shelfBoxes))];
    const boxes = await Promise.all(ids.map((id) => this.store.box(id)));
    const opened = new Set(boxes.flatMap((b) => (b?.status === "revealed" ? [b.tokenId] : [])));
    return listed.filter((d) => !shelfBoxes(d).some((id) => opened.has(id)));
  }

  async leaderboard(): Promise<OpenedCatView[]> {
    const opened = await this.store.openedBoxes();
    return opened
      .filter((b): b is Box & { revealed: NonNullable<Box["revealed"]>; openedBy: Address } => !!b.revealed && !!b.openedBy)
      .map((b) => ({ tokenId: b.tokenId, openedBy: b.openedBy, openedBlock: b.openedBlock, revealed: b.revealed }));
  }

  /** Boxes ranked by their duels: the first three wear a rosette. */
  async duelStandings(): Promise<DuelStanding[]> {
    return duelStandings(settledDuels(await this.store.duels({ statuses: ["resolved"], limit: ALL_DUELS })));
  }

  async pendingRequests(account: Address): Promise<PendingRequestView[]> {
    return (await this.store.pendingRequests(account)).map((r) => ({ requestId: r.requestId, kind: r.kind, tokenId: r.tokenId, other: r.other }));
  }

  /** The receipts an account appears in, for it to decrypt and replay. */
  transfers(account: Address, afterBlock: number, limit = 5000): Promise<Transfer[]> {
    return this.store.transfers(account, afterBlock, Math.min(limit, 5000));
  }

  async account(address: Address): Promise<AccountView> {
    const [user, duels, pending, opened, activity] = await Promise.all([
      this.store.user(address),
      this.store.duels({ account: address, limit: 50 }),
      this.pendingRequests(address),
      this.leaderboard().then((all) => all.filter((c) => c.openedBy === address)),
      this.store.activity({ account: address, limit: 50 }),
    ]);
    return { user, duels, pending, opened, activity };
  }

  activity(q: { tokenId?: number; account?: Address; beforeBlock?: number; limit?: number }): Promise<ProtocolEvent[]> {
    return this.store.activity({ ...q, limit: Math.min(q.limit ?? 50, 200) });
  }

  economy(): Promise<EconomyState | null> {
    return this.chain.economy();
  }

  stats(): Promise<Stats> {
    return this.store.stats();
  }
}
