/**
 * The only door between the app and a chain. Nothing in here names a chain, a wallet
 * library or an encryption scheme: the EVM + FHEVM adapter, the in-memory mock and a
 * future Solana adapter all implement this one interface.
 */

import type { DuelStanding, PlayerPoints } from "./standings";

export type Address = string;

export type BoxStatus = "sealed" | "opening" | "revealed";
export type AliveCheck = "none" | "pending" | "alive" | "notAlive";
/** How heavy an opened cat came out, lightest first. Same keys as the spec's builds. */
export type Build = "thin" | "normal" | "chubby" | "fat" | "huge";
export type Disease = "diabetic" | "arthritic" | "fattyLiver";
/**
 * "posted": waiting for the proof that the challenger holds the box. "open": on the duel shelf,
 * until someone takes it up or it runs out of time. "pending": taken up, waiting for the outcome.
 * "void": the challenger did not hold the box, at posting or when it was taken up. Nothing happened.
 */
export type DuelStatus = "none" | "posted" | "open" | "pending" | "resolved" | "cancelled" | "void";

/** What the user is waiting for, in the order it happens. */
export type Step =
  /** Encrypting an amount in this page, before it is sent. */
  | "encrypting"
  /** The wallet is asking for a signature or a confirmation. */
  | "wallet"
  /** The transaction is sent and not yet included. */
  | "confirming"
  /** Waiting for a decryption: private (shake) or public (open, duel, alive check). */
  | "decrypting"
  /** Sending a decrypted value back to the chain with its proof. */
  | "proving";

/** A transaction an action sent, as it goes from the wallet to a block. */
export interface TxRecord {
  hash: string;
  /** The contract function it called, e.g. "postDuel". */
  call: string;
  status: "sent" | "confirmed" | "failed";
  /** Where to look it up, if the chain has an explorer. */
  url: string | null;
  block?: number;
  gasUsed?: bigint;
}

export interface ActionOptions {
  onStep?: (step: Step) => void;
  /** Called when a transaction is sent, then again once it is mined (or failed). */
  onTx?: (tx: TxRecord) => void;
}

/**
 * Where a payment comes from. The collection only takes confidential cUSDC; "usdc" shields the
 * exact price from the wallet's plain USDC first, which is public: for a mint, it tells everyone
 * how many boxes were bought.
 */
export type Payment = "usdc" | "cusdc";

export interface PayOptions extends ActionOptions {
  /** "cusdc" when left out. */
  pay?: Payment;
}

/** A swap on a public pool: the most it may come out below the quote before it reverts. */
export interface SwapOptions extends ActionOptions {
  /** In basis points, 1 to 5000. 100 (1%) when left out. */
  slippageBps?: number;
}

export interface MintOptions extends PayOptions {
  /** How many token ids to hide the quantity among, from the quantity to `maxPerTx`. Public;
   *  more hide better and cost more gas. `maxPerTx` when left out. */
  ids?: number;
}

/** In the payment token's smallest unit (USDC has 6 decimals). */
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
  /** The chain's own coin, which pays for gas. */
  currency: { symbol: string; decimals: number };
  /** What the fees are paid in: a stablecoin, and its confidential twin. */
  payment: {
    symbol: string;
    confidentialSymbol: string;
    decimals: number;
    /** What one faucet call gives on a test network. Null where there is no faucet. */
    faucet: bigint | null;
    /** Buying USDC with the chain's coin through the site, and the fee it takes. Null where
     *  there is no ramp. Shielding USDC already held is always free. */
    ramp: { feeBps: number } | null;
  };
  maxSupply: number;
  /** Most boxes, and most token ids, one mint creates. */
  maxPerTx: number;
  /** Token ids created so far, empty ones included: not a supply. */
  tokenCount: number;
  /** How many boxes were sold is encrypted. Only these milestones of it are announced. */
  sale: {
    milestones: number[];
    /** How many milestones were announced: the sold count is at least `milestones[reached - 1]`. */
    reached: number;
    /** The last milestone is the cap. */
    soldOut: boolean;
  };
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
  /** Who holds a box is encrypted. True when the connected account found it among its own
   *  boxes (`boxesOf`), false otherwise, including for every box when nobody is connected. */
  mine: boolean;
  /** "opening" and an alive check "pending" while the connected account's request waits for
   *  its proof. */
  status: BoxStatus;
  aliveCheck: AliveCheck;
  /** Token id of the entangled partner, if any. */
  partner: number | null;
  wins: number;
  /** Traits made public by lost duels while the box is still sealed. */
  publicTraits: TraitRoll[];
  revealed: RevealedContents | null;
}

/** An opened box, as the leaderboard ranks it: the cat, and who opened it. Opening is the one
 *  thing that makes a holder public. */
