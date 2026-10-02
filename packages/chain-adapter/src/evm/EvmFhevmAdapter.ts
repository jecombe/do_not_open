import {
  Contract,
  Interface,
  isError,
  type ContractTransactionReceipt,
  type ContractTransactionResponse,
  type InterfaceAbi,
  type Provider,
  type Signer,
} from "ethers";
import type { FhevmInstance } from "@zama-fhe/relayer-sdk/web";
import { duelSettles, duelUnderway, onShelf } from "../duels";
import { traitIndexAtOffset } from "../layout";
import {
  ChainError,
  sameAddress,
  type ActionOptions,
  type Address,
  type AliveCheck,
  type BoxInfo,
  type BoxPantry,
  type BoxStatus,
  type BoxSummary,
  type Build,
  type ChainAdapter,
  type CollectionInfo,
  type DuelInfo,
  type DuelResult,
  type Disease,
  type DuelStatus,
  type PostDuelOptions,
  type EconomyInfo,
  type Fees,
  type MintOptions,
  type OpenedCat,
  type RevealedContents,
  type PairInfo,
  type PantryDay,
  type PayOptions,
  type PendingRequest,
  type RequestKind,
  type TradeSide,
  type TraitRoll,
  type TxRecord,
  type WalletOption,
  type WeighIn,
} from "../types";
import type { IndexedTransfer, IndexerClient } from "./indexer";
import type { ChainParams, WalletSource } from "./wallet";

/** The part of the Relayer SDK instance this adapter uses. */
export type Relayer = Pick<FhevmInstance, "generateKeypair" | "createEIP712" | "userDecrypt" | "publicDecrypt" | "createEncryptedInput">;

interface Deployed {
  address: string;
  abi: InterfaceAbi;
}

/** The croquette economy, as `dno:export` writes it next to the collection's deployment. */
export interface EconomyDeployment {
  croq: Deployed;
  cCroq: Deployed;
  pantry: Deployed;
  /** A Uniswap V2 CROQ/USDC pool, when one was opened on this network. */
  market: { pair: string; router: string; factory: string; usdc: string } | null;
}

export interface EvmAdapterOptions {
  chain: ChainParams;
  /** Address of the DoNotOpen contract. */
  address: string;
  abi: InterfaceAbi;
  /** Reads go here, so the app works before any wallet is connected. */
  readProvider: Provider;
  wallet: WalletSource;
  /** Loads the Relayer SDK (WASM in a browser). Called on the first decryption only. */
  loadRelayer: () => Promise<Relayer>;
  /** Without it, every croquette call fails with "not deployed". */
  economy?: EconomyDeployment;
  /** Test networks: how much `faucetUsdc` mints. Without it there is no faucet. */
  usdcFaucet?: bigint;
  /** The UsdcRamp contract. Without it, USDC cannot be bought through the site. */
  ramp?: Deployed;
  /** Block the collection was deployed in: where reading its events starts. */
  deployBlock?: number;
  /** The DO NOT OPEN API. Reads go there first, and to the chain when it is behind or away. */
  indexer?: IndexerClient;
}

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
];
/** The collection's payment tokens. Their addresses are read from the collection itself. */
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
];
const CUSDC_ABI = [
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function setOperator(address operator, uint48 until)",
  "function wrap(address to, uint256 amount)",
  "error ERC7984UnauthorizedSpender(address holder, address spender)",
];
/** RequestKind and RequestStatus in the contract, by value. */
const REQUEST_KINDS: RequestKind[] = ["open", "aliveCheck", "entangle"];
const REQUEST_PENDING = 1;
const REQUEST_REFUSED = 3;
/** DoNotOpen.NOT_YOURS: the pick a shake returns to someone who did not hold the box or pay. */
const NOT_YOURS = 255;
/** Events are read in slices of this many blocks: public endpoints refuse wider ranges. */
const LOG_SPAN = 40_000;
/** How many handles one user decryption asks for. */
const DECRYPT_BATCH = 50;
const PAIR_ABI = ["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)", "function token0() view returns (address)"];
/** An operator approval given to the Pantry lasts this long. */
const OPERATOR_DAYS = 365;
/** A trade accepts at most this much less than its quote, in basis points. */
const SLIPPAGE_BPS = 100n;
const ZERO_HANDLE = "0x" + "0".repeat(64);

/** On-chain values; "opening" and "pending" come from the account's own requests. */
const BOX_STATUS: BoxStatus[] = ["sealed", "revealed"];
const ALIVE_CHECK: AliveCheck[] = ["none", "alive", "notAlive"];
const DUEL_STATUS: DuelStatus[] = ["none", "posted", "open", "pending", "resolved", "cancelled", "void"];

/** How far back `pair()` looks for a duel that is still open. */
const DUEL_SCAN = 40;

/** A `duelInfo` row as the contract returns it. */
const duelFromView = (duelId: number, d: Record<string, any>): DuelInfo => {
  const accepter = BigInt(d.accepter) === 0n ? null : String(d.accepter);
  return {
    duelId,
    tokenA: Number(d.tokenIdA),
    // An open duel nobody took up yet stores no second box.
    tokenB: d.reserved || accepter ? Number(d.tokenIdB) : null,
    reserved: Boolean(d.reserved),
    challenger: String(d.challenger),
    accepter,
    status: DUEL_STATUS[Number(d.duelStatus)]!,
    openUntil: Number(d.openUntil) || null,
  };
};
/** `boxSummaries()` reads statuses in slices of this many calls. */
const READ_CHUNK = 100;
/** A user-decryption permit is signed once and reused for this long. */
const PERMIT_DAYS = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the connected account found in its own receipts, kept so the next look only reads new blocks. */
interface Holdings {
  account: Address;
  /** Last block read. */
  block: number;
  held: Set<number>;
  /** Receipts already replayed, by transaction hash and log index. */
  seen: Set<string>;
}

interface Permit {
  account: Address;
  publicKey: string;
  privateKey: string;
  signature: string;
  start: number;
}

/**
 * DO NOT OPEN on an EVM chain running Zama's FHEVM.
 *
 * Every decryption goes through the relayer. Private ones (shake) are re-encrypted for a
 * key made in this session and authorised by an EIP-712 signature. Public ones (open,
 * alive check, duel) come back with a KMS proof that this adapter sends to the contract.
 */
/** Pantry.WeighIn.status, by value. */
const WEIGHING = ["none", "pending", "done"] as const;
const WEIGHED = 2;
const BUILDS: Build[] = ["thin", "normal", "chubby", "fat", "huge"];
const DISEASES: Disease[] = ["diabetic", "arthritic", "fattyLiver"];

function weighInFrom(w: { build: bigint; sick: boolean; disease: bigint; weight: bigint; tolerance: bigint }): WeighIn {
  return {
    weight: BigInt(w.weight),
    build: BUILDS[Number(w.build)]!,
    sick: Boolean(w.sick),
    disease: w.sick ? DISEASES[Number(w.disease)]! : null,
    tolerance: BigInt(w.tolerance),
  };
}

/** The contract's `Revealed` struct, as the app reads it. */
function revealedFrom(c: { seed: bigint; state: bigint; traits: bigint[]; score: bigint; affection: bigint; golden: boolean }): RevealedContents {
  return {
    seed: BigInt(c.seed),
    state: Number(c.state),
    traits: [...c.traits].map(Number),
    score: Number(c.score),
    affection: Number(c.affection),
    golden: Boolean(c.golden),
  };
}

