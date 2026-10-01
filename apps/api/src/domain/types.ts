/**
 * The protocol as the backend sees it. Plain data, no chain library: amounts that do not fit a
 * JSON number (seeds, weights, wei) travel as decimal strings.
 */

/** Lower-case 0x address. Every address is normalised before it reaches the domain. */
export type Address = string;

export type BoxStatus = "sealed" | "revealed";
export type AliveCheck = "none" | "alive" | "notAlive";
export type RequestKind = "open" | "aliveCheck" | "entangle";
export type RequestStatus = "pending" | "done" | "refused";
export type DuelStatus = "challenged" | "pending" | "resolved" | "cancelled" | "void";
export type Build = "thin" | "normal" | "chubby" | "fat" | "huge";
export type Disease = "diabetic" | "arthritic" | "fattyLiver";
export type Weighing = "none" | "pending" | "done";

export interface TraitRoll {
  traitIndex: number;
  roll: number;
}

/** Everything an opening made public. Mirrors the contract's `Revealed` struct. */
export interface RevealedContents {
  seed: string;
  state: number;
  traits: number[];
  score: number;
  affection: number;
  golden: boolean;
}

export interface WeighIn {
  weight: string;
  build: Build;
  sick: boolean;
  disease: Disease | null;
  tolerance: string;
}

/** Where on the chain something happened. */
export interface ChainRef {
  block: number;
  /** Unix seconds, when known. */
  timestamp: number | null;
  txHash: string;
  logIndex: number;
}

export const normalizeAddress = (address: string): Address => address.toLowerCase();

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