export interface OpenedCat {
  tokenId: number;
  /** Who asked for the opening, and held the box (or its entangled partner) then. */
  openedBy: Address;
  revealed: RevealedContents;
}

/** A box put up for a duel, and how far that duel went. */
export interface DuelInfo {
  duelId: number;
  /** The challenger's box, the one on the shelf. */
  tokenA: number;
  /** The box that took it up, or the only one allowed to when `reserved`. Null while an open
   *  duel waits for a taker. */
  tokenB: number | null;
  /** Only `tokenB` may take it up. */
  reserved: boolean;
  challenger: Address;
  /** Who took it up, while that is under way or done. */
  accepter: Address | null;
  status: DuelStatus;
  /** Unix seconds after which nobody can take it up. Null until the holding is proven. */
  openUntil: number | null;
}

/** At most this many decoys go with a box sent away. */
export const MAX_DECOYS = 5;

export interface SendBoxOptions extends ActionOptions {
  /** Decoys to send with it, 0 to `MAX_DECOYS`: transfers of the same box to fresh random
   *  addresses that move nothing, in a random order with the real one. To anyone else each is
   *  a "maybe", so a box whose holder became public cannot be followed. One transaction each,
   *  one encryption for all. None when left out. */
  decoys?: number;
}

export interface PostDuelOptions extends ActionOptions {
  /** Only this box may take the duel up. Any sealed box may when left out. */
  reservedFor?: number;
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
  /** The duels the two can settle, newest first: one of them up for a duel that the other may
   *  take up (open to all, or reserved for it), or a duel between them waiting for its outcome.
   *  Both boxes can be on the shelf at once: which one to act on depends on who is asking. */
  duels: DuelInfo[];
  /** Set when the holder of `from` proposed to entangle it with `to`. */
  entangleProposal: EntangleProposal | null;
}

/** The holder of `from` proposed to entangle it with `to`; the holder of `to` may accept. */
export interface EntangleProposal {
  from: number;
  to: number;
  proposer: Address;
}

export type RequestKind = "open" | "aliveCheck" | "entangle";

/** A request of the connected account that waits for its proof. See `finishRequest`. */
export interface PendingRequest {
  requestId: number;
  kind: RequestKind;
  tokenId: number;
  /** The entangled partner opened along with it, or box B of an entanglement. */
  other: number | null;
}

export type ChainErrorCode =
  /** No wallet available in this environment. */
  | "no-wallet"
  /** An action needs an account and none is connected. */
  | "not-connected"
  /** The user said no in the wallet. */
  | "rejected"
  /** The wallet already has a request open (a connection, a signature) the user has not answered. */
  | "wallet-busy"
  | "wrong-network"
  /** Not enough of the chain's coin for the gas. `detail` says how much it held and needed. */
  | "insufficient-funds"
  /** Not enough plain USDC for the price. */
  | "insufficient-usdc"
  /** The cUSDC did not cover the price, or the mint would have passed the cap. Nothing was taken. */
  | "unpaid"
  /** The caller did not hold the box. Nothing happened, and nobody else learned it. */
  | "not-yours"
  /** The flea market sold the item to someone else first, or the listing changed (repriced,
   *  cancelled, its box opened): the payment came back in full. */
  | "missed"
  /** The chain refused the transaction. `reason` carries the contract's error name. */
  | "reverted"
  /** The decryption service failed or timed out. */
  | "decryption"
  /** The chain's endpoint, or the decryption service, could not be reached or turned the request
   *  away (rate limit, timeout). Nothing was sent, or what was sent may still go through. */
  | "network"
  /** The wallet's account has an earlier transaction stuck, or the wallet's nonce is off. */
  | "nonce"
  /** The day's free decryptions are spent and the wallet's decryption credits do not cover what
   *  this needs. Nothing was sent. `held` and `needed` count decryptions. */
  | "no-credits"
  | "unknown";

/** What an error knows beyond its code, for the app to word a way out. */
export interface ChainErrorDetail {
  /** The transaction that failed, or the last one that went through, in a block explorer. */
  txUrl?: string | null;
  /** The action's first transaction went through and only a later step failed (a decryption,
   *  the proof, a declined second signature). Running the same action again picks it up from
   *  there, without paying twice. */
  resumable?: boolean;
  /** The transaction went through and did what it does, but the step after it failed (reading the
   *  result back): sending it again would do it twice. */
  landed?: boolean;
  /** The transaction made it into a block and failed there: its gas was spent. */
  mined?: boolean;
  /** For `insufficient-funds`, in the chain's coin; for `insufficient-usdc` and `unpaid`, in the
   *  payment token, smallest units; for `no-credits`, in decryptions. Either may be missing. */
  held?: bigint;
  needed?: bigint;
}

