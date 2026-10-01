import type { Box } from "../../domain/box";
import type { Duel } from "../../domain/duel";
import type { ProtocolEvent } from "../../domain/events";
import type { Request } from "../../domain/request";
import type { Address, ChainRef, DuelStatus } from "../../domain/types";
import type { User } from "../../domain/user";

export interface EntangleProposal {
  tokenA: number;
  tokenB: number;
  proposer: Address;
  block: number;
}

export interface Mint {
  firstTokenId: number;
  count: number;
  buyer: Address;
  block: number;
  txHash: string;
}

/** A transfer receipt. Public on-chain; only its two sides can decrypt whether it moved the box. */
export interface Transfer extends ChainRef {
  tokenId: number;
  from: Address;
  to: Address;
  /** Handle of the encrypted "moved" bit. */
  moved: string;
}

/** Writes of one sync batch, all inside one database transaction. */
export interface ProjectionTx {
  /** Records the raw event. False when it was already recorded: the caller then skips it. */
  insertEvent(e: ProtocolEvent): Promise<boolean>;
  setCursor(block: number): Promise<void>;

  box(tokenId: number): Promise<Box | null>;
  saveBox(box: Box): Promise<void>;
  duel(duelId: number): Promise<Duel | null>;
  saveDuel(duel: Duel): Promise<void>;
  request(requestId: number): Promise<Request | null>;
  saveRequest(request: Request): Promise<void>;
  user(address: Address): Promise<User | null>;
  saveUser(user: User): Promise<void>;
  saveProposal(p: EntangleProposal): Promise<void>;
  deleteProposal(tokenA: number, tokenB: number): Promise<void>;
  saveMint(m: Mint): Promise<void>;
  saveMilestone(m: { index: number; sold: number; block: number }): Promise<void>;
  saveTransfer(t: Transfer): Promise<void>;
}

export interface DuelQuery {
  /** Duels challenged by this address. */
  account?: Address;
  /** Duels that involve any of these boxes. With `account`, either matches. */
  tokenIds?: number[];
  statuses?: DuelStatus[];
  limit: number;
}

export interface ActivityQuery {
  tokenId?: number;
  /** Events naming this address as an actor. */
  account?: Address;
  /** Only events strictly before this block, for paging. */
  beforeBlock?: number;
  limit: number;
}

export interface Stats {
  users: number;
  registered: number;
  minted: number;
  opened: number;
  duels: number;
  openDuels: number;
  events: number;
}

/** Reads, all served from the index. */
export interface ReadStore {
  /** Last block indexed, or null before the first sync. */
  cursor(): Promise<number | null>;
  box(tokenId: number): Promise<Box | null>;
  boxes(from: number, to: number): Promise<Box[]>;
  tokenCount(): Promise<number>;
  milestonesReached(): Promise<number>;
  openedBoxes(): Promise<Box[]>;
  duel(duelId: number): Promise<Duel | null>;
  duels(q: DuelQuery): Promise<Duel[]>;
  proposal(tokenA: number, tokenB: number): Promise<EntangleProposal | null>;
  pendingRequests(requester: Address): Promise<Request[]>;
  transfers(account: Address, afterBlock: number, limit: number): Promise<Transfer[]>;
  user(address: Address): Promise<User | null>;
  activity(q: ActivityQuery): Promise<ProtocolEvent[]>;
  stats(): Promise<Stats>;
}

export interface Store extends ReadStore {
  transaction<T>(run: (tx: ProjectionTx) => Promise<T>): Promise<T>;
  /** Signs a user in: stamps their registration and last login. */
  saveUser(user: User): Promise<void>;
  /** One-shot sign-in challenges. `takeNonce` deletes it, so a signature cannot be replayed. */
  saveNonce(address: Address, nonce: string, expiresAt: number): Promise<void>;
  takeNonce(address: Address): Promise<{ nonce: string; expiresAt: number } | null>;
}
