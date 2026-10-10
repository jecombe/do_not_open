/**
 * The sealed vault: any NFT of an allowed collection, in a box whose holder is encrypted. The
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
  /** The chain's block explorer (Etherscan's layout), or null without one. Links go through `vaultLinks`. */
  explorer: string | null;
  /** Where an NFT's page is on a marketplace, `<marketplace>/<collection>/<tokenId>`, or null where none shows the chain. */
  marketplace: string | null;
  /** Share of each sale (Seaport or private) kept as a fee, in basis points. */
  feeBps: number;
  /** The Seaport the listings live on: any Seaport marketplace can fill them. */
  seaport: Address;
  /** What buyers' offers pay in: WETH, wrapped from ETH by the page when needed. */
  weth: Address;
  /** delegate.xyz's registry, where a box's delegate is written. */
  delegateRegistry: Address;
  collections: VaultCollection[];
  /** Sends holders' requests, so their address shows nowhere. Null: the wallet sends them, and its address shows. */
  relayer: Address | null;
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
  /** Decoys to send the new box to in the same transaction, 0 to `MAX_DECOYS`: transfers to fresh
   *  random addresses that move nothing. The deposit names the depositor; with decoys, nobody can
   *  tell whether the box is still theirs. None when left out. */
  decoys?: number;
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
  /** Pockets opened in all: decoys are picked among them. */
  count: number;
  /** The most pockets one side of an action may name, the real one included. */
  maxSet: number;
}

export interface PocketOptions extends ActionOptions {
  /** Other pockets to name next to the real one, so nobody can tell which moved. Capped by
   *  `maxSet - 1` and by the pockets that exist. 2 when left out. */
  decoys?: number;
}

/** A private sale offered to the desk and reserved for a pocket. */
export interface PocketSale extends VaultSale {
  pocketId: number;
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
}

/** A Uniswap V3 pool positions can be opened in: two of the pockets' tokens. */
export interface PositionPool {
  address: Address;
  /** Uniswap's order: token0's ERC-20 sorts below token1's. Each is the pockets' token wrapping it. */
  token0: PocketToken;
  token1: PocketToken;
  /** Uniswap's fee tier, in hundredths of a bip: 3000 is 0.3% of every trade, paid to positions in range. */
  fee: number;
  tickSpacing: number;
  /** Live: the pool's price as Uniswap keeps it, and its tick. */
  sqrtPriceX96: bigint;
  tick: number;
  /** Live: the liquidity trading at the current price. */
  liquidity: bigint;
}

export type PositionStatus = "funding" | "open" | "closed" | "failed" | "out";

/** A liquidity position. Everything here is public, as on Uniswap; who holds it is not. */
export interface SealedPosition {
  positionId: number;
  status: PositionStatus;
  /** The pool's address. */
  pool: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  /** Uniswap's NFT, null until its first funding settles. */
  tokenId: bigint | null;
  liquidity: bigint;
  /** What its liquidity is worth now, in each ERC-20's smallest units. */
  amount0: bigint;
  amount1: bigint;
  /** Trading fees earned and not collected yet, before the vault's share, in the ERC-20s' units. */
  fees0: bigint;
  fees1: bigint;
  /** Whether the pool's price is inside its range: only then does it earn fees. */
  inRange: boolean;
  /** Fundings waiting for their proofs (anyone may settle them; the page does). */
  pending: number[];
  /** The address that signs its holder's actions: derived from the holder's signature, tied to no wallet. Public. */
  controller: Address;
}

export interface PositionsInfo {
  address: Address;
  positionManager: Address;
  /** Share of the trading fees a collect keeps, in basis points (never of the liquidity). */
  feeBps: number;
  /** Positions opened in all. */
  count: number;
  pools: PositionPool[];
  /** Sends opens, settles and holders' actions, so no wallet shows. Null: the wallet sends them. */
  relayer: Address | null;
}

export interface PositionOptions extends ActionOptions {
  /** Other pockets to name next to each real one, so nobody can tell which paid or is paid. 2 when left out. */
  decoys?: number;
  /** How far the price may move before Uniswap refuses the deposit, in basis points of each amount. 100 (1%) when left out. */
  slippageBps?: number;
}