export class ChainError extends Error {
  constructor(
    readonly code: ChainErrorCode,
    message: string,
    /** Contract error name for `reverted`, e.g. "NotHolder". */
    readonly reason?: string,
    readonly detail: ChainErrorDetail = {},
  ) {
    super(message);
    this.name = "ChainError";
  }

  /** The same error, with more detail. */
  with(detail: ChainErrorDetail): ChainError {
    return new ChainError(this.code, this.message, this.reason, { ...this.detail, ...detail });
  }
}

/** What the warehouse needs to shelve a box, and the pair view to offer it: whether it is the
 *  connected account's, whether it is open, and whether it is already entangled. */
export interface BoxSummary {
  tokenId: number;
  /** See `BoxInfo.mine`. */
  mine: boolean;
  status: BoxStatus;
  /** Entangled partner of a sealed box. Not read for the others, where it is always null. */
  partner: number | null;
}

/** Where plain CROQ trades against USDC. */
export interface MarketInfo {
  /** e.g. "Uniswap V3". */
  name: string;
  /** The pool in a block explorer, if there is one. */
  poolUrl: string | null;
  /** The swap page of the market's own app, if it has one. */
  appUrl: string | null;
  /** What CROQ is priced in. */
  quote: { symbol: string; decimals: number };
  /**
   * What the pool prices with, as a constant-product pool's reserves: whole CROQ, and the quote
   * token in its smallest unit. Their ratio is the current price. On a concentrated-liquidity
   * pool these are the "virtual" reserves of the active range, more than the pool holds.
   */
  croqReserve: bigint;
  quoteReserve: bigint;
  /** What the pool actually holds: whole CROQ, and the quote token in its smallest unit. */
  croqHeld: bigint;
  quoteHeld: bigint;
  /**
   * Where CROQ is sold, in the quote token's smallest unit per 1,000 CROQ: it never sells below
   * `from`, and the last of it goes at `to`. Null for a pool with no such range.
   */
  range: { from: bigint; to: bigint } | null;
}

/** The croquette economy next to the collection. Amounts are whole croquettes. */
export interface EconomyInfo {
  /** "CROQ": the plain token any market can list. */
  symbol: string;
  /** "cCROQ": its confidential twin, the one the game uses. */
  confidentialSymbol: string;
  totalSupply: bigint;
  /** CROQ wrapped into cCROQ: the most that can sit in confidential balances and the Pantry. */
  wrapped: bigint;
  welcomeBag: number;
  purrMaxPerDay: number;
  vetMultiplier: number;
  purrMaxDays: number;
  /** How many times the purr has halved so far. */
  halvings: number;
  /** Seconds between two halvings. */
  halvingPeriod: number;
  /** Meals one cat may eat per UTC day. */
  mealsPerDay: number;
  /** Croquettes one cat may eat per UTC day, across its meals. More is cut down, silently. */
  maxEatenPerDay: bigint;
  /** Share of each meal paid to the collection's treasury, in basis points. */
  mealTreasuryBps: number;
  /** Share of each meal that is burnt, in basis points. The rest goes back to the reserve. */
  mealBurnBps: number;
  maxBoxesPerClaim: number;
  /** Explorer links to the plain token, the confidential one and the Pantry. */
  links: { croq: string | null; cCroq: string | null; pantry: string | null };
  /** Null where no public market was opened. */
  market: MarketInfo | null;
}

/** What the connected account may read about a cat's day: the real figures if it holds it. */
export interface PantryDay {
  /** Meals eaten today (UTC), out of the economy's `mealsPerDay`. */
  meals: number;
  /** Croquettes eaten today, out of `maxEatenPerDay`. */
  eaten: bigint;
}

/** What the scales said about an opened cat. Public once weighed. */
export interface WeighIn {
  /** Croquettes it ate in its life, all holders together. */
  weight: bigint;
  build: Build;
  /** True when the weight reached the cat's own tolerance: an ultra-rare trophy. */
  sick: boolean;
  /** Null unless sick. */
  disease: Disease | null;
  /** The weight past which this cat was sick, drawn from its seed. */
  tolerance: bigint;
}

/** What the Pantry knows publicly about one box. Its weight is encrypted until it is weighed. */
export interface BoxPantry {
  /** True once its welcome bag was paid: a box gets one, whoever holds it. */
  welcomed: boolean;
  /** Unix seconds from which it can claim again. */
  nextClaimAt: number;
  /** "pending" between the request and the proof, like an opening. */
  weighing: "none" | "pending" | "done";
  /** Null until the opened cat is weighed. */
  weighIn: WeighIn | null;
}

export type TradeSide = "buy" | "sell";

/**
 * What a wallet may still decrypt and encrypt where the collection pays the relayer (mainnet):
 * a free allowance each UTC day, then credits bought in plain USDC. Both are counted in units:
 * a decrypted value is one, an encrypted input (a mint's quantity, a meal) `inputUnits`.
 */
