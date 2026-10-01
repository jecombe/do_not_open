import type { Address, ChainRef, DuelStatus, RequestKind, RequestStatus, RevealedContents, WeighIn } from "./types";

/** Which deployed contract emitted an event. */
export type Source = "collection" | "pantry" | "ramp";

type Ev<N extends string, B> = ChainRef & { source: Source; name: N } & B;

/** A decoded log of the collection, the Pantry or the USDC ramp. */
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
  | Ev<"DuelChallenged", { duelId: number; tokenA: number; tokenB: number }>
  | Ev<"DuelCancelled", { duelId: number }>
  | Ev<"DuelAccepted", { duelId: number }>
  | Ev<"DuelResolved", { duelId: number; winner: number; loser: number; traitIndex: number; roll: number }>
  | Ev<"DuelVoided", { duelId: number }>
  | Ev<"ConfidentialTransfer", { tokenId: number; from: Address; to: Address; moved: string }>
  | Ev<"MealServed", { tokenId: number; feeder: Address }>
  | Ev<"WelcomeBag", { tokenId: number }>
  | Ev<"Purred", { tokenId: number; days: number }>
  | Ev<"Claimed", { caller: Address; boxes: number }>
  | Ev<"WeighInRequested", { tokenId: number }>
  | Ev<"Weighed", { tokenId: number; weight: string; build: number; sick: boolean; disease: number }>
  | Ev<"Bought", { buyer: Address; ethIn: string; fee: string; usdcOut: string; shielded: boolean }>;

export type EventName = ProtocolEvent["name"];
export type EventOf<N extends EventName> = Extract<ProtocolEvent, { name: N }>;

/**
 * What logs leave out and the contracts' views tell: who challenged or accepted a duel, the
 * other box of a request, the full contents of an opened box, the tolerance of a weighed cat.
 * Read once per batch, after the logs.
 */
export interface DuelSnapshot {
  tokenA: number;
  tokenB: number;
  challenger: Address | null;
  accepter: Address | null;
  status: DuelStatus | null;
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
    case "Claimed":
      return [e.caller];
    case "Bought":
      return [e.buyer];
    default:
      return [];
  }
}

/** The boxes an event is about, for a box's activity feed. */
export function tokensOf(e: ProtocolEvent): number[] {
  switch (e.name) {
    case "EntangleProposed":
    case "Entangled":
    case "DuelChallenged":
      return [e.tokenA, e.tokenB];
    case "DuelResolved":
      return [e.winner, e.loser];
    case "MintPlaced":
      return Array.from({ length: e.count }, (_, i) => e.firstTokenId + i);
    default:
      return "tokenId" in e ? [e.tokenId] : [];
  }
}