export class EvmFhevmAdapter implements ChainAdapter {
  readonly kind = "evm" as const;

  private readonly contract: Contract;
  private readonly iface: Interface;
  private address_: Address | null = null;
  private readonly listeners = new Set<(account: Address | null) => void>();
  private relayer: Promise<Relayer> | null = null;
  private permit: Permit | null = null;
  private constants: Promise<{ fees: Fees; maxSupply: number; maxPerTx: number; milestones: number[] }> | null = null;
  private holdings: Holdings | null = null;
  /** The connected account's pending requests, read once until its next transaction. */
  private pendingCache: { account: Address; list: Promise<PendingRequest[]> } | null = null;
  private economyConstants: Promise<Omit<EconomyInfo, "wrapped" | "halvings" | "market">> | null = null;
  private paymentTokens: Promise<{ usdc: Deployed; cUsdc: Deployed }> | null = null;
  private rampFee: Promise<number> | null = null;
  /** Every contract this adapter may send to, so a receipt can be parsed whichever it hit. */
  private readonly ifaces: Interface[];
  /** Block of this account's last transaction: the API must have indexed it to be believed. */
  private minBlock = 0;

  constructor(private readonly opts: EvmAdapterOptions) {
    this.iface = new Interface(opts.abi);
    this.contract = new Contract(opts.address, this.iface, opts.readProvider);
    const e = opts.economy;
    this.ifaces = [
      this.iface,
      ...[USDC_ABI, CUSDC_ABI, ...(opts.ramp ? [opts.ramp.abi] : [])].map((abi) => new Interface(abi)),
      ...(e ? [e.croq.abi, e.cCroq.abi, e.pantry.abi, ROUTER_ABI].map((abi) => new Interface(abi)) : []),
    ];
    opts.wallet.onChange((signer) => void this.adopt(signer));
    void this.adopt(opts.wallet.current());
  }

  // --- account ---

  account(): Address | null {
    return this.address_;
  }

  wallets(): WalletOption[] {
    return this.opts.wallet.options();
  }

  async connect(walletId?: string): Promise<Address> {
    const signer = await this.opts.wallet.connect(walletId);
    await this.adopt(signer);
    return this.address_!;
  }

  async disconnect(): Promise<void> {
    await this.opts.wallet.disconnect();
    await this.adopt(null);
  }