export interface DecryptionAllowance {
  /** Fewer before the wallet's first act on-chain. */
  freePerDay: number;
  freeLeft: number;
  /** Credits bought and not spent yet. */
  credits: number;
  /** Unix seconds: when the free allowance is full again. */
  resetsAt: number;
  /** Plain USDC, smallest unit, per credit. Null where credits cannot be bought. */
  price: bigint | null;
  /** Units one encrypted input costs. */
  inputUnits: number;
}

/** A studio pack as the StudioPacks contract sells it. */
export interface StudioPack {
  id: number;
  key: string;
  name: string;
  /** Plain USDC, smallest unit. */
  price: bigint;
  /** Cartoon pictures from a prompt. */
  sketches: number;
  /** Sketches turned into 3D models. */
  models: number;
}

/** Studio units: what a pack holds, what was bought, what is left. */
export interface StudioUnits {
  sketches: number;
  models: number;
}

/** One of the depot's rats: a plain ERC-721, owners public. */
export interface RatInfo {
  id: number;
  /** A free rat, minted by its seed, or an AI rat, minted with its studio job. */
  kind: "seed" | "model";
  /** Decimal 64-bit seed of a seed rat. */
  seed: string | null;
  /** The studio job of an AI rat. */
  job: string | null;
  /** Where an AI rat's files are kept (ar://). */
  uri: string | null;
  owner: Address;
  minter: Address;
  mintedBlock: number | null;
  /** A picture of the rat, when the API serves one. */
  imageUrl: string | null;
  /** An AI rat's 3D model (GLB). */
  modelUrl: string | null;
  /** Boxes its owner sniffed (paid shakes), as the API counts them. 0 when unknown. */
  sniffs: number;
}

/** What adopting a rat costs, in plain USDC, smallest unit. */
export interface RatPrices {
  seed: bigint;
  model: bigint;
}

/** How many rats there are and can ever be: the supply is capped for good, per kind. */
export interface RatSupply {
  seed: { minted: number; max: number };
  model: { minted: number; max: number };
  /** The most rats one address may mint, both kinds together. */
  perWallet: number;
  /** Rats `account` minted, or null without an account. */
  mintedBy: number | null;
}

/** A rat, free or AI, as it is looked up before adopting it: by its seed, or by its studio job. */
export type RatRef = { seed: bigint } | { job: string };

/** Who adopted a rat already. */
export interface RatTaken {
  id: number;
  owner: Address;
}

/** The API's go-ahead to mint an AI rat: its files are on Arweave and the attester signed. */
export interface RatAdoption {
  /** The job id as the contract takes it (bytes32 hex), or the studio's UUID. */
  job: string;
  uri: string;
  /** Unix seconds. */
  deadline: number;
  signature: string;
  priceUsdc: string;
}

/** The rats' pantry: what it pays, and what it has left. */
export interface RatPantryInfo {
  /** Plain CROQ a rat earns a day. */
  perDay: number;
  /** Days kept between two claims. */
  maxDays: number;
  /** Plain CROQ left to pay out. */
  reserve: bigint;
}

/** Where an item for sale comes from: the boxes (a sealed box, or a cat once opened) or the rats. */
export type MarketCollection = "boxes" | "rats";

/**
 * "pending": a box on its way to the market, waiting for the proof that it arrived. "refused": it
 * never arrived, the seller did not hold it; nothing happened.
 */
export type ListingStatus = "pending" | "active" | "sold" | "cancelled" | "refused";

/** One item on the flea market. */
export interface Listing {
  listingId: number;
  collection: MarketCollection;
  tokenId: number;
  /** Public once the listing is active: selling a box shows who held it. */
  seller: Address;
  /** The asking price, in cUSDC's smallest unit. Public. */
  price: bigint;
  /** Unix seconds. */
  listedAt: number;
  status: ListingStatus;
}

/** The flea market's terms. */
export interface FleaMarketInfo {
  /** Where the market lives, and its page in a block explorer if there is one. */
  address: string;
  explorerUrl: string | null;
  /** Share of each sale paid to the treasury, in basis points. */
  feeBps: number;
  /** The most an item may be listed or offered for, in cUSDC's smallest unit. */
  maxPrice: bigint;
}

export type OfferStatus = "open" | "accepted" | "withdrawn";

/** A secret offer: an encrypted amount of cUSDC escrowed on a listing. */
export interface MarketOffer {
  offerId: number;
  listingId: number;
  buyer: Address;
  status: OfferStatus;
}

export type PurchaseStatus = "pending" | "done" | "unpaid" | "missed";

