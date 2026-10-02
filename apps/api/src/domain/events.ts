import type { Address, ChainRef, DuelStatus, RequestKind, RequestStatus, RevealedContents, WeighIn } from "./types";

/** Which deployed contract emitted an event. */
export type Source = "collection" | "pantry" | "ramp" | "credits" | "acl";

type Ev<N extends string, B> = ChainRef & { source: Source; name: N } & B;

/** A decoded log of the collection, the Pantry, the USDC ramp, the decryption credits, or Zama's ACL about them. */
export type ProtocolEvent =
  | Ev<"MintPlaced", { firstTokenId: number; buyer: Address; count: number }>
  | Ev<"MilestoneReached", { index: number; sold: number }>
  | Ev<"Shaken", { tokenId: number; viewer: Address; paid: boolean }>
  | Ev<"Fed", { tokenId: number; feeder: Address }>
  | Ev<"RequestPlaced", { requestId: number; tokenId: number; requester: Address; kind: RequestKind }>
  | Ev<"RequestSettled", { requestId: number; status: Exclude<RequestStatus, "pending"> }>
  | Ev<"Observed", { tokenId: number; openedBy: Address; seed: string; state: number; score: number; golden: boolean }>
  | Ev<"AliveProven", { tokenId: number; alive: boolean }>
  | Ev<"EntangleProposed", { tokenA: number; tokenB: number; proposer: Address }>
  | Ev<"Entangled", { tokenA: number; tokenB: number }>
  | Ev<"DuelPosted", { duelId: number; tokenA: number; tokenB: number; challenger: Address; reserved: boolean }>
  | Ev<"DuelOpened", { duelId: number; openUntil: number }>
  | Ev<"DuelCancelled", { duelId: number }>
  | Ev<"DuelAccepted", { duelId: number; tokenB: number; accepter: Address }>
  | Ev<"DuelReopened", { duelId: number }>
  | Ev<"DuelResolved", { duelId: number; winner: number; loser: number; traitIndex: number; roll: number }>
  | Ev<"DuelVoided", { duelId: number }>
  | Ev<"ConfidentialTransfer", { tokenId: number; from: Address; to: Address; moved: string }>
  | Ev<"MealServed", { tokenId: number; feeder: Address }>
  | Ev<"WelcomeBag", { tokenId: number }>
  | Ev<"Purred", { tokenId: number; days: number }>
  | Ev<"Claimed", { caller: Address; boxes: number }>
  | Ev<"WeighInRequested", { tokenId: number }>
  | Ev<"Weighed", { tokenId: number; weight: string; build: number; sick: boolean; disease: number }>
  | Ev<"Bought", { buyer: Address; ethIn: string; fee: string; usdcOut: string; shielded: boolean }>
  | Ev<"CreditsBought", { payer: Address; account: Address; credits: number; paid: string }>
  /** Zama's ACL: one of the protocol's contracts made these handles publicly decryptable. */
  | Ev<"PubliclyDecryptable", { caller: Address; handles: string[] }>;

/** Bookkeeping, not activity: left out of the feeds. */
export const QUIET_EVENTS: readonly string[] = ["PubliclyDecryptable"];

export type EventName = ProtocolEvent["name"];
export type EventOf<N extends EventName> = Extract<ProtocolEvent, { name: N }>;

/**
 * What logs leave out and the contracts' views tell: a duel's boxes and parties when its posting
 * was missed, the other box of a request, the full contents of an opened box, the tolerance of a weighed cat.
 * Read once per batch, after the logs.
 */
export interface DuelSnapshot {
  tokenA: number;
  tokenB: number | null;
  reserved: boolean;
  challenger: Address | null;
  accepter: Address | null;
  status: DuelStatus | null;
  openUntil: number | null;
}

export interface RequestSnapshot {
  kind: RequestKind;
  status: RequestStatus | null;
  requester: Address;
  tokenId: number;
  other: number | null;
}

export interface Snapshots {
  duels: Map<number, DuelSnapshot>;
  requests: Map<number, RequestSnapshot>;
  contents: Map<number, RevealedContents>;
  weighIns: Map<number, WeighIn>;
}