  onAccountChange(listener: (account: Address | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async adopt(signer: Signer | null): Promise<void> {
    const next = signer ? await signer.getAddress() : null;
    if (next === this.address_) return;
    this.address_ = next;
    this.permit = null;
    this.holdings = null;
    for (const l of this.listeners) l(next);
  }

  // --- reads ---

  /**
   * Reads through the API when it has indexed at least this account's last transaction, the
   * chain otherwise: one's own action always shows at once, everyone else's within a block or two.
   */
  private async indexed<T>(read: (ix: IndexerClient) => Promise<{ block: number | null; data: T }>, fromChain: () => Promise<T>): Promise<T> {
    const ix = this.opts.indexer;
    if (ix?.available()) {
      try {
        const r = await read(ix);
        if (r.block !== null && r.block >= this.minBlock) return r.data;
        ix.nudge();
      } catch {
        // Down or unreachable: it stays aside for a while, the chain answers.
      }
    }
    return fromChain();
  }

  async collection(): Promise<CollectionInfo> {
    const payment = {
      symbol: "USDC",
      confidentialSymbol: "cUSDC",
      decimals: 6,
      faucet: this.opts.usdcFaucet ?? null,
      ramp: null,
    };
    return this.indexed((ix) => ix.collection({ payment }), () => this.collectionFromChain());
  }

  private async collectionFromChain(): Promise<CollectionInfo> {
    const c = this.contract;
    this.constants ??= Promise.all([c.mintPrice!(), c.observeFee!(), c.feedFee!(), c.paidShakeFee!(), c.maxSupply!(), c.maxPerTx!(), c.milestones!()]).then(
      ([mint, observe, feed, paidShake, maxSupply, maxPerTx, milestones]) => ({
        fees: { mint, observe, feed, paidShake },
        maxSupply: Number(maxSupply),
        maxPerTx: Number(maxPerTx),
        milestones: [...milestones].map(Number),
      }),
    );
    this.constants.catch(() => (this.constants = null));
    const ramp = this.opts.ramp;
    if (ramp) {
      this.rampFee ??= this.at(ramp).feeBps!().then(Number);
      this.rampFee.catch(() => (this.rampFee = null));
    }
    const [constants, tokenCount, reached, feeBps] = await this.reading(
      Promise.all([this.constants, c.tokenCount!(), c.milestonesReached!(), ramp ? this.rampFee : null]),
    );
    const { chain } = this.opts;
    const { milestones, ...rest } = constants;
    return {
      chain: chain.name,
      address: this.opts.address,
      explorerUrl: chain.explorerUrl ? `${chain.explorerUrl}/address/${this.opts.address}` : null,
      currency: { symbol: chain.currency.symbol, decimals: chain.currency.decimals },
      payment: {
        symbol: "USDC",
        confidentialSymbol: "cUSDC",
        decimals: 6,
        faucet: this.opts.usdcFaucet ?? null,
        ramp: feeBps === null ? null : { feeBps: Number(feeBps) },
      },
      ...rest,
      tokenCount: Number(tokenCount),
      sale: { milestones, reached: Number(reached), soldOut: Number(reached) >= milestones.length },
    };
  }

  async box(tokenId: number): Promise<BoxInfo> {
    const [b, pending] = await Promise.all([this.indexed((ix) => ix.box(tokenId), () => this.boxFromChain(tokenId)), this.myPending(tokenId)]);
    let status: BoxStatus = b.status;
    let alive: AliveCheck = b.aliveCheck;
    if (status === "sealed" && pending.some((r) => r.kind === "open")) status = "opening";
    if (alive === "none" && pending.some((r) => r.kind === "aliveCheck")) alive = "pending";
    return { ...b, mine: this.isMine(tokenId), status, aliveCheck: alive };
  }

  /** What the contract says about a box, before the account's own requests are added. */
  private async boxFromChain(tokenId: number): Promise<Omit<BoxInfo, "mine">> {
    const c = this.contract;
    const [status, aliveCheck, partner, wins, publicTraits, contents] = await this.reading(
      Promise.all([c.status!(tokenId), c.aliveCheck!(tokenId), c.partnerOf!(tokenId), c.wins!(tokenId), c.publicTraitsOf!(tokenId), c.contentsOf!(tokenId)]),
    );
    const boxStatus = BOX_STATUS[Number(status)]!;
    const mask = Number(publicTraits.mask);
    return {
      tokenId,
      status: boxStatus,
      aliveCheck: ALIVE_CHECK[Number(aliveCheck)]!,
      partner: partner.entangled ? Number(partner.partner) : null,
      wins: Number(wins),
      publicTraits: [...publicTraits.rolls].flatMap((roll: bigint, traitIndex: number) =>
        mask & (1 << traitIndex) ? [{ traitIndex, roll: Number(roll) }] : [],
      ),
      revealed: boxStatus === "revealed" ? revealedFrom(contents) : null,
    };
  }

  /** Whether the last look at the connected account's receipts found `tokenId`. */
  private isMine(tokenId: number): boolean {
    const h = this.holdings;
    return !!h && h.account === this.address_ && h.held.has(tokenId);
  }

  /**
   * Who holds a box is encrypted. The account finds its boxes by reading the transfers that
   * name it, decrypting each one's "moved" bit (only the two sides may), and replaying them in
   * order. The first look reads from the deployment; later ones only read new blocks.
   */
  async boxesOf(owner: Address): Promise<number[]> {
    const account = this.address_;
    if (!account || account.toLowerCase() !== owner.toLowerCase()) return [];
    if (this.holdings?.account !== account) {
      this.holdings = { account, block: (this.opts.deployBlock ?? 1) - 1, held: new Set(), seen: new Set() };
    }
    const h = this.holdings;
    const latest = await this.reading(this.opts.readProvider.getBlockNumber());
    if (latest > h.block) {
      const receipts = (await this.receiptsOf(account, h.block, latest)).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      const fresh = receipts.filter((r) => !h.seen.has(`${r.txHash.toLowerCase()}:${r.logIndex}`));
      const moved = await this.decryptBools(fresh.map((r) => r.moved));
      for (const r of fresh) {
        h.seen.add(`${r.txHash.toLowerCase()}:${r.logIndex}`);
        if (!moved.get(r.moved)) continue;
        if (r.from.toLowerCase() === account.toLowerCase()) h.held.delete(r.tokenId);
        if (r.to.toLowerCase() === account.toLowerCase()) h.held.add(r.tokenId);
      }
      // The same account still: a disconnect meanwhile drops it all.
      if (this.holdings === h) h.block = latest;
    }
    return [...h.held].sort((a, b) => a - b);
  }

  /**
   * The transfers naming `account` after block `after`, up to `latest`. The API serves what it
   * indexed; the few newer blocks, or everything when it is away, come from the chain.
   */
  private async receiptsOf(account: Address, after: number, latest: number): Promise<IndexedTransfer[]> {
    const out: IndexedTransfer[] = [];
    let covered = after;
    const ix = this.opts.indexer;
    if (ix?.available()) {
      try {
        const r = await ix.transfers(account, after);
        if (r.block !== null && r.block > after) {
          out.push(...r.data.filter((t) => t.block <= Math.min(r.block!, latest)));
          covered = Math.min(r.block, latest);
        }
      } catch {
        // The chain answers instead.
      }
    }
    if (latest > covered) {
      const filter = (from: string | null, to: string | null) => this.contract.filters.ConfidentialTransfer!(null, from, to);
      const logs = [...(await this.logs(filter(account, null), covered + 1, latest)), ...(await this.logs(filter(null, account), covered + 1, latest))];
      for (const l of logs) {
        const { tokenId, from, to, moved } = (l as unknown as { args: { tokenId: bigint; from: string; to: string; moved: string } }).args;
        out.push({ tokenId: Number(tokenId), from, to, moved: String(moved), block: l.blockNumber, txHash: l.transactionHash, logIndex: l.index });
      }
    }
    return out;
  }

  /** Events matching `filter` between two blocks, read in slices a public endpoint accepts.
   *  A public endpoint refuses now and then: each slice is tried a few times. */
  private async logs(filter: Parameters<Contract["queryFilter"]>[0], from: number, to: number) {
    const out = [];
    for (let lo = Math.max(0, from); lo <= to; lo += LOG_SPAN) {
      const hi = Math.min(to, lo + LOG_SPAN - 1);
      for (let attempt = 0; ; attempt++) {
        try {
          out.push(...(await this.contract.queryFilter(filter, lo, hi)));
          break;
        } catch (error) {
          if (attempt >= 3) throw this.toChainError(error);
          await sleep(1000 * (attempt + 1));
        }
      }
    }
    return out;
  }

  async boxSummaries(from: number, to: number): Promise<BoxSummary[]> {
    const list = await this.indexed((ix) => ix.boxSummaries(from, to), () => this.summariesFromChain(from, to));
    return list.map((b) => ({ ...b, mine: this.isMine(b.tokenId) }));
  }

  private async summariesFromChain(from: number, to: number): Promise<BoxSummary[]> {
    const c = this.contract;
    const out: BoxSummary[] = [];
    // The status of each box, plus the partner of the sealed ones (only they can still be
    // entangled), a chunk at a time so a public endpoint is not flooded.
    for (let lo = from; lo < to; lo += READ_CHUNK) {
      const ids = Array.from({ length: Math.min(READ_CHUNK, to - lo) }, (_, i) => lo + i);
      const statuses = (await this.reading(Promise.all(ids.map((id) => c.status!(id))))).map((s) => BOX_STATUS[Number(s)]!);
      const partners = await this.reading(
        Promise.all(ids.map((id, i) => (statuses[i] === "sealed" ? c.partnerOf!(id) : null))),
      );
      ids.forEach((id, i) => {
        const p = partners[i];
        out.push({ tokenId: id, mine: this.isMine(id), status: statuses[i]!, partner: p && p[0] ? Number(p[1]) : null });
      });
    }
    return out;
  }

  async pair(tokenA: number, tokenB: number): Promise<PairInfo> {
    return this.indexed((ix) => ix.pair(tokenA, tokenB), () => this.pairFromChain(tokenA, tokenB));
  }

  private async pairFromChain(tokenA: number, tokenB: number): Promise<PairInfo> {
    const c = this.contract;
    const [count, proposerAB, proposerBA] = await this.reading(
      Promise.all([c.duelCount!(), c.entangleProposer!(tokenA, tokenB), c.entangleProposer!(tokenB, tokenA)]),
    );
    const last = Number(count);
    const ids = Array.from({ length: Math.min(DUEL_SCAN, last) }, (_, i) => last - 1 - i);
    const duels = (await this.reading(Promise.all(ids.map((id) => c.duelInfo!(id))))).map((d, i) => duelFromView(ids[i]!, d));
    const openDuel = duels.find((d) => duelSettles(d, tokenA, tokenB)) ?? null;

    // Whether the proposer still holds the box is checked, encrypted, when it is accepted.
    let entangleProposal: PairInfo["entangleProposal"] = null;
    if (BigInt(proposerAB) !== 0n) entangleProposal = { from: tokenA, to: tokenB, proposer: proposerAB };
    else if (BigInt(proposerBA) !== 0n) entangleProposal = { from: tokenB, to: tokenA, proposer: proposerBA };
    return { openDuel, entangleProposal };
  }

  async balance(owner: Address): Promise<bigint> {
    return this.reading(this.opts.readProvider.getBalance(owner));
  }

  async openedCats(): Promise<OpenedCat[]> {
    return this.indexed((ix) => ix.openedCats(), () => this.openedFromChain());
  }

  private async openedFromChain(): Promise<OpenedCat[]> {
    const latest = await this.reading(this.opts.readProvider.getBlockNumber());
    const logs = await this.logs(this.contract.filters.Observed!(), this.opts.deployBlock ?? 0, latest);
    const opened = logs.map((l) => (l as unknown as { args: { tokenId: bigint; openedBy: string } }).args);
    const contents = await this.reading(Promise.all(opened.map((o) => this.contract.contentsOf!(o.tokenId))));
    return opened.map((o, i) => ({ tokenId: Number(o.tokenId), openedBy: String(o.openedBy), revealed: revealedFrom(contents[i]) }));
  }

  async usdcBalance(owner: Address): Promise<bigint> {
    const { usdc } = await this.payment();
    return this.reading(this.at(usdc).balanceOf!(owner));
  }

  async confidentialUsdcHandle(owner: Address): Promise<string> {
    const { cUsdc } = await this.payment();
    return String(await this.reading(this.at(cUsdc).confidentialBalanceOf!(owner)));
  }

  async confidentialUsdcBalance(opts?: ActionOptions): Promise<bigint> {
    const { cUsdc } = await this.payment();
    const account = await this.signer().getAddress();
    const handle: string = await this.reading(this.at(cUsdc).confidentialBalanceOf!(account));
    return this.userDecrypt64(handle, cUsdc.address, opts);
  }

  async pendingRequests(owner: Address): Promise<PendingRequest[]> {
    return this.indexed((ix) => ix.pendingRequests(owner), () => this.pendingFromChain(owner));
  }

  /**
   * Duels the account took part in, and those about the boxes it lists, newest first. Through
   * the API they are found from any device; without it, the most recent duels are scanned.
   */
  async duels(query: { account?: Address; tokenIds?: number[]; open?: boolean }): Promise<DuelInfo[]> {
    if (!query.account && !query.tokenIds?.length) return [];
    return this.indexed((ix) => ix.duels(query), () => this.duelsFromChain(query));
  }

  private async duelsFromChain(query: { account?: Address; tokenIds?: number[]; open?: boolean }): Promise<DuelInfo[]> {
    const tokens = new Set(query.tokenIds ?? []);
    return (await this.recentDuels()).filter((d) => {
      const mine = sameAddress(d.challenger, query.account) || sameAddress(d.accepter, query.account) || tokens.has(d.tokenA) || (d.tokenB !== null && tokens.has(d.tokenB));
      return mine && (!query.open || duelUnderway(d));
    });
  }

  async duelShelf(): Promise<DuelInfo[]> {
    return this.indexed(
      (ix) => ix.duelShelf(),
      async () => (await this.recentDuels()).filter((d) => onShelf(d)),
    );
  }

  /** The latest duels, newest first, a chunk at a time, no further back than a public endpoint should be asked. */
  private async recentDuels(): Promise<DuelInfo[]> {
    const c = this.contract;
    const last = Number(await this.reading(c.duelCount!()));
    const out: DuelInfo[] = [];
    for (let hi = last; hi > Math.max(0, last - DUEL_SCAN * 5); hi -= READ_CHUNK) {
      const ids = Array.from({ length: Math.min(READ_CHUNK, hi) }, (_, i) => hi - 1 - i);
      const rows = await this.reading(Promise.all(ids.map((id) => c.duelInfo!(id))));
      rows.forEach((d, i) => out.push(duelFromView(ids[i]!, d)));
    }
    return out;
  }

  private async duelInfo(duelId: number): Promise<DuelInfo> {
    return duelFromView(duelId, await this.reading(this.contract.duelInfo!(duelId)));
  }

  private async pendingFromChain(owner: Address): Promise<PendingRequest[]> {
    const filter = this.contract.filters.RequestPlaced!(null, null, owner);
    const latest = await this.reading(this.opts.readProvider.getBlockNumber());
    return this.pendingAmong(await this.logs(filter, this.opts.deployBlock ?? 0, latest));
  }

  /** The connected account's pending requests about one box. */
  private async myPending(tokenId: number): Promise<PendingRequest[]> {
    const account = this.address_;
    if (!account) return [];
    if (this.pendingCache?.account !== account) {
      const list = this.pendingRequests(account);
      list.catch(() => (this.pendingCache = null));
      this.pendingCache = { account, list };
    }
    return (await this.pendingCache.list).filter((r) => r.tokenId === tokenId);
  }

  private async pendingAmong(logs: Awaited<ReturnType<EvmFhevmAdapter["logs"]>>): Promise<PendingRequest[]> {
    const ids = logs.map((l) => Number((l as unknown as { args: { requestId: bigint } }).args.requestId));
    const rows = await this.reading(Promise.all(ids.map((id) => this.contract.requestInfo!(id))));
    return rows.flatMap((r, i) =>
      Number(r.requestStatus) === REQUEST_PENDING
        ? [{ requestId: ids[i]!, kind: REQUEST_KINDS[Number(r.kind)]!, tokenId: Number(r.tokenId), other: Number(r.other) ? Number(r.other) - 1 : null }]
        : [],
    );
  }

  /** The payment tokens, read once from the collection: it is the one that knows what it takes. */
  private payment(): Promise<{ usdc: Deployed; cUsdc: Deployed }> {
    this.paymentTokens ??= Promise.all([this.contract.usdc!(), this.contract.confidentialUsdc!()]).then(([usdc, cUsdc]) => ({
      usdc: { address: String(usdc), abi: USDC_ABI },
      cUsdc: { address: String(cUsdc), abi: CUSDC_ABI },
    }));
    this.paymentTokens.catch(() => (this.paymentTokens = null));
    return this.reading(this.paymentTokens);
  }

  // --- actions ---

  /**
   * Gets `amount` ready in cUSDC before a paid call: the collection must be the account's
   * cUSDC operator, and the balance must cover it. With `pay: "usdc"`, the amount is shielded
   * from plain USDC first, which is public.
   */
  private async prepay(opts: PayOptions | undefined, amount: bigint): Promise<void> {
    const { cUsdc } = await this.payment();
    const account = await this.signer().getAddress();
    if (opts?.pay === "usdc") await this.shieldUsdc(amount, opts);
    else if ((await this.confidentialUsdcBalance(opts)) < amount) {
      throw new ChainError("unpaid", "The cUSDC balance does not cover the price. Shield some USDC first.");
    }
    await this.ensureOperator(cUsdc, account, this.opts.address, opts);
  }

  /** Sends a request and proves it at once. Throws `not-yours` when it was refused. */
  private async request(opts: ActionOptions | undefined, call: (c: Contract) => Promise<ContractTransactionResponse>): Promise<number> {
    const receipt = await this.send(opts, call);
    const requestId = Number(this.events(receipt, "RequestPlaced")[0]!.requestId);
    await this.finishRequest(requestId, opts);
    return requestId;
  }

  async finishRequest(requestId: number, opts?: ActionOptions): Promise<void> {
    const info = await this.reading(this.contract.requestInfo!(requestId));
    if (Number(info.requestStatus) === REQUEST_PENDING) {
      const decrypted = await this.publicDecrypt([...info.handles].map(String), opts);
      opts?.onStep?.("proving");
      await this.send(opts, (c) => c.finalize!(requestId, decrypted.abiEncodedClearValues, decrypted.decryptionProof), false);
    }
    if (Number((await this.reading(this.contract.requestInfo!(requestId))).requestStatus) === REQUEST_REFUSED) {
      throw new ChainError("not-yours", "This box is not yours, or the fee did not go through. Nothing happened.");
    }
  }

  async faucetUsdc(opts?: ActionOptions): Promise<void> {
    const amount = this.opts.usdcFaucet;
    if (!amount) throw new ChainError("unknown", "There is no USDC faucet on this network.");
    const { usdc } = await this.payment();
    const account = await this.signer().getAddress();
    await this.send(opts, () => this.writer(usdc).mint!(account, amount));
  }

  async shieldUsdc(amount: bigint, opts?: ActionOptions): Promise<void> {
    const { usdc, cUsdc } = await this.payment();
    const account = await this.signer().getAddress();
    const held: bigint = await this.reading(this.at(usdc).balanceOf!(account));
    if (held < amount) throw new ChainError("insufficient-usdc", "This wallet does not hold enough USDC.");
    await this.ensureAllowance(usdc, cUsdc.address, account, amount, opts);
    await this.send(opts, () => this.writer(cUsdc).wrap!(account, amount));
  }

  private theRamp(): Deployed {
    const ramp = this.opts.ramp;
    if (!ramp) throw new ChainError("unknown", "USDC cannot be bought through the site on this network.");
    return ramp;
  }

  async quoteUsdc(coinIn: bigint): Promise<{ usdcOut: bigint; fee: bigint }> {
    if (coinIn <= 0n) return { usdcOut: 0n, fee: 0n };
    const [usdcOut, fee] = await this.reading(this.at(this.theRamp()).quote!(coinIn));
    return { usdcOut: BigInt(usdcOut), fee: BigInt(fee) };
  }

  async buyUsdc(coinIn: bigint, shield: boolean, opts?: ActionOptions): Promise<void> {
    const ramp = this.theRamp();
    const minOut = ((await this.quoteUsdc(coinIn)).usdcOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
    await this.send(opts, () => this.writer(ramp).buy!(minOut, shield, deadline, { value: coinIn }));
  }

  async mint(quantity: number, opts?: MintOptions): Promise<number[]> {
    const { fees, maxPerTx } = await this.collection();
    const ids = Math.min(maxPerTx, Math.max(quantity, opts?.ids ?? maxPerTx));
    await this.prepay(opts, fees.mint * BigInt(quantity));
    const account = await this.signer().getAddress();
    opts?.onStep?.("encrypting");
    let input;
    try {
      input = await (await this.loadRelayer()).createEncryptedInput(this.opts.address, account).add8(quantity).encrypt();
    } catch (error) {
      throw new ChainError("decryption", `Could not encrypt the quantity: ${(error as Error)?.message ?? "unknown error"}`);
    }
    const receipt = await this.send(opts, (c) => c.mint!(input.handles[0], input.inputProof, ids));
    // The new ids that are the account's: its receipts say, and only it can read them.
    const transfers = this.events(receipt, "ConfidentialTransfer");
    const moved = await this.decryptBools(transfers.map((t) => String(t.moved)), opts);
    const owned = transfers.filter((t) => moved.get(String(t.moved))).map((t) => Number(t.tokenId));
    if (this.holdings?.account === account) for (const id of owned) this.holdings.held.add(id);
    if (!owned.length) throw new ChainError("unpaid", "No box this time: sold out, or the cUSDC did not cover it. Nothing was taken.");
    // Rare: this mint reached the next milestone. Announce it while we are here.
    await this.announceMilestone(opts).catch(() => false);
    return owned;
  }

  async announceMilestone(opts?: ActionOptions): Promise<boolean> {
    const handle: string = await this.reading(this.contract.milestoneHandle!());
    if (handle === ZERO_HANDLE) return false;
    const decrypted = await this.publicDecrypt([handle], opts);
    if (!decrypted.clearValues[handle as `0x${string}`]) return false;
    opts?.onStep?.("proving");
    await this.send(opts, (c) => c.announceMilestone!(decrypted.abiEncodedClearValues, decrypted.decryptionProof), false);
    return true;
  }

  async shake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll> {
    await this.send(opts, (c) => c.shake!(tokenId));
    const roll = await this.readShake(tokenId, opts);
    if (!roll) throw new ChainError("not-yours", "This box is not yours: shaking it showed nothing.");
    return roll;
  }

  async paidShake(tokenId: number, opts?: PayOptions): Promise<TraitRoll> {
    const { fees } = await this.collection();
    await this.prepay(opts, fees.paidShake);
    await this.send(opts, (c) => c.paidShake!(tokenId));
    const roll = await this.readShake(tokenId, opts);
    if (!roll) throw new ChainError("unpaid", "The fee did not go through: the shake showed nothing.");
    return roll;
  }

  async feed(tokenId: number, opts?: PayOptions): Promise<void> {
    const { fees } = await this.collection();
    await this.prepay(opts, fees.feed);
    await this.send(opts, (c) => c.feed!(tokenId));
  }

  async proveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean> {
    await this.request(opts, (c) => c.proveAlive!(tokenId));
    return Number(await this.reading(this.contract.aliveCheck!(tokenId))) === 1;
  }

  async finishProveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean> {
    for (const r of await this.myPending(tokenId)) if (r.kind === "aliveCheck") await this.finishRequest(r.requestId, opts);
    return Number(await this.reading(this.contract.aliveCheck!(tokenId))) === 1;
  }

  async observe(tokenId: number, opts?: PayOptions): Promise<BoxInfo[]> {
    const { fees } = await this.collection();
    // Only a holder is charged: a refused opening costs nothing but gas.
    await this.prepay(opts, fees.observe);
    await this.request(opts, (c) => c.observe!(tokenId));
    return this.withPartner(tokenId);
  }

  async finishObserve(tokenId: number, opts?: ActionOptions): Promise<BoxInfo[]> {
    for (const r of await this.myPending(tokenId)) if (r.kind === "open") await this.finishRequest(r.requestId, opts);
    return this.withPartner(tokenId);
  }

  private async withPartner(tokenId: number): Promise<BoxInfo[]> {
    const first = await this.box(tokenId);
    return first.partner === null ? [first] : [first, await this.box(first.partner)];
  }

  async proposeEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void> {
    await this.send(opts, (c) => c.proposeEntangle!(tokenA, tokenB));
  }

  async acceptEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void> {
    await this.request(opts, (c) => c.acceptEntangle!(tokenA, tokenB));
  }

  async postDuel(tokenA: number, opts?: PostDuelOptions): Promise<DuelInfo> {
    const reserved = opts?.reservedFor !== undefined;
    const receipt = await this.send(opts, (c) => c.postDuel!(tokenA, opts?.reservedFor ?? 0, reserved));
    const duelId = Number(this.events(receipt, "DuelPosted")[0]!.duelId);
    await this.finishDuel(duelId, opts);
    const duel = await this.duelInfo(duelId);
    if (duel.status === "void") throw new ChainError("not-yours", "This box is not yours: it did not go on the duel shelf.");
    return duel;
  }

  async cancelDuel(duelId: number, opts?: ActionOptions): Promise<void> {
    await this.send(opts, (c) => c.cancelDuel!(duelId));
  }

  async acceptDuel(duelId: number, tokenB: number, opts?: ActionOptions): Promise<DuelResult | null> {
    await this.send(opts, (c) => c.acceptDuel!(duelId, tokenB));
    const result = await this.finishDuel(duelId, opts);
    if (!result && (await this.duelInfo(duelId)).status === "open") {
      throw new ChainError("not-yours", "This box is not yours: the duel went back on the shelf.");
    }
    return result;
  }

  async finishDuel(duelId: number, opts?: ActionOptions): Promise<DuelResult | null> {
    const { status } = await this.duelInfo(duelId);
    if (status !== "posted" && status !== "pending") throw new ChainError("reverted", "This duel is not waiting for a proof.", "WrongDuelStatus");
    const handles: string[] = [...(await this.reading(this.contract.duelHandles!(duelId)))];
    const decrypted = await this.publicDecrypt(handles, opts);
    opts?.onStep?.("proving");
    const receipt = await this.send(opts, (c) => c.finalizeDuel!(duelId, decrypted.abiEncodedClearValues, decrypted.decryptionProof), false);
    const e = this.events(receipt, "DuelResolved")[0];
    if (!e) return null;
    return {
      duelId,
      winner: Number(e.winnerTokenId),
      loser: Number(e.loserTokenId),
      shown: { traitIndex: Number(e.revealedTraitIndex), roll: Number(e.revealedTraitRoll) },
    };
  }

  async claimEarnings(tokenIds: number[], opts?: ActionOptions): Promise<bigint> {
    const before = await this.confidentialUsdcBalance(opts);
    await this.send(opts, (c) => c.claimEarnings!(tokenIds));
    return (await this.confidentialUsdcBalance(opts)) - before;
  }

  async sendBox(tokenId: number, to: Address, opts?: ActionOptions): Promise<void> {
    const account = await this.signer().getAddress();
    await this.send(opts, (c) => c["confidentialTransfer(address,uint256)"]!(to, tokenId));
    // Read the receipt back: if the box was the account's, it is gone now.
    if (this.holdings?.account === account) await this.boxesOf(account);
  }

  // --- croquettes ---

  private eco(): EconomyDeployment {
    const e = this.opts.economy;
    if (!e) throw new ChainError("unknown", "The croquette economy is not deployed on this network.");
    return e;
  }

  private at(deployed: Deployed | string, abi?: InterfaceAbi): Contract {
    return typeof deployed === "string" ? new Contract(deployed, abi!, this.opts.readProvider) : new Contract(deployed.address, deployed.abi, this.opts.readProvider);
  }

  private link(address: string): string | null {
    const explorer = this.opts.chain.explorerUrl;
    return explorer ? `${explorer}/address/${address}` : null;
  }

  async economy(): Promise<EconomyInfo> {
    const e = this.eco();
    const links = { croq: this.link(e.croq.address), cCroq: this.link(e.cCroq.address), pantry: this.link(e.pantry.address) };
    return this.indexed((ix) => ix.economy({ links }), () => this.economyFromChain());
  }

  private async economyFromChain(): Promise<EconomyInfo> {
    const e = this.eco();
    const pantry = this.at(e.pantry);
    const croq = this.at(e.croq);
    this.economyConstants ??= Promise.all([
      croq.totalSupply!(),
      pantry.welcomeBag!(),
      pantry.purrMaxPerDay!(),
      pantry.vetMultiplier!(),
      pantry.purrMaxDays!(),
      pantry.halvingPeriod!(),
      pantry.mealsPerDay!(),
      pantry.maxEatenPerDay!(),
      pantry.mealTreasuryBps!(),
      pantry.mealBurnBps!(),
      pantry.maxBoxesPerClaim!(),
    ]).then(([totalSupply, welcomeBag, purrMaxPerDay, vetMultiplier, purrMaxDays, halvingPeriod, mealsPerDay, maxEatenPerDay, mealTreasuryBps, mealBurnBps, maxBoxesPerClaim]) => ({
      symbol: "CROQ",
      confidentialSymbol: "cCROQ",
      totalSupply,
      welcomeBag: Number(welcomeBag),
      purrMaxPerDay: Number(purrMaxPerDay),
      vetMultiplier: Number(vetMultiplier),
      purrMaxDays: Number(purrMaxDays),
      halvingPeriod: Number(halvingPeriod),
      mealsPerDay: Number(mealsPerDay),
      maxEatenPerDay: BigInt(maxEatenPerDay),
      mealTreasuryBps: Number(mealTreasuryBps),
      mealBurnBps: Number(mealBurnBps),
      maxBoxesPerClaim: Number(maxBoxesPerClaim),
      links: { croq: this.link(e.croq.address), cCroq: this.link(e.cCroq.address), pantry: this.link(e.pantry.address) },
    }));
    this.economyConstants.catch(() => (this.economyConstants = null));

    const market = e.market;
    const [constants, wrapped, halvings, reserves, token0] = await this.reading(
      Promise.all([
        this.economyConstants,
        croq.balanceOf!(e.cCroq.address),
        pantry.halvings!(),
        market ? this.at(market.pair, PAIR_ABI).getReserves!() : null,
        market ? this.at(market.pair, PAIR_ABI).token0!() : null,
      ]),
    );
    const croqFirst = token0 && String(token0).toLowerCase() === e.croq.address.toLowerCase();
    return {
      ...constants,
      wrapped,
      halvings: Number(halvings),
      market:
        market && reserves
          ? {
              name: "Uniswap V2",
              poolUrl: this.link(market.pair),
              appUrl: `https://app.uniswap.org/swap?chain=sepolia&inputCurrency=${market.usdc}&outputCurrency=${e.croq.address}`,
              quote: { symbol: "USDC", decimals: 6 },
              croqReserve: croqFirst ? reserves[0] : reserves[1],
              quoteReserve: croqFirst ? reserves[1] : reserves[0],
            }
          : null,
    };
  }

  async boxPantry(tokenId: number): Promise<BoxPantry> {
    this.eco();
    return this.indexed((ix) => ix.boxPantry(tokenId), () => this.pantryFromChain(tokenId));
  }

  private async pantryFromChain(tokenId: number): Promise<BoxPantry> {
    const pantry = this.at(this.eco().pantry);
    const [lastPurr, nextClaimAt, w] = await this.reading(
      Promise.all([pantry.lastPurr!(tokenId), pantry.nextClaimAt!(tokenId), pantry.weighIn!(tokenId)]),
    );
    const status = Number(w.status);
    return {
      welcomed: BigInt(lastPurr) !== 0n,
      nextClaimAt: Number(nextClaimAt),
      weighing: WEIGHING[status] ?? "none",
      weighIn: status === WEIGHED ? weighInFrom(w) : null,
    };
  }

  async croqBalance(owner: Address): Promise<bigint> {
    return this.reading(this.at(this.eco().croq).balanceOf!(owner));
  }

  async confidentialBalance(opts?: ActionOptions): Promise<bigint> {
    const account = await this.signer().getAddress();
    const handle: string = await this.reading(this.at(this.eco().cCroq).confidentialBalanceOf!(account));
    return this.userDecrypt64(handle, this.eco().cCroq.address, opts);
  }

  /** Decrypts a euint64 the connected account is allowed on. A zero handle is 0. */
  private async userDecrypt64(handle: string, contractAddress: string, opts?: ActionOptions): Promise<bigint> {
    if (handle === ZERO_HANDLE) return 0n;
    return BigInt((await this.userDecrypt([handle], contractAddress, opts))[handle] as bigint);
  }

  /** Decrypts handles of one contract the connected account is allowed on, with its session permit. */
  private async userDecrypt(handles: string[], contractAddress: string, opts?: ActionOptions) {
    const signer = this.signer();
    const account = await signer.getAddress();
    const values = await this.decrypting(opts, async (relayer) => {
      const permit = await this.permitFor(relayer, signer, account, opts);
      return relayer.userDecrypt(
        handles.map((handle) => ({ handle, contractAddress })),
        permit.privateKey,
        permit.publicKey,
        permit.signature.replace("0x", ""),
        await this.permitContracts(),
        account,
        permit.start,
        PERMIT_DAYS,
      );
    });
    return values as Record<string, bigint | boolean | string>;
  }

  /** Decrypts "moved" bits of the collection, in batches. Handle -> value. */
  private async decryptBools(handles: string[], opts?: ActionOptions): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const unique = [...new Set(handles)];
    for (let i = 0; i < unique.length; i += DECRYPT_BATCH) {
      const batch = unique.slice(i, i + DECRYPT_BATCH);
      const clear = await this.userDecrypt(batch, this.opts.address, opts);
      for (const h of batch) out.set(h, clear[h] === true || clear[h] === 1n || clear[h] === "true");
    }
    return out;
  }

  async claimCroquettes(tokenIds: number[], opts?: ActionOptions): Promise<void> {
    const pantry = this.eco().pantry;
    await this.send(opts, () => this.writer(pantry).claim!(tokenIds));
  }

  async feedCroquettes(tokenId: number, amount: bigint, opts?: ActionOptions): Promise<void> {
    const e = this.eco();
    const account = await this.signer().getAddress();
    await this.ensureOperator(e.cCroq, account, e.pantry.address, opts);
    const input = await this.encrypt64(e.pantry.address, account, amount, opts);
    await this.send(opts, () => this.writer(e.pantry).feed!(tokenId, input.handles[0], input.inputProof));
  }

  async pantryDay(tokenId: number, opts?: ActionOptions): Promise<PantryDay> {
    const pantry = this.eco().pantry;
    const account = await this.signer().getAddress();
    const [meals, eaten]: [string, string] = await this.reading(this.at(pantry).todayHandles!(tokenId, account));
    if (meals === ZERO_HANDLE) return { meals: 0, eaten: 0n };
    const clear = await this.userDecrypt([meals, eaten], pantry.address, opts);
    return { meals: Number(clear[meals]), eaten: BigInt(clear[eaten] as bigint) };
  }

  async weigh(tokenId: number, opts?: ActionOptions): Promise<WeighIn> {
    const pantry = this.eco().pantry;
    // A weighing left pending only needs its proof.
    if ((await this.boxPantry(tokenId)).weighing === "none") await this.send(opts, () => this.writer(pantry).weigh!(tokenId));
    const after = await this.boxPantry(tokenId);
    if (after.weighIn) return after.weighIn;
    const handle: string = await this.reading(this.at(pantry).weightHandle!(tokenId));
    const decrypted = await this.publicDecrypt([handle], opts);
    opts?.onStep?.("proving");
    await this.send(opts, () => this.writer(pantry).finalizeWeigh!(tokenId, decrypted.abiEncodedClearValues, decrypted.decryptionProof), false);
    const done = await this.boxPantry(tokenId);
    if (!done.weighIn) throw new ChainError("unknown", "The weigh-in was not recorded.");
    return done.weighIn;
  }

  async wrap(amount: bigint, opts?: ActionOptions): Promise<void> {
    const e = this.eco();
    const account = await this.signer().getAddress();
    await this.ensureAllowance(e.croq, e.cCroq.address, account, amount, opts);
    await this.send(opts, () => this.writer(e.cCroq).wrap!(account, amount));
  }

  async unwrap(amount: bigint, opts?: ActionOptions): Promise<void> {
    const e = this.eco();
    const account = await this.signer().getAddress();
    const input = await this.encrypt64(e.cCroq.address, account, amount, opts);
    const receipt = await this.send(opts, () => this.writer(e.cCroq)["unwrap(address,address,bytes32,bytes)"]!(account, account, input.handles[0], input.inputProof));
    const requested = this.events(receipt, "UnwrapRequested", e.cCroq.address)[0];
    if (!requested) throw new ChainError("unknown", "The unwrap request was not found in the receipt.");
    const requestId: string = requested.unwrapRequestId;
    const decrypted = await this.publicDecrypt([requestId], opts);
    const cleartext = BigInt(decrypted.clearValues[requestId as `0x${string}`] as bigint);
    opts?.onStep?.("proving");
    await this.send(opts, () => this.writer(e.cCroq).finalizeUnwrap!(requestId, cleartext, decrypted.decryptionProof), false);
  }

  async sendCroquettes(to: Address, amount: bigint, opts?: ActionOptions): Promise<void> {
    const e = this.eco();
    const account = await this.signer().getAddress();
    const input = await this.encrypt64(e.cCroq.address, account, amount, opts);
    await this.send(opts, () => this.writer(e.cCroq)["confidentialTransfer(address,bytes32,bytes)"]!(to, input.handles[0], input.inputProof));
  }

  async quote(side: TradeSide, amountIn: bigint): Promise<bigint> {
    const { market, croq } = this.eco();
    if (!market) throw new ChainError("unknown", "There is no market on this network.");
    if (amountIn <= 0n) return 0n;
    const path = side === "buy" ? [market.usdc, croq.address] : [croq.address, market.usdc];
    const amounts: bigint[] = await this.reading(this.at(market.router, ROUTER_ABI).getAmountsOut!(amountIn, path));
    return amounts[amounts.length - 1]!;
  }

  async trade(side: TradeSide, amountIn: bigint, opts?: ActionOptions): Promise<void> {
    const { market, croq } = this.eco();
    if (!market) throw new ChainError("unknown", "There is no market on this network.");
    const account = await this.signer().getAddress();
    const minOut = ((await this.quote(side, amountIn)) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
    const router = this.writer({ address: market.router, abi: ROUTER_ABI });
    const [tokenIn, tokenOut] = side === "buy" ? [{ address: market.usdc, abi: USDC_ABI }, croq] : [croq, { address: market.usdc, abi: USDC_ABI }];
    if (side === "buy" && (await this.reading(this.at(tokenIn).balanceOf!(account))) < amountIn) {
      throw new ChainError("insufficient-usdc", "This wallet does not hold enough USDC.");
    }
    await this.ensureAllowance(tokenIn, market.router, account, amountIn, opts);
    await this.send(opts, () => router.swapExactTokensForTokens!(amountIn, minOut, [tokenIn.address, tokenOut.address], account, deadline));
  }

  private writer(deployed: Deployed): Contract {
    return new Contract(deployed.address, deployed.abi, this.signer());
  }

  private async ensureAllowance(token: Deployed, spender: string, account: Address, amount: bigint, opts?: ActionOptions): Promise<void> {
    const allowance: bigint = await this.reading(this.at(token).allowance!(account, spender));
    if (allowance >= amount) return;
    await this.send(opts, () => this.writer(token).approve!(spender, amount));
  }

  /** ERC-7984 has no allowances: the Pantry, or the collection, must be an operator to pull a
   *  payment. Asked once a year. */
  private async ensureOperator(token: Deployed, account: Address, operator: string, opts?: ActionOptions): Promise<void> {
    if (await this.reading(this.at(token).isOperator!(account, operator))) return;
    const until = Math.floor(Date.now() / 1000) + OPERATOR_DAYS * 86_400;
    await this.send(opts, () => this.writer(token).setOperator!(operator, until));
  }

  /** Encrypts one 64-bit amount, in this page, for `contract` and `account` only. */
  private async encrypt64(contract: string, account: Address, amount: bigint, opts?: ActionOptions) {
    if (amount < 0n || amount >= 1n << 64n) throw new ChainError("unknown", "That amount does not fit.");
    opts?.onStep?.("encrypting");
    try {
      const relayer = await this.loadRelayer();
      return await relayer.createEncryptedInput(contract, account).add64(amount).encrypt();
    } catch (error) {
      throw new ChainError("decryption", `Could not encrypt the amount: ${(error as Error)?.message ?? "unknown error"}`);
    }
  }

  /** Contracts a user-decryption permit covers: the boxes, cUSDC balances, and with croquettes,
   *  cCROQ balances and what a feeder gave a cat today. */
  private async permitContracts(): Promise<string[]> {
    const e = this.opts.economy;
    const { cUsdc } = await this.payment();
    return [this.opts.address, cUsdc.address, ...(e ? [e.cCroq.address, e.pantry.address] : [])];
  }

  // --- internals ---

  private signer(): Signer {
    const signer = this.opts.wallet.current();
    if (!signer) throw new ChainError("not-connected", "Connect a wallet first.");
    return signer;
  }

  /** Sends one transaction and waits until the read provider has seen its block. */
  private async send(
    opts: ActionOptions | undefined,
    call: (contract: Contract) => Promise<ContractTransactionResponse>,
    announce = true,
  ): Promise<ContractTransactionReceipt> {
    const signer = this.signer();
    let sent: TxRecord | null = null;
    try {
      if (announce) opts?.onStep?.("wallet");
      const tx = await call(this.contract.connect(signer) as Contract);
      if (announce) opts?.onStep?.("confirming");
      const explorer = this.opts.chain.explorerUrl;
      sent = { hash: tx.hash, call: this.callName(tx.data), status: "sent", url: explorer ? `${explorer}/tx/${tx.hash}` : null };
      opts?.onTx?.(sent);
      const receipt = await tx.wait();
      // Whatever it was, it may have placed or settled a request.
      this.pendingCache = null;
      if (!receipt || receipt.status !== 1) throw new ChainError("reverted", "The transaction failed on-chain.");
      opts?.onTx?.({ ...sent, status: "confirmed", block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      // Until the API has indexed this block, reads go to the chain; and it is told to look now.
      this.minBlock = Math.max(this.minBlock, receipt.blockNumber);
      this.opts.indexer?.nudge();
      await this.caughtUp(receipt.blockNumber);
      return receipt;
    } catch (error) {
      if (sent) opts?.onTx?.({ ...sent, status: "failed" });
      throw this.toChainError(error);
    }
  }

  /** Public RPC endpoints sit behind load balancers: a read can land on a node that is a block late. */
  private async caughtUp(blockNumber: number): Promise<void> {
    for (let i = 0; i < 30; i++) {
      if ((await this.opts.readProvider.getBlockNumber()) >= blockNumber) return;
      await sleep(1000);
    }
  }

  private async reading<T>(read: Promise<T>): Promise<T> {
    try {
      return await read;
    } catch (error) {
      throw this.toChainError(error);
    }
  }

  private callName(data: string): string {
    for (const iface of this.ifaces) {
      const parsed = iface.parseTransaction({ data });
      if (parsed) return parsed.name;
    }
    return "?";
  }

  private events(receipt: ContractTransactionReceipt, name: string, address: string = this.opts.address) {
    const iface = address === this.opts.address ? this.iface : this.ifaces.find((i) => i.getEvent(name)) ?? this.iface;
    return receipt.logs.flatMap((log) => {
      if (log.address.toLowerCase() !== address.toLowerCase()) return [];
      const parsed = iface.parseLog(log);
      return parsed?.name === name ? [parsed.args] : [];
    });
  }

  private loadRelayer(): Promise<Relayer> {
    this.relayer ??= this.opts.loadRelayer();
    this.relayer.catch(() => (this.relayer = null));
    return this.relayer;
  }

  /**
   * The coprocessor computes ciphertexts a few seconds after the transaction that asked
   * for them, so a decryption requested right away can be told "not ready". Retry a few times.
   */
  private async decrypting<T>(opts: ActionOptions | undefined, run: (relayer: Relayer) => Promise<T>): Promise<T> {
    opts?.onStep?.("decrypting");
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await run(await this.loadRelayer());
      } catch (error) {
        if (error instanceof ChainError || isError(error, "ACTION_REJECTED")) throw this.toChainError(error);
        last = error;
        await sleep(3000 + attempt * 2000);
      }
    }
    throw new ChainError("decryption", `The decryption service did not answer: ${(last as Error)?.message ?? "unknown error"}`);
  }

  private publicDecrypt(handles: string[], opts?: ActionOptions) {
    return this.decrypting(opts, (relayer) => relayer.publicDecrypt(handles));
  }

  /** Decrypts the caller's latest shake of a box: the picked trait and its roll. Null when the
   *  shake showed nothing (not the holder, or an unpaid paid shake). */
  private async readShake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll | null> {
    const account = await this.signer().getAddress();
    const [pick, roll]: [string, string] = await this.reading(this.contract.lastShake!(tokenId, account));
    const clear = await this.userDecrypt([pick, roll], this.opts.address, opts);
    if (Number(clear[pick]) === NOT_YOURS) return null;
    return { traitIndex: traitIndexAtOffset(Number(clear[pick])), roll: Number(clear[roll]) };
  }

  /**
   * One EIP-712 signature lets the relayer re-encrypt, for a key that lives only in this
   * page, whatever the account is already allowed to read on this contract. It is kept in
   * memory so the wallet prompts once per session, not once per shake.
   */
  private async permitFor(relayer: Relayer, signer: Signer, account: Address, opts?: ActionOptions): Promise<Permit> {
    const now = Math.floor(Date.now() / 1000);
    const p = this.permit;
    if (p && p.account === account && now < p.start + PERMIT_DAYS * 86_400 - 600) return p;

    const keypair = relayer.generateKeypair();
    const eip712 = relayer.createEIP712(keypair.publicKey, await this.permitContracts(), now, PERMIT_DAYS);
    opts?.onStep?.("wallet");
    const signature = await signer.signTypedData(
      eip712.domain as never,
      { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification } as never,
      eip712.message as never,
    );
    opts?.onStep?.("decrypting");
    this.permit = { account, publicKey: keypair.publicKey, privateKey: keypair.privateKey, signature, start: now };
    return this.permit;
  }

  private toChainError(error: unknown): ChainError {
    if (error instanceof ChainError) return error;
    if (isError(error, "ACTION_REJECTED")) return new ChainError("rejected", "The request was declined in the wallet.");
    if (isError(error, "INSUFFICIENT_FUNDS")) return new ChainError("insufficient-funds", "Not enough funds for this transaction.");
    if (isError(error, "CALL_EXCEPTION")) {
      let reason = error.revert?.name;
      if (!reason && error.data && error.data !== "0x") {
        for (const iface of this.ifaces) {
          try {
            reason = iface.parseError(error.data)?.name;
          } catch {
            // Not one of this contract's errors.
          }
          if (reason) break;
        }
      }
      return new ChainError("reverted", reason ? `The contract refused: ${reason}.` : (error.shortMessage ?? "The contract refused."), reason);
    }
    const e = error as { shortMessage?: string; message?: string; info?: { error?: { code?: number } } };
    if (e.info?.error?.code === 4001) return new ChainError("rejected", "The request was declined in the wallet.");
    return new ChainError("unknown", e.shortMessage ?? e.message ?? "Something went wrong.");
  }
}
