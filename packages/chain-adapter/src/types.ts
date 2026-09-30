/**
 * The only door between the app and a chain. Nothing in here names a chain, a wallet
 * library or an encryption scheme: the EVM + FHEVM adapter, the in-memory mock and a
 * future Solana adapter all implement this one interface.
 */

export type Address = string;

export type BoxStatus = "sealed" | "opening" | "revealed";
export type AliveCheck = "none" | "pending" | "alive" | "notAlive";
export type DuelStatus = "none" | "challenged" | "pending" | "resolved" | "cancelled";

/** What the user is waiting for, in the order it happens. */
export type Step =
  /** The wallet is asking for a signature or a confirmation. */
  | "wallet"
  /** The transaction is sent and not yet included. */
  | "confirming"
  /** Waiting for a decryption: private (shake) or public (open, duel, alive check). */
  | "decrypting"
  /** Sending a decrypted value back to the chain with its proof. */
  | "proving";

export interface ActionOptions {
  onStep?: (step: Step) => void;
}

export interface Fees {
  mint: bigint;
  observe: bigint;
  feed: bigint;
  paidShake: bigint;
}

export interface CollectionInfo {
  /** Human name of the network, e.g. "Sepolia". */
  chain: string;
  /** Where the collection lives on that chain. */
  address: string;
  /** Link to the collection in a block explorer, if there is one. */
  explorerUrl: string | null;
  currency: { symbol: string; decimals: number };
  maxSupply: number;
  maxPerTx: number;
  totalMinted: number;
  fees: Fees;
}

/** Everything an opened box made public. Mirrors the contract's `Revealed` struct. */
export interface RevealedContents {
  seed: bigint;
  /** State id from the game spec. */
  state: number;
  /** Rolls, indexed like `spec.traits`. */
  traits: number[];
  /** Rarity score, golden bonus included. */
  score: number;
  affection: number;
  golden: boolean;
}

/** One trait roll: all a shake or a lost duel ever shows. */
export interface TraitRoll {
  /** Index into `spec.traits`. */
  traitIndex: number;
  roll: number;
}

export interface BoxInfo {
  tokenId: number;
  owner: Address;
  status: BoxStatus;
  aliveCheck: AliveCheck;
  /** Token id of the entangled partner, if any. */
  partner: number | null;
  wins: number;
  /** How many times it was fed. What that earned is encrypted. */
  feeds: number;
  /** Traits made public by lost duels while the box is still sealed. */
  publicTraits: TraitRoll[];
  revealed: RevealedContents | null;
}

export interface DuelInfo {
  duelId: number;
  tokenA: number;
  tokenB: number;
  challenger: Address;
  status: DuelStatus;
}

export interface DuelResult {
  duelId: number;
  winner: number;
  loser: number;
  /** The one trait the loser has to show. The winner shows nothing. */
  shown: TraitRoll;
}

/** The standing between two boxes: what the pair view needs to pick the next step. */
export interface PairInfo {
  /** Latest duel between the two that is still waiting for someone, if any. */
  openDuel: DuelInfo | null;
  /** Set when the holder of `from` proposed to entangle it with `to`. */
  entangleProposal: { from: number; to: number; proposer: Address } | null;
}

export type ChainErrorCode =
  /** No wallet available in this environment. */
  | "no-wallet"
  /** An action needs an account and none is connected. */
  | "not-connected"
  /** The user said no in the wallet. */
  | "rejected"
  | "wrong-network"
  | "insufficient-funds"
  /** The chain refused the transaction. `reason` carries the contract's error name. */
  | "reverted"
  /** The decryption service failed or timed out. */
  | "decryption"
  | "unknown";

export class ChainError extends Error {
  constructor(
    readonly code: ChainErrorCode,
    message: string,
    /** Contract error name for `reverted`, e.g. "NotHolder". */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "ChainError";
  }
}

export interface ChainAdapter {
  readonly kind: "mock" | "evm" | "solana";

  // --- account ---
  /** Connected account, or null. */
  account(): Address | null;
  /** Asks the wallet for an account and moves it to the right network. */
  connect(): Promise<Address>;
  disconnect(): Promise<void>;
  /** Fires when the account changes or disconnects. Returns the unsubscribe function. */
  onAccountChange(listener: (account: Address | null) => void): () => void;

  // --- reads (no account needed) ---
  collection(): Promise<CollectionInfo>;
  box(tokenId: number): Promise<BoxInfo>;
  boxesOf(owner: Address): Promise<number[]>;
  pair(tokenA: number, tokenB: number): Promise<PairInfo>;
  /** What `owner` earned from paid shakes and has not claimed yet. */
  credits(owner: Address): Promise<bigint>;

  // --- actions ---
  /** Returns the new token ids. */
  mint(quantity: number, opts?: ActionOptions): Promise<number[]>;
  /** Holder only, free. One random trait, readable by the caller alone. */
  shake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll>;
  /** Anyone but the holder, paid. Same result, same privacy. */
  paidShake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll>;
  feed(tokenId: number, opts?: ActionOptions): Promise<void>;
  /** Publishes the single bit "is it alive". Returns the answer. */
  proveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean>;
  /** Picks up an alive check that was requested and never finished. */
  finishProveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean>;
  /** Opens the box for good. Returns it, and its entangled partner if it had one. */
  observe(tokenId: number, opts?: ActionOptions): Promise<BoxInfo[]>;
  /** Picks up an opening that was requested and never finished. Anyone may. */
  finishObserve(tokenId: number, opts?: ActionOptions): Promise<BoxInfo[]>;

  proposeEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void>;
  acceptEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void>;

  /** Returns the duel id. */
  challengeDuel(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<number>;
  cancelDuel(duelId: number, opts?: ActionOptions): Promise<void>;
  acceptDuel(duelId: number, opts?: ActionOptions): Promise<void>;
  /** Publishes the outcome of an accepted duel. Anyone may. */
  finishDuel(duelId: number, opts?: ActionOptions): Promise<DuelResult>;

  /** Pays out the caller's credits. */
  claim(opts?: ActionOptions): Promise<void>;
}

/** "0.002" for 2000000000000000n at 18 decimals. No trailing zeros. */
export function formatAmount(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** "0x6a18…3208" */
export const shortAddress = (address: Address): string =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

export const sameAddress = (a: Address | null | undefined, b: Address | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