/** A Uniswap position the wallet holds itself, in one of the pools here: it can come in. */
export interface WalletPosition {
  tokenId: bigint;
  pool: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/**
 * Uniswap V3 liquidity nobody can tie to a wallet. A position is paid for out of the wallet's
 * pockets of its two tokens, held by the vault's positions contract, steered by an address
 * derived from the same signature as the pockets' keys (one per position, so nothing ties a
 * wallet's positions together), and pays its fees and its liquidity back into pockets. Every
 * transaction goes through the vault's relayer when the API has one.
 */
export interface PositionsAdapter {
  info(): Promise<PositionsInfo>;
  /** Every position, newest first: public, as on Uniswap. */
  all(): Promise<SealedPosition[]>;
  /** The wallet's positions, found from its signature on any device, newest first. */
  mine(opts?: ActionOptions): Promise<SealedPosition[]>;
  /** Opens a position in `pool` on [tickLower, tickUpper] with `amount0` and `amount1` (the pockets' confidential units)
   *  out of the wallet's pockets of the two tokens (opened when missing). Waits for the unwraps' proofs and settles:
   *  whatever Uniswap does not take goes back to the pockets. Throws `not-yours` when a pocket is short (nothing moved)
   *  and `missed` when Uniswap refused (the price moved: everything went back). Returns the position's id. */
  open(pool: Address, tickLower: number, tickUpper: number, amount0: bigint, amount1: bigint, opts?: PositionOptions): Promise<number>;
  /** Adds liquidity to one of the wallet's positions, out of its pockets, the same way. */
  add(positionId: number, amount0: bigint, amount1: bigint, opts?: PositionOptions): Promise<void>;
  /** Sends the position's trading fees into the wallet's pockets, the vault's share taken. Returns what the pockets got, in the ERC-20s' units. */
  collect(positionId: number, opts?: PositionOptions): Promise<{ amount0: bigint; amount1: bigint }>;
  /** Takes `shareBps` of the liquidity out (10,000 closes the position) and the fees earned, into the wallet's pockets. */
  remove(positionId: number, shareBps: number, opts?: PositionOptions): Promise<{ amount0: bigint; amount1: bigint }>;
  /** Hands the position to another holder: `to` is their receive address (`receiveAddress`). */
  give(positionId: number, to: Address, opts?: ActionOptions): Promise<void>;
  /** A fresh address of the wallet's that a position can be given to: good until something is given to it. */
  receiveAddress(opts?: ActionOptions): Promise<Address>;
  /** Sends the Uniswap NFT to `to`, out of the vault: the address is public. */
  takeOut(positionId: number, to: Address, opts?: ActionOptions): Promise<void>;
  /** Uniswap positions the wallet holds in the pools here. */
  walletPositions(): Promise<WalletPosition[]>;
  /** Brings one of the wallet's own Uniswap positions in: the deposit names the wallet. Returns the position's id. */
  deposit(tokenId: bigint, opts?: ActionOptions): Promise<number>;
  /** Settles a funding left waiting (a page closed mid-way): anyone may. */
  settle(fundingId: number, opts?: ActionOptions): Promise<void>;
  /** Test networks: the wallet trades back and forth in the pool, so the positions in range earn fees. Null where it cannot. */
  trade: ((pool: Address, opts?: ActionOptions) => Promise<void>) | null;
}

export interface VaultAdapter {
  info(): Promise<VaultInfo>;
  /** The tokens pockets hold where they are deployed, the vault's cUSDC first. */
  pocketTokens(): PocketToken[];
  /** The pockets of `symbol` (the vault's cUSDC when left out), where they are deployed. */
  pockets(symbol?: string): PocketsAdapter | null;
  /** Uniswap liquidity positions funded out of the pockets, where they are deployed. */
  positions(): PositionsAdapter | null;
  /** Every box, newest first. */
  boxes(): Promise<VaultBox[]>;
  box(boxId: number): Promise<VaultBox>;
  /** The connected account's boxes, found in its own receipts (one decryption signature). */
  myBoxes(): Promise<number[]>;
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
