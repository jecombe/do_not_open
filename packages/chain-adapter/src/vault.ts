/**
 * The sealed vault: any ERC-721 (the owner can shut a collection out), in a box whose holder is encrypted. The
 * NFT can come out to any address, be sold on Seaport (OpenSea's protocol) with the vault as
 * the seller, by a listing or by accepting a buyer's WETH offer, or change hands privately for
 * an encrypted cUSDC price. Meanwhile its rights (airdrops, token gates) can be lent to a wallet
 * through delegate.xyz.
 *
 * Every holder action that leaves the vault is asked with the box's key, a secret the wallet
 * derives from one signature, never with the holder's address: a relayer (or any wallet)
 * sends the request, so the holder's address shows nowhere.
 */

import type { ActionOptions, Address } from "./types";

export type VaultBoxState = "sealed" | "listed" | "sold" | "withdrawn" | "claimed";

/** A collection the page offers to seal (any ERC-721 goes in; these are the ones it knows and draws). */
export interface VaultCollection {
  address: Address;
  name: string;
  /** A test collection anyone may mint from, for free. */
  mintable: boolean;
}

export interface VaultInfo {
  address: Address;
  explorerUrl: string | null;
  /** The chain's block explorer (Etherscan's layout), or null without one. Links go through `vaultLinks`. */
  explorer: string | null;
  /** Where an NFT's page is on a marketplace, `<marketplace>/<collection>/<tokenId>`, or null where none shows the chain. */
  marketplace: string | null;
  /** Share of each sale (Seaport or private) kept as a fee, in basis points. */
  feeBps: number;
  /** The Seaport the listings live on: any Seaport marketplace can fill them. */
  seaport: Address;
  /** `VaultListings`, which writes and keeps the listings' Seaport orders; null on a vault from before it. */
  listings: Address | null;
  /** Listings are made the way OpenSea shows them and are bought there (behind OpenSea's signed zone): `buy` is not
   *  done from here. Mainnet. Elsewhere a listing is an open order anyone fills, `buy` included. */
  listingsOnOpenSea: boolean;
  /** What buyers' offers pay in: WETH, wrapped from ETH by the page when needed. */
  weth: Address;
  /** delegate.xyz's registry, where a box's delegate is written. */
  delegateRegistry: Address;
  collections: VaultCollection[];
  /** Sends holders' requests, so their address shows nowhere. Null: the wallet sends them, and its address shows. */
  relayer: Address | null;
  /** The marketplace whose offers the API reads for the page ("opensea" on mainnet), or null: the board's offers only. */
  market: string | null;
  /** The chain's coin, for Seaport prices: "ETH". */
  coin: string;
}

/** Links to look a vault's address, transaction or NFT up outside the page; null where the chain has nowhere to look. */
export interface VaultLinks {
  address(address: Address): string | null;
  tx(hash: string): string | null;
  nft(collection: Address, tokenId: bigint): string | null;
  marketplace(collection: Address, tokenId: bigint): string | null;
}

export function vaultLinks(info: Pick<VaultInfo, "explorer" | "marketplace"> | null): VaultLinks {
  const explorer = info?.explorer ?? null;
  const market = info?.marketplace ?? null;
  return {
    address: (address) => (explorer ? `${explorer}/address/${address}` : null),
    tx: (hash) => (explorer ? `${explorer}/tx/${hash}` : null),
    nft: (collection, tokenId) => (explorer ? `${explorer}/nft/${collection}/${tokenId}` : null),
    marketplace: (collection, tokenId) => (market ? `${market}/${collection}/${tokenId}` : null),
  };
}

export interface VaultListing {
  listingId: number;
  /** In the chain's coin's smallest unit (wei): what the buyer pays. Public, as on any marketplace. */
  price: bigint;
  /** What comes to the box when it sells: the price less the marketplace's and the creator's fees (the vault's own
   *  fee comes off this). The price itself where there are none. */
  net: bigint;
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
  /** The wallet acting for the NFT in delegate.xyz (airdrops, token gates), or null. Public. */
  delegate: Address | null;
  /** Requests on it wait for their proof: it cannot move until they settle (anyone may settle them). Requests still go in. */
  busy: boolean;
  /** The NFT's own metadata URI. */
  tokenUri: string;
}