/** A purchase at the asking price, as it waits for (or got) the proof that it was paid. */
export interface MarketPurchase {
  purchaseId: number;
  listingId: number;
  buyer: Address;
  price: bigint;
  status: PurchaseStatus;
}

export interface ListingQuery {
  /** Only listings in this state. All when left out. */
  status?: ListingStatus;
  seller?: Address;
  collection?: MarketCollection;
}

export interface OfferQuery {
  listingId?: number;
  buyer?: Address;
  /** Offers on listings of this seller. */
  seller?: Address;
  status?: OfferStatus;
}

/** A session with the DO NOT OPEN API, opened by a wallet signature (no transaction). */
export interface ApiSession {
  account: Address;
  /** Sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** A release form signed by the connected wallet. */
export interface SignedTerms {
  account: Address;
  /** The exact text the wallet signed. */
  message: string;
  /** EIP-191 personal signature on EVM. */
  signature: string;
  /** True when the API filed it too; false when only this browser keeps it. */
  recorded: boolean;
}

/** Where the connected account stands on the mainnet allow list. */
export interface AllowListStatus {
  /** Its points now, from the duels and openings indexed. */
  live: PlayerPoints;
  /** Points from an X boarding pass linked to this wallet; absent or 0 without one. */
  bonus?: number;
  /** The points the ranking counts: the best it had since it claimed (a test network
   *  redeployment forgets the duels, not the claims), or `live` before it claims. */
  points: number;
  /** Unix seconds, null until it claims. */
  claimedAt: number | null;
  /** 1-based, among claimants; null until it claims. */
  rank: number | null;
  claimants: number;
  /** How many claimants get a place. */
  /** The cap on the list, or null: no cap, every claimant is on it. */
  places: number | null;
}

/** A wallet the browser offers, as shown in a picker. */
export interface WalletOption {
  id: string;
  name: string;
  /** Data URI announced by the wallet, if any. */
  icon: string | null;
}

export interface ChainAdapter {
  readonly kind: "mock" | "evm" | "solana";

  // --- account ---
  /** Connected account, or null. */
  account(): Address | null;
  /** Wallets the user can pick from. Empty when there is only one way in (the mock). */
  wallets(): WalletOption[];
  /**
   * Asks the wallet for an account and moves it to the right network. `walletId` picks one of
   * `wallets()`. With `chooseAccount`, the wallet shows its account picker again (EIP-2255
   * `wallet_requestPermissions`) instead of handing back the account it shared last time.
   */
  connect(walletId?: string, opts?: { chooseAccount?: boolean }): Promise<Address>;
  disconnect(): Promise<void>;
  /** Fires when the account changes or disconnects. Returns the unsubscribe function. */
  onAccountChange(listener: (account: Address | null) => void): () => void;

  // --- reads (no account needed) ---
  collection(): Promise<CollectionInfo>;
  box(tokenId: number): Promise<BoxInfo>;
  /** The connected account's boxes, found in its own transfer receipts: it decrypts them,
   *  nobody else can. Asks for a decryption signature the first time. [] for anyone else. */
  boxesOf(owner: Address): Promise<number[]>;
  /** Status of token ids `from` to `to` (exclusive), cheaper than `box` for each. */
  boxSummaries(from: number, to: number): Promise<BoxSummary[]>;
  pair(tokenA: number, tokenB: number): Promise<PairInfo>;
  /** Entanglements proposed to or by any of `tokenIds` that can still be accepted: both boxes
   *  sealed and free. Newest first. */
  entangleProposals(tokenIds: number[]): Promise<EntangleProposal[]>;
  /** Every opened box, with who opened it. */
  openedCats(): Promise<OpenedCat[]>;
  /** Every box that settled a duel, ranked (see `duelStandings`): the first three wear a rosette. */
  duelStandings(): Promise<DuelStanding[]>;
  /** Duels `account` posted or took up, and those that involve any of `tokenIds` (the
   *  account's boxes, as `boxesOf` found them), newest first. With `open`, only those still
   *  waiting for someone. The same list from any device. */
  duels(query: { account?: Address; tokenIds?: number[]; open?: boolean }): Promise<DuelInfo[]>;
  /** The duel shelf: every box up for a duel that can still be taken up, newest first. */
  duelShelf(): Promise<DuelInfo[]>;
  /** Native coin `owner` holds, in the smallest unit (wei on EVM). */
  balance(owner: Address): Promise<bigint>;
  /** Plain USDC `owner` holds. Public. */
  usdcBalance(owner: Address): Promise<bigint>;
  /** The ciphertext handle of `owner`'s cUSDC balance. Public, and new after every transfer in
   *  or out: a decrypted balance is still right as long as the handle it came from is. */
  confidentialUsdcHandle(owner: Address): Promise<string>;
  /** Decrypts the connected account's cUSDC balance, for its eyes only. */
  confidentialUsdcBalance(opts?: ActionOptions): Promise<bigint>;
  /** The connected account's openings, alive checks and entanglements waiting for their proof. */
  pendingRequests(owner: Address): Promise<PendingRequest[]>;

