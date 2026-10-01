/**
 * The only door between the app and a chain. Nothing in here names a chain, a wallet
 * library or an encryption scheme: the EVM + FHEVM adapter, the in-memory mock and a
 * future Solana adapter all implement this one interface.
 */

export type Address = string;

export type BoxStatus = "sealed" | "opening" | "revealed";
export type AliveCheck = "none" | "pending" | "alive" | "notAlive";
/** How heavy an opened cat came out, lightest first. Same keys as the spec's builds. */
export type Build = "thin" | "normal" | "chubby" | "fat" | "huge";
export type Disease = "diabetic" | "arthritic" | "fattyLiver";
export type DuelStatus = "none" | "challenged" | "pending" | "resolved" | "cancelled";

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
  /** The contract function it called, e.g. "challengeDuel". */
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

/** How an action is paid: plain USDC, public like any ERC-20, or confidential cUSDC. */
export type Payment = "usdc" | "cusdc";

export interface PayOptions extends ActionOptions {
  /** "usdc" when left out. */
  pay?: Payment;
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

export type Purchase = "mint" | "feed" | "observe" | "paidShake";

/** A cUSDC payment waiting for its proof. See `ChainAdapter.finishOrder`. */
export interface PendingOrder {
  orderId: number;
  purchase: Purchase;
  /** Quantity for a mint, token id otherwise. */
  arg: number;
  price: bigint;
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
  /** Not enough plain USDC for the price. */
  | "insufficient-usdc"
  /** A cUSDC order the buyer could not cover. Nothing was taken. */
  | "unpaid"
  /** A cUSDC order the box no longer allowed by the time it settled. The price went back. */
  | "refunded"
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

/** What the warehouse needs to shelve a box, and the pair view to offer it: who holds it,
 *  whether it is open, and whether it is already entangled. */
export interface BoxSummary {
  tokenId: number;
  owner: Address;
  status: BoxStatus;
  /** Entangled partner of a sealed box. Not read for the others, where it is always null. */
  partner: number | null;
}

/** Where plain CROQ trades against USDC. */
export interface MarketInfo {
  /** e.g. "Uniswap V2". */
  name: string;
  /** The pool in a block explorer, if there is one. */
  poolUrl: string | null;
  /** The swap page of the market's own app, if it has one. */
  appUrl: string | null;
  /** What CROQ is priced in. */
  quote: { symbol: string; decimals: number };
  /** Pool reserves: whole CROQ, and the quote token in its smallest unit. */
  croqReserve: bigint;
  quoteReserve: bigint;
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
  /** Meals served. Public; what they held is not. */
  meals: number;
  /** Meals eaten today (UTC), out of the economy's `mealsPerDay`. */
  mealsToday: number;
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
  /** Asks the wallet for an account and moves it to the right network. `walletId` picks one of `wallets()`. */
  connect(walletId?: string): Promise<Address>;
  disconnect(): Promise<void>;
  /** Fires when the account changes or disconnects. Returns the unsubscribe function. */
  onAccountChange(listener: (account: Address | null) => void): () => void;

  // --- reads (no account needed) ---
  collection(): Promise<CollectionInfo>;
  box(tokenId: number): Promise<BoxInfo>;
  boxesOf(owner: Address): Promise<number[]>;
  /** Owner and status of tokens `from` to `to` (exclusive), cheaper than `box` for each. */
  boxSummaries(from: number, to: number): Promise<BoxSummary[]>;
  pair(tokenA: number, tokenB: number): Promise<PairInfo>;
  /** What `owner` earned from paid shakes and has not claimed yet. */
  credits(owner: Address): Promise<bigint>;
  /** Native coin `owner` holds, in the smallest unit (wei on EVM). */
  balance(owner: Address): Promise<bigint>;
  /** Plain USDC `owner` holds. Public. */
  usdcBalance(owner: Address): Promise<bigint>;
  /** Decrypts the connected account's cUSDC balance, for its eyes only. */
  confidentialUsdcBalance(opts?: ActionOptions): Promise<bigint>;
  /** The connected account's cUSDC orders that were paid for but never settled. */
  pendingOrders(owner: Address): Promise<PendingOrder[]>;

  // --- actions ---
  // Paid actions take `opts.pay`. In cUSDC each is an order: the price is pulled, a public
  // decryption proves it arrived, then the action happens (or the price is refunded).
  /** Returns the new token ids. */
  mint(quantity: number, opts?: PayOptions): Promise<number[]>;
  /** Holder only, free. One random trait, readable by the caller alone. */
  shake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll>;
  /** Anyone but the holder, paid. Same result, same privacy. */
  paidShake(tokenId: number, opts?: PayOptions): Promise<TraitRoll>;
  feed(tokenId: number, opts?: PayOptions): Promise<void>;
  /** Publishes the single bit "is it alive". Returns the answer. */
  proveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean>;
  /** Picks up an alive check that was requested and never finished. */
  finishProveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean>;
  /** Opens the box for good. Returns it, and its entangled partner if it had one. */
  observe(tokenId: number, opts?: PayOptions): Promise<BoxInfo[]>;
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

  /** Pays out the caller's credits, in USDC. */
  claim(opts?: ActionOptions): Promise<void>;

  // --- USDC ---
  /** Test networks only: mints `payment.faucet` test USDC to the caller. */
  faucetUsdc(opts?: ActionOptions): Promise<void>;
  /** Plain USDC into cUSDC, 1:1, straight through the cUSDC contract: no fee. The amount is
   *  public; what happens to it next is not. */
  shieldUsdc(amount: bigint, opts?: ActionOptions): Promise<void>;
  /** What `coinIn` (in the chain's coin) buys through the ramp, after its fee. */
  quoteUsdc(coinIn: bigint): Promise<{ usdcOut: bigint; fee: bigint }>;
  /** Buys USDC with the chain's coin on a public pool, accepting at most 1% less than the quote.
   *  With `shield`, it arrives as cUSDC in the same transaction. */
  buyUsdc(coinIn: bigint, shield: boolean, opts?: ActionOptions): Promise<void>;
  /** Settles a pending cUSDC order: proves whether it was paid, then runs or refunds it. Anyone may.
   *  Throws `unpaid` or `refunded` when it did not go through. */
  finishOrder(orderId: number, opts?: ActionOptions): Promise<void>;

  // --- croquettes (the Pantry) ---
  economy(): Promise<EconomyInfo>;
  boxPantry(tokenId: number): Promise<BoxPantry>;
  /** Plain CROQ `owner` holds. Public. */
  croqBalance(owner: Address): Promise<bigint>;
  /** Decrypts the connected account's cCROQ balance, for its eyes only. */
  confidentialBalance(opts?: ActionOptions): Promise<bigint>;
  /** Welcome bags, then the daily purr, for the listed boxes of the caller. */
  claimCroquettes(tokenIds: number[], opts?: ActionOptions): Promise<void>;
  /** Holder only: feeds a sealed cat `amount` cCROQ, encrypted. The cat eats it all. Past the
   *  day's allowance the amount is cut down; moves 0, silently, if the caller holds less. */
  feedCroquettes(tokenId: number, amount: bigint, opts?: ActionOptions): Promise<void>;
  /** Decrypts what the connected account fed `tokenId` today, for its eyes only. 0 on a new day. */
  eatenToday(tokenId: number, opts?: ActionOptions): Promise<bigint>;
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
  /** Trades on the public market, accepting at most 1% less than the quote. */
  trade(side: TradeSide, amountIn: bigint, opts?: ActionOptions): Promise<void>;
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