/** A buyer's Seaport offer for a box's NFT, in WETH. Public, as on any marketplace. */
export interface VaultOffer {
  orderHash: string;
  /** The buyer: public, they signed the offer. */
  buyer: Address;
  /** Wei of WETH one NFT nets, the order's own fees taken, before the vault's fee. */
  amount: bigint;
  /** Unix seconds. */
  endTime: number;
  /** An offer on any NFT of the collection, not on this one alone. */
  anyToken: boolean;
  /** Where it was found: the on-chain board (`VaultOffers`), or OpenSea, read by the API (mainnet). */
  source: "board" | "opensea";
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

export interface VaultDepositOptions extends ActionOptions {
  /** Decoys to send the new box to in the same transaction, 0 to `MAX_DECOYS`: transfers that
   *  move nothing, to wallets that hold an NFT of the same collection and wallets of the vault's
   *  crowd (`crowd(collection)`, picked at random) and, past them, to fresh random addresses.
   *  The deposit names the depositor; with decoys, nobody can tell whether the box is still
   *  theirs. None when left out. */
  decoys?: number;
}

/**
 * The crowd a box hides in, from public events: an honest measure, not a promise. Read with the
 * connected account, which is left out of `wallets` and `collectors`.
 */
export interface VaultCrowd {
  /** Wallets that have acted on the vault in their own name: deposited an NFT, sent or adopted a
   *  box, offered or took a private sale, took an NFT or a sale's ETH out, or fed a pocket. Each
   *  could be a box's holder. The vault's own contracts, its relayer and the connected account
   *  are left out. */
  wallets: Address[];
  /** Wallets that hold an NFT of the collection `crowd` was asked about (its recent receivers
   *  that still hold their token), the connected account left out; empty when none was asked.
   *  Someone who owns the same kind of NFT could be the box's holder: a deposit's decoys are
   *  picked among them and `wallets`, so the box hides in the collection from the first day,
   *  not only among the wallets that already use the vault. */
  collectors: Address[];
  /** Per box id, how many wallets may hold it, as far as the chain tells: its depositor and the
   *  wallets it was sent to that use the vault or hold an NFT of its collection (a transfer to
   *  an address that never acts and holds nothing is a decoy nobody believes, so it does not
   *  count). 1: its depositor is its obvious holder. */
  holders: Record<number, number>;
}

/** A pocket's group: the pockets its every action names, always the same, and who is known to feed them. */
export interface PocketGroup {
  /** The group's pockets, this one included, by number (`pocketGroup`). */
  members: number[];
  /** How many a full group has (`maxSet`): the last group fills as pockets open. */
  size: number;
  /** Wallets that have deposited into the group: the deposit names the wallet and the set, so
   *  these are the wallets anyone can tie to one of its pockets. 1: yours alone. */
  feeders: number;
}

/** A confidential token pockets hold: cUSDC, and Zama's other ERC-7984 wrappers (cUSDT, cWETH, cZAMA). */
export interface PocketToken {
  /** As the page shows it: cUSDC, cUSDT, cWETH, cZAMA. */
  symbol: string;
  name: string;
  /** The confidential token (ERC-7984). */
  address: Address;
  /** The confidential token's decimals (6 for every wrapper): pocket amounts are in these units. */
  decimals: number;
  /** Plain units of the ERC-20 per confidential unit (10^12 for an 18-decimal token). */
  rate: bigint;
  /** The ERC-20 it wraps. */
  underlying: { address: Address; symbol: string; decimals: number };
  /** Whether its pockets also buy the vault's private sales: only the vault's cUSDC ones. */
  desk: boolean;
  /** Test networks: plain units `faucet` mints. Null without a faucet. */
  faucet: bigint | null;
}

/** The pockets of one token: held in pockets locked by a key, not an address. */
export interface PocketsInfo {
  address: Address;
  /** Buys the vault's private sales out of pockets, and holds the boxes it bought. Null for a
   *  token other than the vault's cUSDC. */
  desk: Address | null;
  /** Puts a pocket's cUSDC to work in a confidential vault. Null where there are no savings. */
  savings: Address | null;
  /** Pockets opened in all: they make groups of `maxSet` by number. */
  count: number;
  /** The most pockets one side of an action may name, the real one included: a group's size. */
  maxSet: number;
}

export interface PocketOptions extends ActionOptions {
  /** Other pockets of the group to name next to the real one: the whole group when left out,
   *  which is what hides best. Fewer still names the same ones every time (`pocketSet`). */
  decoys?: number;
}

/** A private sale offered to the desk and reserved for a pocket. */
export interface PocketSale extends VaultSale {
  pocketId: number;
}

/** The savings' two ways: cUSDC into the vault's shares, and shares back into cUSDC. */
export type SavingsSide = "save" | "unsave";

/** A savings window: `open` takes saves (or unsaves); `joined` sits in one of Zama's batches;
 *  `settled` got the batch's shares (or cUSDC) and hands them to its pockets; `canceled` gives
 *  the pockets their commitments back. */
export type SavingsWindowState = "open" | "joined" | "settled" | "canceled";

export interface SavingsWindow {
  windowId: number;
  side: SavingsSide;
  state: SavingsWindowState;
  /** Zama's batch it joined, null while open. */
  batchId: number | null;
  /** The batch's rate once settled: output units per input unit, times 1e6. Null before. */
  rate: bigint | null;
  /** Unix seconds. */
  openedAt: number;
  /** Pockets with a commitment in it, decoys included. */
  pockets: number;
  /** Of them, not settled yet. */
  left: number;
}

/** The vault's confidential shares (Zama's `cShare`): what a pocket's savings are held in. */
export type SavingsShare = Omit<PocketToken, "desk" | "faucet">;

export interface SavingsInfo {
  address: Address;
  /** The Morpho vault (ERC-4626) behind Zama's batchers, and the batchers themselves. */
  vault: Address;
  depositBatcher: Address;
  redeemBatcher: Address;
  /** Seconds one of Zama's batches must age before it is dispatched: about how long a save
   *  waits in a batch, once its window has joined one. */
  minBatchAge: number;
  /** The windows taking saves and unsaves now. */
  open: { save: SavingsWindow; unsave: SavingsWindow };
}

/** What the wallet's pocket committed to a window that has not been settled for it yet. */
export interface SavingsPending {
  windowId: number;
  side: SavingsSide;
  state: SavingsWindowState;
  /** cUSDC units for a save, share units for an unsave. */
  amount: bigint;
}

/**
 * The wallet's pocket's savings: its cUSDC put to work in one of Zama's confidential vaults on
 * Morpho, through the pockets' savings contract. A save leaves the pocket at once and waits in
 * the open window; the relayer joins the window to the vault's next batch, and once Zama has
 * settled the batch, the pocket's shares appear here. The way back is the same, in batches too:
 * savings are put aside, never paid with at once. Nothing public says which pocket saved, nor how
 * much: the batcher sees one participant, the savings contract, with one encrypted total.
 */
export interface PocketSavingsAdapter {
  readonly share: SavingsShare;
  info(): Promise<SavingsInfo>;
  /** The wallet's pocket's shares, decrypted, in the share's smallest unit. */
  shares(opts?: ActionOptions): Promise<bigint>;
  /** What `shares` are worth now in cUSDC units, at the Morpho vault's public price. */
  value(shares: bigint): Promise<bigint>;
  /** About what `amount` cUSDC gives in shares at the vault's price now: the batch's rate decides. */
  toShares(amount: bigint): Promise<bigint>;
  /** The pocket's commitments in windows not settled for it yet, oldest first. */
  pending(opts?: ActionOptions): Promise<SavingsPending[]>;
  /** Puts `amount` cUSDC of the wallet's pocket aside, among decoys. Moves nothing (no error)
   *  when the balance is short: check `balance` first. */
  save(amount: bigint, opts?: PocketOptions): Promise<void>;
  /** Asks `shares` of the wallet's pocket's savings back as cUSDC, among decoys. Moves nothing
   *  (no error) when the shares are short: check `shares` first. */
  unsave(shares: bigint, opts?: PocketOptions): Promise<void>;
}

/**
 * An address next to the wallet whose key the page holds and nothing on-chain ties to the wallet:
 * a stealth address a pocket paid for the wallet's meta-address (ERC-5564), or the fresh address
 * the wallet feeds its pocket from. Its balances are read with its own key.
 */
export interface SideAddress {
  address: Address;
  /** `stealth`: announced for the wallet's meta-address; `entry`: derived from the wallet's signature, to be funded from outside. */
  kind: "stealth" | "entry";
  /** The confidential token it holds, in the token's units. */
  sealed: bigint;
  /** The plain ERC-20 it holds (USDC for cUSDC), in the plain token's units: collected after a wrap. */
  plain: bigint;
  /** ETH in wei: what pays the transactions it sends itself. */
  gas: bigint;
  /** Whether `gas` covers a collect (`PocketDoorsInfo.gasNeeded`). */
  fueled: boolean;
  /** The entry address's index: the first one never used. */
  index?: number;
  /** The block the stealth payment was announced in. */
  block?: number;
}

export interface PocketDoorsInfo {
  /** ERC-5564's announcer and ERC-6538's registry on this chain. */
  announcer: Address;
  registry: Address;
  /** ETH a side address needs to collect what it holds into the pocket, in wei, at today's gas price. */
  gasNeeded: bigint;
  /** What the API's relayer gives a side address once, in wei, so it can collect; null when it gives none. */
  fuel: bigint | null;
}

/**
 * The pockets' doors: the way out to a fresh address and the way in from one. A withdrawal pays
 * a stealth address (ERC-5564): drawn for the wallet's own meta-address, or for a payee's, and
 * announced so the payee's page finds it; the address shows, as any withdrawal's does, but
 * nothing ties it to anyone. The way in is an entry address derived from the wallet's signature:
 * funded from outside (a privacy pool such as Privacy Pools, an exchange) and emptied into the
 * pocket as itself, so the deposit names an address that never was the wallet's. Both kinds are
 * side addresses: the page derives their keys from the pocket signature, stores nothing, and
 * finds them again on any device.
 */
export interface PocketDoorsAdapter {
  info(): Promise<PocketDoorsInfo>;
  /** The wallet's stealth meta-address (`st:eth:0x…`): what a payer makes stealth addresses from. One signature a session. */
  metaAddress(opts?: ActionOptions): Promise<string>;
  /** Whether the wallet published its meta-address in the registry, where a payer finds it by the wallet's address. */
  published(opts?: ActionOptions): Promise<boolean>;
  /** Publishes it: a wallet transaction, public (it ties the meta-address to the wallet, never the stealth addresses). */
  publish(opts?: ActionOptions): Promise<void>;
  /** A payee as typed: a meta-address, or a wallet address whose meta-address is in the registry. Null: nobody to pay stealthily. */
  resolve(text: string): Promise<string | null>;
  /** Takes `amount` out of the wallet's pocket to a fresh stealth address of `to` (the wallet's own when left out) and
   *  announces it. Returns the address paid. Moves nothing (no error) when the balance is short. */
  withdrawStealth(amount: bigint, to?: string | null, opts?: PocketOptions): Promise<Address>;
  /** Stealth addresses announced for the wallet, newest first, with what they hold. */
  inbox(opts?: ActionOptions): Promise<SideAddress[]>;
  /** The wallet's current entry address: the first never used, with what it holds so far. */
  entry(opts?: ActionOptions): Promise<SideAddress>;
  /** Puts everything a side address holds into the wallet's pocket, as that address (wrapping the plain token first):
   *  it needs `gasNeeded` of ETH there. Throws `insufficient-funds` otherwise. */
  collect(address: Address, opts?: PocketOptions): Promise<void>;
  /** Asks the relayer for `fuel` on a side address, once, so it can collect. Throws when there is no relayer or it gives none. */
  fuel(address: Address, opts?: ActionOptions): Promise<void>;
}

/**
 * The connected wallet's pocket. Its key and the address that reads its balance (its viewer)
 * both come from one wallet signature, so nothing is stored and the same wallet finds its pocket
 * on any device. Spends are relayed when the API has a relayer: the wallet's address shows on
 * none of them, only on deposits.
 */
export interface PocketsAdapter {
  /** The token these pockets hold. */
  readonly token: PocketToken;
  info(): Promise<PocketsInfo>;
  /** Pocket `pocketId`'s group: what its every action names, and the wallets known to feed it. Public events only. */
  group(pocketId: number): Promise<PocketGroup>;
  /** The wallet's pocket, or null before it is opened. One signature a session. */
  mine(opts?: ActionOptions): Promise<number | null>;
  /** Opens the wallet's pocket. Returns its number. */
  open(opts?: ActionOptions): Promise<number>;
  /** Decrypts the wallet's pocket balance, in the token's smallest unit. */
  balance(opts?: ActionOptions): Promise<bigint>;
  /** Puts `amount` of the wallet's confidential token into pocket `to` (the wallet's own when left out),
   *  among decoys. Public: the wallet and the pockets named, not the amount nor which one. */
  deposit(amount: bigint, opts?: PocketOptions & { to?: number }): Promise<void>;
  /** Sends `amount` from the wallet's pocket to pocket `to`. Nothing public says who paid whom.
   *  Moves nothing (no error) when the balance is short: check `balance` first. */
  send(to: number, amount: bigint, opts?: PocketOptions): Promise<void>;
  /** Takes `amount` out of the wallet's pocket to `to`, as the confidential token. The address is public. */
  withdraw(to: Address, amount: bigint, opts?: PocketOptions): Promise<void>;
  /** The wallet's plain ERC-20 balance of the token's underlying, in its own units. */
  plainBalance(): Promise<bigint>;
  /** Test networks: mints `token.faucet` of the underlying ERC-20 to the wallet. */
  faucet(opts?: ActionOptions): Promise<void>;
  /** Wraps the plain ERC-20 into `amount` of the confidential token (in its units), so it can
   *  be put in a pocket. Throws `insufficient-usdc` when the wallet holds too little. */
  shield(amount: bigint, opts?: ActionOptions): Promise<void>;
  /** The seller's side, cUSDC pockets only (`token.desk`): offers box `boxId` privately to pocket `pocketId` for `price` cUSDC.
   *  Returns the sale id. */
  offerSale(boxId: number, pocketId: number, price: bigint, opts?: ActionOptions): Promise<number>;
  /** Sales reserved for the wallet's pocket, newest first. */
  sales(): Promise<PocketSale[]>;
  /** Decrypts the prices of sales reserved for the wallet's pocket. */
  salePrices(saleIds: number[], opts?: ActionOptions): Promise<Record<number, bigint>>;
  /** Buys a sale reserved for the wallet's pocket, with the pocket's cUSDC. The box is then held
   *  by the desk, with the wallet's key: it is taken out, listed or delegated like any of its
   *  boxes. Throws `not-yours` (wrong key or short balance: nothing happened, the sale stays
   *  open). Returns whether the box moved. */
  buy(saleId: number, opts?: ActionOptions): Promise<boolean>;
  /** Boxes the wallet's pocket bought, still in the vault. */
  boxes(): Promise<number[]>;
  /** The pocket's savings, where they are deployed: the vault's cUSDC pockets only. */
  savings(): PocketSavingsAdapter | null;
  /** The pockets' doors (stealth exits, entry addresses), where ERC-5564's contracts are known. */
  doors(): PocketDoorsAdapter | null;
}

export interface VaultAdapter {
  info(): Promise<VaultInfo>;
  /** The tokens pockets hold where they are deployed, the vault's cUSDC first. */
  pocketTokens(): PocketToken[];
  /** The pockets of `symbol` (the vault's cUSDC when left out), where they are deployed. */
  pockets(symbol?: string): PocketsAdapter | null;
  /** Every box, newest first. */
  boxes(): Promise<VaultBox[]>;
  box(boxId: number): Promise<VaultBox>;
  /** The connected account's boxes, found in its own receipts (one decryption signature). */
  myBoxes(): Promise<number[]>;
  /** The crowd boxes hide in: the wallets that use the vault, those that hold an NFT of `collection`
   *  when one is given, and how many may hold each box. Public events only. */
  crowd(collection?: Address): Promise<VaultCrowd>;
  /** WETH `owner` holds, in wei: what their offers can pay. Public, as any ERC-20 balance. */
  wethBalance(owner: Address): Promise<bigint>;
  /** Token ids of `collection` the connected wallet holds. */
  walletNfts(collection: Address): Promise<bigint[]>;
  /** Test collections only: mints a fresh NFT to the connected wallet. Returns its id. */
  mintTestNft(collection: Address, opts?: ActionOptions): Promise<bigint>;

