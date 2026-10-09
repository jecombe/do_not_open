/**
 * The sealed vault: any NFT of an allowed collection, in a box whose holder is encrypted. The
 * NFT can come out to any address, be sold on Seaport (OpenSea's protocol) with the vault as
 * the seller, or change hands privately for an encrypted cUSDC price.
 *
 * Every holder action that leaves the vault is asked with the box's key, a secret the wallet
 * derives from one signature, never with the holder's address: a relayer (or any wallet)
 * sends the request, so the holder's address shows nowhere.
 */

import type { ActionOptions, Address } from "./types";

export type VaultBoxState = "sealed" | "listed" | "sold" | "withdrawn" | "claimed";

/** A collection the vault takes. */
export interface VaultCollection {
  address: Address;
  name: string;
  /** A test collection anyone may mint from, for free. */
  mintable: boolean;
}

export interface VaultInfo {
  address: Address;
  explorerUrl: string | null;
  /** Share of each sale (Seaport or private) kept as a fee, in basis points. */
  feeBps: number;
  /** The Seaport the listings live on: any Seaport marketplace can fill them. */
  seaport: Address;
  collections: VaultCollection[];
  /** Sends holders' requests, so their address shows nowhere. Null: the wallet sends them, and its address shows. */
  relayer: Address | null;
  /** The chain's coin, for Seaport prices: "ETH". */
  coin: string;
}

export interface VaultListing {
  listingId: number;
  /** In the chain's coin's smallest unit (wei). Public, as on any marketplace. */
  price: bigint;
  /** Unix seconds. */
  endTime: number;
  /** The Seaport order hash, to find the listing on a marketplace. */
  orderHash: string;
}

/** One box. Everything here is public; who holds it is not. */
export interface VaultBox {
  boxId: number;
  collection: Address;
  tokenId: bigint;
  state: VaultBoxState;
  /** Who put the NFT in: public, the deposit is a plain NFT transfer. */
  depositor: Address;
  listing: VaultListing | null;
  /** Wei a Seaport sale left for the box's key holder, the fee taken. */
  proceeds: bigint;
  /** A request on it waits for its proof: it cannot move until then. */
  busy: boolean;
  /** The NFT's own metadata URI. */
  tokenUri: string;
}

export type VaultSaleStatus = "open" | "settled" | "cancelled";

/** A private sale: a box offered to one buyer for an encrypted cUSDC price only the two can read. */
export interface VaultSale {
  saleId: number;
  boxId: number;
  seller: Address;
  buyer: Address;
  status: VaultSaleStatus;
}

export interface VaultAdapter {
  info(): Promise<VaultInfo>;
  /** Every box, newest first. */
  boxes(): Promise<VaultBox[]>;
  box(boxId: number): Promise<VaultBox>;
  /** The connected account's boxes, found in its own receipts (one decryption signature). */
  myBoxes(): Promise<number[]>;
  /** Token ids of `collection` the connected wallet holds. */
  walletNfts(collection: Address): Promise<bigint[]>;
  /** Test collections only: mints a fresh NFT to the connected wallet. Returns its id. */
  mintTestNft(collection: Address, opts?: ActionOptions): Promise<bigint>;

  /** Puts the wallet's NFT in a new box with the wallet's key. Returns the box id. The deposit is public. */
  deposit(collection: Address, tokenId: bigint, opts?: ActionOptions): Promise<number>;
  /** Takes the NFT out to `to` (any address: a fresh one shows no link). Throws `not-yours`. */
  withdraw(boxId: number, to: Address, opts?: ActionOptions): Promise<void>;
  /** Lists the box's NFT on Seaport for `price` wei until `endTime`, the vault as the seller. Throws `not-yours`. */
  list(boxId: number, price: bigint, endTime: number, opts?: ActionOptions): Promise<VaultListing>;
  /** Takes the Seaport listing down. Throws `not-yours`. */
  unlist(boxId: number, opts?: ActionOptions): Promise<void>;
  /** Fills the box's Seaport order from the connected wallet, as any marketplace buyer would. */
  buy(boxId: number, opts?: ActionOptions): Promise<void>;
  /** Sends a Seaport sale's ETH to `to`. Returns what was sent. Throws `not-yours`. */
  claim(boxId: number, to: Address, opts?: ActionOptions): Promise<bigint>;

  /** Gives the box to `to`: moves it only if the caller holds it. The receiver sets its key with `adopt`. */
  send(boxId: number, to: Address, opts?: ActionOptions): Promise<void>;
  /** Makes the wallet's key the box's: what a received box needs before anything leaves it. A "maybe", like a transfer. */
  adopt(boxId: number, opts?: ActionOptions): Promise<void>;

  /** Private sales the connected account offered or was offered, newest first. */
  sales(): Promise<VaultSale[]>;
  /** Offers the box to `buyer` for `price` cUSDC, encrypted in this page. Returns the sale id. */
  offerSale(boxId: number, buyer: Address, price: bigint, opts?: ActionOptions): Promise<number>;
  cancelSale(saleId: number, opts?: ActionOptions): Promise<void>;
  /** The buyer takes the offer: pays the secret price and gets the box with their key, or nothing moves. Returns whether it moved. */
  acceptSale(saleId: number, opts?: ActionOptions): Promise<boolean>;
  /** Decrypts the prices of sales the connected account is part of. */
  salePrices(saleIds: number[], opts?: ActionOptions): Promise<Record<number, bigint>>;
}
