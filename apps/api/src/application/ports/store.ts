import type { Box } from "../../domain/box";
import type { Duel } from "../../domain/duel";
import type { Enrichment, ProtocolEvent } from "../../domain/events";
import type { Charge, Meter, PublicDecryption } from "../../domain/relayer";
import type { Rat } from "../../domain/rats";
import type { Request } from "../../domain/request";
import type { Address, ChainRef, DuelStatus } from "../../domain/types";
import type { User } from "../../domain/user";
import type { AllowListClaim } from "../allowList";
import type { XPass } from "../xPass";
import type { TermsAcceptance } from "../terms";

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

/** A recorded event, with what the contract added to it when it was indexed. */
export interface StoredEvent {
  event: ProtocolEvent;
  enrichment: Enrichment | null;
}

/** Writes of one sync batch, all inside one database transaction. */
export interface ProjectionTx {
  /** Records the raw event. False when it was already recorded: the caller then skips it. */
  insertEvent(e: ProtocolEvent, enrichment: Enrichment | null): Promise<boolean>;
  /** Drops events by key (`txHash:logIndex`): a reorg took them out of the chain. */
  deleteEvents(keys: string[]): Promise<number>;
  /** Keys and block hashes of the events recorded in `from..to`. */
  eventsBetween(from: number, to: number): Promise<{ key: string; blockHash: string | null }[]>;
  /** Recorded events in chain order, after `after`, `limit` at a time. */
  storedEvents(after: { block: number; logIndex: number } | null, limit: number): Promise<StoredEvent[]>;
  /** Empties every read model, keeping the events and the users' sign-ins: a replay follows. */
  resetReadModels(): Promise<void>;
  setCursor(block: number): Promise<void>;
  setFinalizedCursor(block: number): Promise<void>;
  /** Who served the logs of `from..to`. */
  saveRange(from: number, to: number, servedBy: string[]): Promise<void>;
  pruneRanges(upTo: number): Promise<void>;

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
  /** Handles one of the protocol's contracts made publicly decryptable. */
  savePublished(handles: string[], caller: Address, block: number): Promise<void>;
  /** Credits bought on-chain for `account`. */
  addCredits(account: Address, credits: number): Promise<void>;
  /** Studio units bought on-chain for `account`. */
  addStudioUnits(account: Address, sketches: number, models: number, paid?: string): Promise<void>;
  rat(ratId: number): Promise<Rat | null>;
  saveRat(rat: Rat): Promise<void>;
  /** One more paid shake by `account`: a rat's sniffs are its owner's. */
  addSniff(account: Address): Promise<void>;
}

/** Without `account` or `tokenIds`, every duel (with `statuses`, every open one). */
export interface DuelQuery {
  /** Duels posted or taken up by this address. */
  account?: Address;
  /** Duels that involve any of these boxes. With `account`, either matches. */
  tokenIds?: number[];
  statuses?: DuelStatus[];
  /** Unix seconds: leaves out duels on the shelf whose time ran out before then. */
  inTimeAt?: number;
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
  /** Last block checked again once final, or null. */
  finalizedCursor(): Promise<number | null>;
  /** Endpoints that served logs overlapping `from..to`. */
  servedBy(from: number, to: number): Promise<string[]>;
  knownDuelIds(): Promise<number[]>;
  knownRequestIds(): Promise<number[]>;
  /** Every request still waiting for its proof, whoever placed it. */
  allPendingRequests(): Promise<Request[]>;
  box(tokenId: number): Promise<Box | null>;
  boxes(from: number, to: number): Promise<Box[]>;
  tokenCount(): Promise<number>;
  milestonesReached(): Promise<number>;
  openedBoxes(): Promise<Box[]>;
  duel(duelId: number): Promise<Duel | null>;
  duels(q: DuelQuery): Promise<Duel[]>;
  proposal(tokenA: number, tokenB: number): Promise<EntangleProposal | null>;
  /** Proposals naming any of these boxes, on either side, newest first. */
  proposals(tokenIds: number[], limit: number): Promise<EntangleProposal[]>;
  pendingRequests(requester: Address): Promise<Request[]>;
  transfers(account: Address, afterBlock: number, limit: number): Promise<Transfer[]>;
  user(address: Address): Promise<User | null>;
  activity(q: ActivityQuery): Promise<ProtocolEvent[]>;
  stats(): Promise<Stats>;
  /** Which of these handles one of the protocol's contracts made publicly decryptable. Lowercase. */
  publishedAmong(handles: string[]): Promise<string[]>;
  /** Credits ever bought for this account. */
  creditsBought(account: Address): Promise<number>;
}