  // --- actions ---
  // Paid actions are paid in cUSDC, from the cUSDC balance or, with `pay: "usdc"`, shielded
  // from plain USDC just before. A payment the balance does not cover moves nothing.
  /** Buys `quantity` boxes, the quantity encrypted. Returns the ids the caller got. Throws
   *  `unpaid` when it got none (not enough cUSDC, or sold out). */
  mint(quantity: number, opts?: MintOptions): Promise<number[]>;
  /** Announces the next sale milestone if the sold count reached it. Anyone may. Returns
   *  whether one was announced. */
  announceMilestone(opts?: ActionOptions): Promise<boolean>;
  /** Holder only, free. One random trait, readable by the caller alone. Throws `not-yours`. */
  shake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll>;
  /** Anyone, paid; the holder's share waits in the box. Same result, same privacy. Throws
   *  `unpaid` when the cUSDC did not cover the fee. */
  paidShake(tokenId: number, opts?: PayOptions): Promise<TraitRoll>;
  feed(tokenId: number, opts?: PayOptions): Promise<void>;
  /** Publishes the single bit "is it alive". Returns the answer. Throws `not-yours`. */
  proveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean>;
  /** Picks up an alive check that was requested and never finished. */
  finishProveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean>;
  /** Opens the box for good. Returns it, and its entangled partner if it had one. Throws
   *  `not-yours` (nothing charged) or `unpaid`. */
  observe(tokenId: number, opts?: PayOptions): Promise<BoxInfo[]>;
  /** Picks up the connected account's opening of `tokenId` that never got its proof. */
  finishObserve(tokenId: number, opts?: ActionOptions): Promise<BoxInfo[]>;
  /** Picks up any pending request, by id. Anyone may. Throws `not-yours` when it was refused. */
  finishRequest(requestId: number, opts?: ActionOptions): Promise<void>;

  proposeEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void>;
  /** Throws `not-yours` when the proposer no longer holds A or the caller does not hold B. */
  acceptEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void>;

  /** Puts `tokenA` on the duel shelf, open to any sealed box or reserved for one, and proves
   *  that the caller holds it: that much becomes public. Returns the duel, open. Throws
   *  `not-yours` when the caller does not hold it (the duel is void, nothing else shows). */
  postDuel(tokenA: number, opts?: PostDuelOptions): Promise<DuelInfo>;
  /** Takes a duel off the shelf, until someone takes it up. Challenger only. */
  cancelDuel(duelId: number, opts?: ActionOptions): Promise<void>;
  /** Takes the duel up with `tokenB` and publishes the outcome. Null when the challenger no
   *  longer held their box (void). Throws `not-yours` when the caller does not hold `tokenB`:
   *  the duel goes back on the shelf. */
  acceptDuel(duelId: number, tokenB: number, opts?: ActionOptions): Promise<DuelResult | null>;
  /** Relays whatever proof a duel waits for: the holding of a posted one, or the outcome of a
   *  taken-up one. Anyone may. Returns the outcome when there is one. */
  finishDuel(duelId: number, opts?: ActionOptions): Promise<DuelResult | null>;

  /** Pays the caller what paid shakes earned the listed boxes they hold, in cUSDC. Returns
   *  what arrived, read from the caller's own balance. */
  claimEarnings(tokenIds: number[], opts?: ActionOptions): Promise<bigint>;
  /** Gives a box away. Moves it only if the caller holds it; nobody else learns which. With
   *  `decoys`, also sends transfers that move nothing, so that even someone who knows the
   *  caller held the box cannot tell which one moved it. */
  sendBox(tokenId: number, to: Address, opts?: SendBoxOptions): Promise<void>;

  // --- USDC ---
  /** Test networks only: mints `payment.faucet` test USDC to the caller. */
  faucetUsdc(opts?: ActionOptions): Promise<void>;
  /** Plain USDC into cUSDC, 1:1, straight through the cUSDC contract: no fee. The amount is
   *  public; what happens to it next is not. */
  shieldUsdc(amount: bigint, opts?: ActionOptions): Promise<void>;
  /** What `coinIn` (in the chain's coin) buys through the ramp, after its fee. */
  quoteUsdc(coinIn: bigint): Promise<{ usdcOut: bigint; fee: bigint }>;
  /** Buys USDC with the chain's coin on a public pool, accepting at most `slippageBps` (1% by
   *  default) less than the quote. With `shield`, it arrives as cUSDC in the same transaction. */
  buyUsdc(coinIn: bigint, shield: boolean, opts?: SwapOptions): Promise<void>;
  /** cUSDC back to plain USDC: a request, a public decryption of the amount, then the payout.
   *  Returns what arrived: 0 when the cUSDC balance did not cover `amount` (nothing moves). */
  unshieldUsdc(amount: bigint, opts?: ActionOptions): Promise<bigint>;