export const emptySnapshots = (): Snapshots => ({ duels: new Map(), requests: new Map(), contents: new Map(), weighIns: new Map() });

/**
 * The part of the snapshots one event needs, stored with it. With it, the read models can be
 * rebuilt from the events table alone, without asking the chain again.
 */
export interface Enrichment {
  duel?: DuelSnapshot;
  request?: RequestSnapshot;
  contents?: RevealedContents;
  weighIn?: WeighIn;
}

export const DUEL_EVENTS: readonly string[] = ["DuelPosted", "DuelOpened", "DuelAccepted", "DuelReopened", "DuelCancelled", "DuelResolved", "DuelVoided"];

export function enrichmentOf(e: ProtocolEvent, s: Snapshots): Enrichment | null {
  const out: Enrichment = {};
  if (DUEL_EVENTS.includes(e.name) && "duelId" in e && s.duels.has(e.duelId)) out.duel = s.duels.get(e.duelId)!;
  if ((e.name === "RequestPlaced" || e.name === "RequestSettled") && s.requests.has(e.requestId)) out.request = s.requests.get(e.requestId)!;
  if (e.name === "Observed" && s.contents.has(e.tokenId)) out.contents = s.contents.get(e.tokenId)!;
  if (e.name === "Weighed" && s.weighIns.has(e.tokenId)) out.weighIn = s.weighIns.get(e.tokenId)!;
  return Object.keys(out).length ? out : null;
}

/** The snapshots an event was projected with, back from what was stored with it. */
export function snapshotsFrom(e: ProtocolEvent, enrichment: Enrichment | null): Snapshots {
  const s = emptySnapshots();
  if (!enrichment) return s;
  if (enrichment.duel && "duelId" in e) s.duels.set(e.duelId, enrichment.duel);
  if (enrichment.request && "requestId" in e) s.requests.set(e.requestId, enrichment.request);
  if (enrichment.contents && "tokenId" in e) s.contents.set(e.tokenId, enrichment.contents);
  if (enrichment.weighIn && "tokenId" in e) s.weighIns.set(e.tokenId, enrichment.weighIn);
  return s;
}

/** Identity of a log: the same transaction and position is the same event. */
export const eventKey = (e: Pick<ChainRef, "txHash" | "logIndex">): string => `${e.txHash}:${e.logIndex}`;

/** What an event touches, for a reconciliation to know which events concern an entity. */
export function idsOf(e: ProtocolEvent): { duelId?: number; requestId?: number } {
  return { duelId: "duelId" in e ? e.duelId : undefined, requestId: "requestId" in e ? e.requestId : undefined };
}

/** Events in chain order. */
export const byChainOrder = (a: ChainRef, b: ChainRef): number => a.block - b.block || a.logIndex - b.logIndex;

/** The addresses an event names as having acted. */
export function actorsOf(e: ProtocolEvent): Address[] {
  switch (e.name) {
    case "MintPlaced":
      return [e.buyer];
    case "Shaken":
      return [e.viewer];
    case "Fed":
    case "MealServed":
      return [e.feeder];
    case "RequestPlaced":
      return [e.requester];
    case "Observed":
      return [e.openedBy];
    case "EntangleProposed":
      return [e.proposer];
    case "DuelPosted":
      return [e.challenger];
    case "DuelAccepted":
      return [e.accepter];
    case "Claimed":
      return [e.caller];
    case "Bought":
      return [e.buyer];
    case "CreditsBought":
      return [e.payer];
    default:
      return [];
  }
}

/** The boxes an event is about, for a box's activity feed. */
export function tokensOf(e: ProtocolEvent): number[] {
  switch (e.name) {
    case "EntangleProposed":
    case "Entangled":
      return [e.tokenA, e.tokenB];
    case "DuelPosted":
      return e.reserved ? [e.tokenA, e.tokenB] : [e.tokenA];
    case "DuelAccepted":
      return [e.tokenB];
    case "DuelResolved":
      return [e.winner, e.loser];
    case "MintPlaced":
      return Array.from({ length: e.count }, (_, i) => e.firstTokenId + i);
    default:
      return "tokenId" in e ? [e.tokenId] : [];
  }
}