export interface Store extends ReadStore {
  transaction<T>(run: (tx: ProjectionTx) => Promise<T>): Promise<T>;
  /** Signs a user in: stamps their registration and last login. */
  saveUser(user: User): Promise<void>;
  /** One-shot sign-in challenges. `takeNonce` deletes it, so a signature cannot be replayed. */
  saveNonce(address: Address, nonce: string, expiresAt: number): Promise<void>;
  takeNonce(address: Address): Promise<{ nonce: string; expiresAt: number } | null>;
  /** Files a signed release form. Not a read model: a replay keeps it. Returns the one already
   *  filed for that address and version, if any, and then keeps it instead. */
  saveTermsAcceptance(a: TermsAcceptance): Promise<TermsAcceptance | null>;
  /** Every version of the terms the address signed, oldest first. */
  termsAcceptances(address: Address): Promise<TermsAcceptance[]>;
  /** Allow list claims. Not a read model: a replay, or a test network redeployment, keeps them. */
  allowListClaim(address: Address): Promise<AllowListClaim | null>;
  allowListClaims(): Promise<AllowListClaim[]>;
  /** Files a claim, replacing the address's earlier one. */
  saveAllowListClaim(c: AllowListClaim): Promise<void>;
  /** X boarding passes. Not a read model either: a replay, or a redeployment, keeps them. Code,
   *  handle, tweet and address are each unique among the passes that have one. */
  xPassById(id: string): Promise<XPass | null>;
  xPassByCode(code: string): Promise<XPass | null>;
  xPassByHandle(handle: string): Promise<XPass | null>;
  xPassByTweet(tweetId: string): Promise<XPass | null>;
  xPassByAddress(address: Address): Promise<XPass | null>;
  /** Every pass, oldest first. */
  xPasses(): Promise<XPass[]>;
  /** Files a pass, replacing the one with the same id. */
  saveXPass(p: XPass): Promise<void>;
  deleteXPass(id: string): Promise<void>;
  /**
   * The relayer meter of an account on a UTC day. Not a read model: a replay of the chain keeps
   * it. `apply` sees the meter, locked against concurrent calls, and returns what to add to it,
   * or null to leave it as it is; `meter` returns the same.
   */
  meter(account: Address, day: string, apply: (m: Meter) => Charge | null): Promise<Charge | null>;
  meterOf(account: Address, day: string): Promise<Meter>;
  /** Public decryptions sent to Zama, by exact request and by job. Not a read model either. */
  publicDecryption(key: string): Promise<PublicDecryption | null>;
  publicDecryptionOfJob(jobId: string): Promise<PublicDecryption | null>;
  /** Records a request Zama queued (replacing a stale one under the same key) and counts it against each handle. */
  savePublicDecryption(d: Omit<PublicDecryption, "result">, handles: string[]): Promise<void>;
  finishPublicDecryption(jobId: string, result: unknown): Promise<void>;
  /** Forgets a job Zama failed or lost, so the next same request is sent again. */
  dropPublicDecryption(jobId: string): Promise<void>;
  /** How many requests sent to Zama named each of these handles; absent ones never were. */
  publicDecryptionsOf(handles: string[]): Promise<Map<string, number>>;
}