  // --- croquettes (the Pantry) ---
  economy(): Promise<EconomyInfo>;
  boxPantry(tokenId: number): Promise<BoxPantry>;
  /** Plain CROQ `owner` holds. Public. */
  croqBalance(owner: Address): Promise<bigint>;
  /** The ciphertext handle of `owner`'s cCROQ balance. Public, and new after every move in or
   *  out, like `confidentialUsdcHandle`. */
  confidentialCroqHandle(owner: Address): Promise<string>;
  /** Decrypts the connected account's cCROQ balance, for its eyes only. */
  confidentialBalance(opts?: ActionOptions): Promise<bigint>;
  /** Pays welcome bags, then the daily purr, into the listed boxes, and the caller what waits in
   *  those they hold. */
  claimCroquettes(tokenIds: number[], opts?: ActionOptions): Promise<void>;
  /** Holder only: feeds a sealed cat `amount` cCROQ, encrypted. The cat eats it all. Past the
   *  day's limits the amount is cut down; moves 0, silently, if the caller holds less or does
   *  not hold the cat. */
  feedCroquettes(tokenId: number, amount: bigint, opts?: ActionOptions): Promise<void>;
  /** Decrypts what the connected account may read about `tokenId` today: zeros on a new day,
   *  or when it does not hold the cat. */
  pantryDay(tokenId: number, opts?: ActionOptions): Promise<PantryDay>;
  /** Weighs an opened cat: requests the public decryption of its weight and proves it back,
   *  or picks up a weighing left pending. Anyone may. */
  weigh(tokenId: number, opts?: ActionOptions): Promise<WeighIn>;
  /** Plain CROQ into cCROQ, 1:1. */
  wrap(amount: bigint, opts?: ActionOptions): Promise<void>;
  /** cCROQ back to plain CROQ: a request, a public decryption of the amount, then the payout. */
  unwrap(amount: bigint, opts?: ActionOptions): Promise<void>;
  /** A confidential transfer: nobody but the two sides learns the amount. */
  sendCroquettes(to: Address, amount: bigint, opts?: ActionOptions): Promise<void>;
  /** What `amountIn` buys on the market: CROQ for USDC ("buy") or USDC for CROQ ("sell"). */
  quote(side: TradeSide, amountIn: bigint): Promise<bigint>;
  /** Trades on the public market, accepting at most `slippageBps` (1% by default) less than the quote. */
  trade(side: TradeSide, amountIn: bigint, opts?: SwapOptions): Promise<void>;

  // --- release form ---
  /** Has the connected wallet sign `message` (the terms, naming its address), free and off-chain,
   *  and files the signature with the API where there is one. Throws `rejected` if refused. */
  signTerms(message: string): Promise<SignedTerms>;

  /** Has the connected wallet sign `message` (EIP-191, free, off-chain) and returns the signature,
   *  filed nowhere: the caller sends it where it belongs. Throws `rejected` if refused. */
  signText(message: string): Promise<string>;

  // --- mainnet allow list ---
  /** Where the connected account stands. Null when nobody is connected or there is no API to
   *  keep the claims. */
  allowList(): Promise<AllowListStatus | null>;
  /** Has the connected wallet sign a claim (free, off-chain) and files it. Signing again later
   *  keeps the best points. Throws `rejected` if refused, `network` without an API. */
  claimAllowList(): Promise<AllowListStatus>;

  // --- decryption credits ---
  /** The connected account's decryptions left. Null where nobody counts them (the mock, a free relayer). */
  decryptionAllowance(): Promise<DecryptionAllowance | null>;
  /** Buys decryption credits for the connected account, in plain USDC: the whole price or a revert. */
  buyCredits(credits: number, opts?: ActionOptions): Promise<void>;

  // --- studio ---
  /** The studio's packs on sale, read from the StudioPacks contract. Null where none is deployed. */
  studioPacks(): Promise<StudioPack[] | null>;
  /** Buys pack `packId` for the connected account, in plain USDC: the whole price or a revert.
   *  Throws `insufficient-usdc` before any transaction when the wallet holds too little. */
  buyStudioPack(packId: number, opts?: ActionOptions): Promise<void>;
  /** Units the connected account bought from this browser that an API answer as of `block`
   *  may not count yet: add them to what it says, so a purchase shows at once. */
  studioPending(block: number | null): StudioUnits;
  /** Signs in to the API with the connected wallet: one free signature, no transaction. Null
   *  where there is no API (the mock). Throws `rejected` if the wallet refuses. */
  apiSession(): Promise<ApiSession | null>;

