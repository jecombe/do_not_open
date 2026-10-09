import type { Address } from "../../domain/types";

/** A holder's request on a sealed vault box: the key comes encrypted for the vault and the relayer. */
export interface VaultRequestTx {
  boxId: number;
  action: number;
  to: Address;
  price: bigint;
  endTime: number;
  /** Accepting an offer: its Seaport order hash. Zero otherwise. */
  ref: string;
  handle: string;
  inputProof: string;
}

/** The proof that settles a request: anyone may send it. */
export interface VaultFinalizeTx {
  requestId: number;
  cleartexts: string;
  proof: string;
  /** Accepting an offer: abi.encode(AdvancedOrder, bytes32[] criteriaProof), sent with `finalizeOffer`. */
  offer?: string;
}

/** A pocket spend's encrypted inputs, as `SealedPockets.SpendInput`. */
export interface PocketSpendInput {
  amount: string;
  target: string;
  inputProof: string;
  boundKey: string;
  keyProof: string;
}

/** The pockets' and the desk's calls the relayer sends, by name. */
export interface PocketTxs {
  /** Opens a pocket: its key encrypted for the pockets, and the address that reads its balance. */
  pocketOpen: { handle: string; inputProof: string; viewer: Address };
  pocketSend: { from: number[]; to: number[]; input: PocketSpendInput };
  pocketWithdraw: { from: number[]; to: Address; input: PocketSpendInput };
  /** Step 1 of a purchase out of a pocket: the pocket's bound key, and the box key's handle. */
  deskAsk: { saleId: number; handle: string; keyProof: string; boxKey: string };
  /** Step 2: the proof of the "ok" bit and the box's new key. */
  deskBuy: { askId: number; cleartexts: string; proof: string; boxKey: string; boxKeyProof: string };
}
export type PocketCall = keyof PocketTxs;

/** Sends the vault's transactions from the relayer's own wallet. */
export interface VaultSender {
  readonly address: Address;
  /** Plays it first: a transaction the vault would refuse is never sent (it throws `VaultRelayRefused`). Returns the hash. */
  request(tx: VaultRequestTx): Promise<string>;
  finalize(tx: VaultFinalizeTx): Promise<string>;
  /** The pockets' and the desk's calls; refused (`reverted`) where they are not deployed. */
  pockets<C extends PocketCall>(call: C, tx: PocketTxs[C]): Promise<string>;
  /** The wallet's balance in wei, for the monitoring: it pays every transaction's gas. */
  balance?(): Promise<bigint>;
}