  /** Puts the wallet's NFT in a new box with the wallet's key, sent to `decoys` decoys. Returns the box id. The deposit is public. */
  deposit(collection: Address, tokenId: bigint, opts?: VaultDepositOptions): Promise<number>;
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

  /** Live offers buyers posted for the box's NFT (or any NFT of its collection) that their WETH still covers, best first. */
  offers(boxId: number): Promise<VaultOffer[]>;
  /** Offers `amount` wei of WETH for the box's NFT until `endTime`: wraps ETH and lets Seaport take the WETH when needed, signs the Seaport order, posts it to the offer board. Returns its order hash. The buyer's address is public. */
  makeOffer(boxId: number, amount: bigint, endTime: number, opts?: ActionOptions): Promise<string>;
  /** Cancels one of the connected wallet's own offers on Seaport. */
  cancelOffer(orderHash: string, opts?: ActionOptions): Promise<void>;
  /** The holder accepts an offer: the NFT goes to the buyer, the ETH, less the fee, to `to`. Returns what was sent. Throws `not-yours`, or `missed` when the offer is gone. */
  acceptOffer(boxId: number, orderHash: string, to: Address, opts?: ActionOptions): Promise<bigint>;
  /** Names `delegate` (null: nobody) as the wallet acting for the box's NFT in delegate.xyz. Public: a fresh wallet keeps the holder unlinked. Throws `not-yours`. */
  delegate(boxId: number, delegate: Address | null, opts?: ActionOptions): Promise<void>;

  /** Gives the box to `to`: moves it only if the caller holds it. The receiver sets its key with `adopt`. Settles the box's waiting requests first. */
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