  // --- rats ---
  /** What adopting a rat costs. Null where no Rats contract is deployed. */
  ratPrices(): Promise<RatPrices | null>;
  /** Rats minted and left, per kind, and what `account` minted. Null where no Rats contract is deployed. */
  ratSupply(account?: Address | null): Promise<RatSupply | null>;
  /** The rat a seed or a studio job (its UUID, or the bytes32 an adoption carries) became, and who
   *  holds it now; null while nobody adopted it. */
  ratTaken(ref: RatRef): Promise<RatTaken | null>;
  /** Adopts the free rat of `seed` for the connected account, in plain USDC. Returns its token id.
   *  Throws `insufficient-usdc` before any transaction when the wallet holds too little, and
   *  `reverted` (`SoldOut`, `WalletLimit`) when no seed rat is left or the account minted its share. */
  mintSeedRat(seed: bigint, opts?: ActionOptions): Promise<number>;
  /** Adopts an AI rat with the API's go-ahead. Returns its token id. Refused like `mintSeedRat`. */
  mintModelRat(adoption: RatAdoption, opts?: ActionOptions): Promise<number>;
  /** The rats `account` owns, newest first. */
  ratsOf(account: Address): Promise<RatInfo[]>;
  /** Plain CROQ each rat would get if claimed now, in the order of `ids`. */
  ratClaimable(ids: number[]): Promise<bigint[]>;
  /** The rats' pantry. Null where none is deployed. */
  ratPantry(): Promise<RatPantryInfo | null>;
  /** Collects what the connected account's rats `ids` earned. Returns the CROQ paid. */
  claimRatCroq(ids: number[], opts?: ActionOptions): Promise<bigint>;
  /** One rat, whoever holds it (the flea market, while it is for sale). */
  rat(id: number): Promise<RatInfo>;

  // --- flea market ---
  // Everything is paid in cUSDC. The asking price is public; a secret offer's amount is
  // readable by its buyer and the listing's seller only, and so is the price of a sale made by offer.
  /** The market's terms. Null where no market is deployed. */
  fleaMarket(): Promise<FleaMarketInfo | null>;
  /** Listings, newest first. */
  listings(query?: ListingQuery): Promise<Listing[]>;
  /**
   * Puts the connected account's box, cat or rat up for `price` cUSDC. Lets the market move the
   * item first if it may not yet. A box goes to the market in a "maybe" transfer, then the proof
   * that it arrived is relayed: throws `not-yours` when the caller did not hold it (nothing
   * moved, nobody else learned it). Returns the listing, active.
   */
  listItem(collection: MarketCollection, tokenId: number, price: bigint, opts?: ActionOptions): Promise<Listing>;
  /** Relays the arrival proof of a box listing left pending. Anyone may. Throws `not-yours` when it was refused. */
  finishListing(listingId: number, opts?: ActionOptions): Promise<Listing>;
  /** Seller only. Purchases placed at the old price are refunded. */
  repriceListing(listingId: number, price: bigint, opts?: ActionOptions): Promise<void>;
  /** Seller only: the item comes back. Open offers stay withdrawable by their buyers. */
  cancelListing(listingId: number, opts?: ActionOptions): Promise<void>;
  /**
   * Buys at the asking price, then relays the proof of payment, which delivers the item. Throws
   * `unpaid` when the cUSDC did not cover it (nothing was taken) and `missed` when someone else
   * got it first or the listing changed (refunded in full).
   */
  buyListing(listingId: number, opts?: PayOptions): Promise<void>;
  /** Relays the payment proof of a purchase left pending. Anyone may. Throws like `buyListing`. */
  finishPurchase(purchaseId: number, opts?: ActionOptions): Promise<void>;
  /** The purchases `account` placed that still wait for their proof. */
  pendingPurchases(account: Address): Promise<MarketPurchase[]>;
  /** Escrows a secret offer of `amount` cUSDC, encrypted in this page. Returns the offer's id. */
  makeOffer(listingId: number, amount: bigint, opts?: PayOptions): Promise<number>;
  /** The buyer takes an open offer back, in full, whatever became of the listing. */
  withdrawOffer(offerId: number, opts?: ActionOptions): Promise<void>;
  /** The seller sells to an offer, at its secret amount. */
  acceptOffer(offerId: number, opts?: ActionOptions): Promise<void>;
  /** Offers, newest first. Amounts are not in here: see `offerAmounts`. */
  offers(query?: OfferQuery): Promise<MarketOffer[]>;
  /** Decrypts the amounts of offers the connected account made or received, for its eyes only.
   *  Offers it may not read are left out. */
  offerAmounts(offerIds: number[], opts?: ActionOptions): Promise<Record<number, bigint>>;
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
