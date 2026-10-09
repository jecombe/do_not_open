import type { Address } from "../../domain/types";

/** A holder's request on a sealed vault box: the key comes encrypted for the vault and the relayer. */
export interface VaultRequestTx {
  boxId: number;
  action: number;
  to: Address;
  price: bigint;
  endTime: number;
  handle: string;
  inputProof: string;
}

/** The proof that settles a request: anyone may send it. */
export interface VaultFinalizeTx {
  requestId: number;
  cleartexts: string;
  proof: string;
}

/** Sends the vault's transactions from the relayer's own wallet. */
export interface VaultSender {
  readonly address: Address;
  /** Plays it first: a transaction the vault would refuse is never sent (it throws `VaultRelayRefused`). Returns the hash. */
  request(tx: VaultRequestTx): Promise<string>;
  finalize(tx: VaultFinalizeTx): Promise<string>;
  /** The wallet's balance in wei, for the monitoring: it pays every transaction's gas. */
  balance?(): Promise<bigint>;
}
