import {
  AbiCoder,
  Contract,
  getAddress,
  keccak256,
  type ContractTransactionReceipt,
  type ContractTransactionResponse,
  type EventLog,
  type InterfaceAbi,
  type Provider,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import { ChainError, sameAddress, type ActionOptions, type Address, type TxRecord } from "../types";
import { decoySends } from "../decoys";
import type {
  VaultAdapter,
  VaultBox,
  VaultBoxState,
  VaultCollection,
  VaultDepositOptions,
  VaultInfo,
  VaultListing,
  VaultOffer,
  VaultSale,
  VaultSaleStatus,
} from "../vault";
import type { VaultRelay } from "./vaultRelay";

interface Deployed {
  address: string;
  abi: InterfaceAbi;
}

/** The vault, as `dno:export` writes it next to the collection's deployment. */
export interface VaultDeployment extends Deployed {
  deployBlock?: number | null;
  seaport: string;
  /** VaultOffers: fills the offers the vault accepts, and the board buyers post them to. */
  offers: Deployed & { deployBlock?: number | null };
  weth: string;
  delegateRegistry: string;
  collections: VaultCollection[];
}

type InputBuilder = { addBool(v: boolean): InputBuilder; add64(v: bigint): InputBuilder; add256(v: bigint): InputBuilder };
type Encrypted = { handles: (string | Uint8Array)[]; inputProof: string | Uint8Array };

/** What the vault borrows from the EVM adapter it sits in: its wallet, its sends and its decryptions. */
export interface EvmVaultTools {
  chainId: number;
  explorerUrl: string | null;
  marketplaceUrl: string | null;
  readProvider: Provider;
  account(): Promise<Address>;
  send(opts: ActionOptions | undefined, call: () => Promise<ContractTransactionResponse>): Promise<ContractTransactionReceipt>;
  writer(deployed: Deployed): Contract;
  reading<T>(read: Promise<T>): Promise<T>;
  encrypt(contract: string, account: Address, fill: (b: InputBuilder) => InputBuilder, what: string, opts?: ActionOptions, inputUser?: string): Promise<Encrypted>;
  publicDecrypt(handles: string[], opts?: ActionOptions): Promise<{ abiEncodedClearValues: string; decryptionProof: string }>;
  userDecrypt(handles: string[], contractAddress: string, opts?: ActionOptions): Promise<Record<string, unknown>>;
  signText(message: string): Promise<string>;
  signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>): Promise<string>;
  ensureOperator(token: Deployed, account: Address, operator: string, opts?: ActionOptions): Promise<void>;
  cUsdc(): Promise<Deployed>;
  /** The API's relayer, when it has one: requests are sent from its wallet. */
  relay(): Promise<VaultRelay | null>;
}

/** SealedVault's enums, in their contract order. */
const STATES: (VaultBoxState | "none")[] = ["none", "sealed", "listed", "sold", "withdrawn", "claimed"];
const ACTIONS = { withdraw: 0, list: 1, unlist: 2, claim: 3, acceptOffer: 4, delegate: 5 } as const;
const REQUEST_PENDING = 1;
const REQUEST_REFUSED = 3;
const REQUEST_STALE = 4;
/** SealedVault.REQUEST_TIMEOUT: after this, a request with no proof may be expired by anyone. */
const REQUEST_TIMEOUT = 86_400;
const SALE_STATUS: (VaultSaleStatus | "none")[] = ["none", "open", "settled", "cancelled"];
const LOG_SPAN = 40_000;
const ZERO = "0x" + "0".repeat(64);

/** The part of an ERC-721 the vault page uses; a test collection also has `mint(to, id)`. */
const NFT_ABI = [
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function mint(address to, uint256 tokenId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const ORDER_PARAMETERS =
  "(address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)";
const SEAPORT_ABI = [
  `function fulfillOrder((${ORDER_PARAMETERS} parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool)`,
  "function cancel((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)[] orders) returns (bool)",
  "function getCounter(address offerer) view returns (uint256)",
];
/** What `finalizeOffer` and `VaultOffers.fill` take: abi.encode(AdvancedOrder, bytes32[] criteriaProof). */
const ADVANCED_ORDER = `(${ORDER_PARAMETERS} parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData)`;
const WETH_ABI = [
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
/** Seaport's item types, as the offers use them. */
const ITEM = { ERC20: 1, ERC721: 2, ERC721_WITH_CRITERIA: 4 } as const;
/** Seaport 1.5's EIP-712 types: what a buyer signs. */
const SEAPORT_TYPES: Record<string, TypedDataField[]> = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};

type OfferItem = { itemType: number; token: string; identifierOrCriteria: bigint; startAmount: bigint; endAmount: bigint };
type ConsiderationItem = OfferItem & { recipient: string };
/** A Seaport order's parameters, as `OfferPosted` logs them. */
interface OrderParameters {
  offerer: string;
  zone: string;
  offer: OfferItem[];
  consideration: ConsiderationItem[];
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: string;
  salt: bigint;
  conduitKey: string;
  totalOriginalConsiderationItems: bigint;
}

/** What the wallet signs, once a session, to make its box keys. Free and off-chain. */
export const vaultKeyMessage = (vault: string, chainId: number) =>
  `DO NOT OPEN vault key\n\nThis signature makes the key to your boxes in the vault. Anyone who has it can take your NFTs out: sign it only on DO NOT OPEN.\n\nVault: ${vault}\nChain: ${chainId}`;

/**
 * The sealed vault on an EVM chain. A box's key is derived from one wallet signature and the
 * NFT it holds, so it is never stored: the same wallet makes the same key on any device.
 */
export class EvmVault implements VaultAdapter {
  private readonly read: Contract;
  private readonly board: Contract;
  private master: { account: Address; secret: string } | null = null;
  private holdings: { account: Address; block: number; held: Set<number>; seen: Set<string> } | null = null;

  constructor(
    private readonly deployed: VaultDeployment,
    private readonly t: EvmVaultTools,
  ) {
    this.read = new Contract(deployed.address, deployed.abi, t.readProvider);
    this.board = new Contract(deployed.offers.address, deployed.offers.abi, t.readProvider);
  }

  async info(): Promise<VaultInfo> {
    const [feeBps, relay] = await Promise.all([this.t.reading(this.read.feeBps!()), this.t.relay()]);
    return {
      address: this.deployed.address,
      explorerUrl: this.t.explorerUrl ? `${this.t.explorerUrl}/address/${this.deployed.address}` : null,
      explorer: this.t.explorerUrl,
      marketplace: this.t.marketplaceUrl,
      feeBps: Number(feeBps),
      seaport: this.deployed.seaport,
      weth: this.deployed.weth,
      delegateRegistry: this.deployed.delegateRegistry,
      collections: this.deployed.collections,
      relayer: relay?.address ?? null,
      coin: "ETH",
    };
  }

  async boxes(): Promise<VaultBox[]> {
    const count = Number(await this.t.reading(this.read.tokenCount!()));
    const depositors = await this.depositors();
    const ids = Array.from({ length: count }, (_, i) => count - 1 - i);
    return Promise.all(ids.map((id) => this.boxAt(id, depositors.get(id) ?? null)));
  }

  async box(boxId: number): Promise<VaultBox> {
    return this.boxAt(boxId, (await this.depositors()).get(boxId) ?? null);
  }

  /** The account's boxes, from its receipts: the "moved" bits only it can decrypt. */
  async myBoxes(): Promise<number[]> {
    const account = await this.t.account();
    if (this.holdings?.account !== account) {
      this.holdings = { account, block: (this.deployed.deployBlock ?? 1) - 1, held: new Set(), seen: new Set() };
    }
    const h = this.holdings;
    const latest = await this.t.readProvider.getBlockNumber();
    if (latest > h.block) {
      const filter = this.read.filters.ConfidentialTransfer!;
      const logs = [...(await this.logs(filter(null, account, null), h.block + 1, latest)), ...(await this.logs(filter(null, null, account), h.block + 1, latest))]
        .map((l) => l as EventLog)
        .filter((l) => !h.seen.has(`${l.transactionHash}:${l.index}`))
        .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
      const handles = [...new Set(logs.map((l) => String(l.args.moved)))];
      const clear = handles.length ? await this.t.userDecrypt(handles, this.deployed.address) : {};
      for (const l of logs) {
        h.seen.add(`${l.transactionHash}:${l.index}`);
        const v = clear[String(l.args.moved)];
        if (!(v === true || v === 1n || v === "true")) continue;
        if (sameAddress(String(l.args.from), account)) h.held.delete(Number(l.args.tokenId));
        if (sameAddress(String(l.args.to), account)) h.held.add(Number(l.args.tokenId));
      }
      h.block = latest;
    }
    const held = [...h.held].sort((a, b) => a - b);
    const states = await Promise.all(held.map(async (id) => STATES[Number((await this.t.reading(this.read.boxInfo!(id))).state)]));
    return held.filter((_, i) => states[i] !== "withdrawn" && states[i] !== "claimed");
  }

  async wethBalance(owner: Address): Promise<bigint> {
    const weth = new Contract(this.deployed.weth, WETH_ABI, this.t.readProvider);
    return BigInt(await this.t.reading(weth.balanceOf!(owner)));
  }

  async walletNfts(collection: Address): Promise<bigint[]> {
    const account = await this.t.account();
    const nft = new Contract(collection, NFT_ABI, this.t.readProvider);
    const latest = await this.t.readProvider.getBlockNumber();
    const from = this.deployed.deployBlock ?? 0;
    const received = await this.logsOf(nft, nft.filters.Transfer!(null, account, null), from, latest);
    const ids = [...new Set(received.map((l) => BigInt((l as EventLog).args.tokenId)))];
    const owners = await Promise.all(ids.map((id) => this.t.reading(nft.ownerOf!(id)).catch(() => null)));
    return ids.filter((_, i) => sameAddress(owners[i] as string | null, account)).sort((a, b) => (a < b ? -1 : 1));
  }

  async mintTestNft(collection: Address, opts?: ActionOptions): Promise<bigint> {
    const c = this.deployed.collections.find((x) => sameAddress(x.address, collection));
    if (!c?.mintable) throw new ChainError("unknown", "This collection cannot be minted from here.");
    const account = await this.t.account();
    // Test ids are random: anyone may mint any id that is not taken yet.
    const tokenId = BigInt(Math.floor(Math.random() * 2 ** 48));
    await this.t.send(opts, () => this.t.writer({ address: collection, abi: NFT_ABI }).mint!(account, tokenId));
    return tokenId;
  }

  async deposit(collection: Address, tokenId: bigint, opts?: VaultDepositOptions): Promise<number> {
    const account = await this.t.account();
    const key = await this.keyFor(collection, tokenId, opts);
    const nft = { address: collection, abi: NFT_ABI };
    const approved = await this.t.reading(new Contract(collection, NFT_ABI, this.t.readProvider).getApproved!(tokenId));
    if (!sameAddress(String(approved), this.deployed.address)) await this.t.send(opts, () => this.t.writer(nft).approve!(this.deployed.address, tokenId));
    // The key, then each decoy's "really" (false), under one proof.
    const sends = decoySends(opts?.decoys ?? 0);
    const input = await this.t.encrypt(this.deployed.address, account, (b) => sends.reduce((acc, s) => acc.addBool(s.really), b.add256(key)), "the box key", opts);
    const receipt = await this.t.send(opts, () =>
      this.t.writer(this.deployed).deposit!(collection, tokenId, input.handles[0], sends.map((s) => s.to), input.handles.slice(1), input.inputProof),
    );
    return Number(this.events(receipt, "Deposited")[0]!.boxId);
  }

  async withdraw(boxId: number, to: Address, opts?: ActionOptions): Promise<void> {
    await this.ask(boxId, "withdraw", { to }, opts);
  }

  async list(boxId: number, price: bigint, endTime: number, opts?: ActionOptions): Promise<VaultListing> {
    await this.ask(boxId, "list", { price, endTime }, opts);
    const box = await this.box(boxId);
    if (!box.listing) throw new ChainError("missed", "The listing did not go up: the box changed first.");
    return box.listing;
  }

  async unlist(boxId: number, opts?: ActionOptions): Promise<void> {
    await this.ask(boxId, "unlist", {}, opts);
  }

  async buy(boxId: number, opts?: ActionOptions): Promise<void> {
    const box = await this.box(boxId);
    if (box.state !== "listed" || !box.listing) throw new ChainError("missed", "This NFT is no longer for sale.");
    const parameters = plain(await this.t.reading(this.read.seaportOrder!(box.listing.listingId)));
    const seaport = { address: this.deployed.seaport, abi: SEAPORT_ABI };
    await this.t.send(opts, () => this.t.writer(seaport).fulfillOrder!({ parameters, signature: "0x" }, ZERO, { value: box.listing!.price }));
    // Mark it sold now, rather than at the next request on it.
    await this.t.send(opts, () => this.t.writer(this.deployed).sync!(boxId)).catch(() => undefined);
  }

  async claim(boxId: number, to: Address, opts?: ActionOptions): Promise<bigint> {
    const { proceeds } = await this.box(boxId);
    await this.ask(boxId, "claim", { to }, opts);
    return proceeds;
  }

  async offers(boxId: number): Promise<VaultOffer[]> {
    const box = await this.box(boxId);
    if (box.state !== "sealed" && box.state !== "listed") return [];
    const posted = await this.posted(box.collection, box.tokenId);
    const now = Math.floor(Date.now() / 1000);
    const weth = new Contract(this.deployed.weth, WETH_ABI, this.t.readProvider);
    const rows = await Promise.all(
      posted.map(async ({ orderHash, parameters }) => {
        if (Number(parameters.endTime) <= now) return null;
        const { fillable } = await this.t.reading(this.board.inspect!(encodeOffer(parameters), box.collection, box.tokenId, 0));
        if (!fillable) return null;
        const { amount, units, paid } = offerTerms(parameters);
        // The buyer's WETH must still cover one NFT's share, or Seaport would not fill it.
        const share = paid / units;
        const [balance, allowance] = await Promise.all([
          this.t.reading(weth.balanceOf!(parameters.offerer)),
          this.t.reading(weth.allowance!(parameters.offerer, this.deployed.seaport)),
        ]);
        if (BigInt(balance) < share || BigInt(allowance) < share) return null;
        const anyToken = parameters.consideration.some((c) => c.itemType === ITEM.ERC721_WITH_CRITERIA);
        return { orderHash, buyer: getAddress(parameters.offerer), amount, endTime: Number(parameters.endTime), anyToken } satisfies VaultOffer;
      }),
    );
    return rows.filter((r): r is VaultOffer => r !== null).sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  }

  async makeOffer(boxId: number, amount: bigint, endTime: number, opts?: ActionOptions): Promise<string> {
    const account = await this.t.account();
    const box = await this.box(boxId);
    if (box.state !== "sealed" && box.state !== "listed") throw new ChainError("missed", "This NFT is no longer in the vault.");
    const weth = { address: this.deployed.weth, abi: WETH_ABI };
    const wethRead = new Contract(this.deployed.weth, WETH_ABI, this.t.readProvider);
    // Seaport takes WETH from the buyer when the offer fills: wrap what is missing, and let it.
    const balance = BigInt(await this.t.reading(wethRead.balanceOf!(account)));
    if (balance < amount) await this.t.send(opts, () => this.t.writer(weth).deposit!({ value: amount - balance }));
    const allowance = BigInt(await this.t.reading(wethRead.allowance!(account, this.deployed.seaport)));
    if (allowance < amount) await this.t.send(opts, () => this.t.writer(weth).approve!(this.deployed.seaport, allowance + amount));

    const seaport = new Contract(this.deployed.seaport, SEAPORT_ABI, this.t.readProvider);
    const counter = BigInt(await this.t.reading(seaport.getCounter!(account)));
    const parameters: OrderParameters = {
      offerer: account,
      zone: "0x" + "0".repeat(40),
      offer: [{ itemType: ITEM.ERC20, token: this.deployed.weth, identifierOrCriteria: 0n, startAmount: amount, endAmount: amount }],
      consideration: [
        { itemType: ITEM.ERC721, token: box.collection, identifierOrCriteria: box.tokenId, startAmount: 1n, endAmount: 1n, recipient: account },
      ],
      orderType: 0,
      startTime: BigInt(Math.floor(Date.now() / 1000) - 60),
      endTime: BigInt(endTime),
      zoneHash: ZERO,
      salt: BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256", "uint256"], [account, boxId, Date.now()]))),
      conduitKey: ZERO,
      totalOriginalConsiderationItems: 1n,
    };
    const { totalOriginalConsiderationItems: _, ...components } = parameters;
    opts?.onStep?.("wallet");
    const signature = await this.t.signTypedData(
      { name: "Seaport", version: "1.5", chainId: this.t.chainId, verifyingContract: this.deployed.seaport },
      SEAPORT_TYPES,
      { ...components, counter },
    );
    const receipt = await this.t.send(opts, () => this.t.writer(this.deployed.offers).post!(parameters, signature));
    const log = receipt.logs.find((l) => sameAddress(l.address, this.deployed.offers.address));
    return String(this.board.interface.parseLog(log!)!.args.orderHash);
  }

  async cancelOffer(orderHash: string, opts?: ActionOptions): Promise<void> {
    const account = await this.t.account();
    const parameters = await this.postedOrder(orderHash);
    if (!sameAddress(parameters.offerer, account)) throw new ChainError("not-yours", "Only the buyer who made this offer can cancel it.");
    const seaport = new Contract(this.deployed.seaport, SEAPORT_ABI, this.t.readProvider);
    const counter = BigInt(await this.t.reading(seaport.getCounter!(account)));
    const { totalOriginalConsiderationItems: _, ...components } = parameters;
    await this.t.send(opts, () => this.t.writer({ address: this.deployed.seaport, abi: SEAPORT_ABI }).cancel!([{ ...components, counter }]));
  }

  async acceptOffer(boxId: number, orderHash: string, to: Address, opts?: ActionOptions): Promise<bigint> {
    const box = await this.box(boxId);
    const parameters = await this.postedOrder(orderHash);
    const offer = encodeOffer(parameters);
    const { fillable } = await this.t.reading(this.board.inspect!(offer, box.collection, box.tokenId, 0));
    if (!fillable) throw new ChainError("missed", "This offer is gone: cancelled, filled or ended.");
    const { amount } = offerTerms(parameters);
    await this.ask(boxId, "acceptOffer", { to, price: amount, ref: orderHash }, opts, offer);
    const feeBps = BigInt(await this.t.reading(this.read.feeBps!()));
    return amount - (amount * feeBps) / 10_000n;
  }

  async delegate(boxId: number, delegate: Address | null, opts?: ActionOptions): Promise<void> {
    await this.ask(boxId, "delegate", { to: delegate ?? undefined }, opts);
  }

  async send(boxId: number, to: Address, opts?: ActionOptions): Promise<void> {
    await this.settlePending(boxId, opts);
    await this.t.send(opts, () => this.t.writer(this.deployed)["confidentialTransfer(address,uint256)"]!(getAddress(to), boxId));
    await this.myBoxes().catch(() => undefined);
  }

  async adopt(boxId: number, opts?: ActionOptions): Promise<void> {
    const account = await this.t.account();
    const box = await this.box(boxId);
    const key = await this.keyFor(box.collection, box.tokenId, opts);
    const input = await this.t.encrypt(this.deployed.address, account, (b) => b.add256(key), "the box key", opts);
    await this.t.send(opts, () => this.t.writer(this.deployed).setKey!(boxId, input.handles[0], input.inputProof));
  }

  async sales(): Promise<VaultSale[]> {
    const account = await this.t.account();
    const latest = await this.t.readProvider.getBlockNumber();
    const from = this.deployed.deployBlock ?? 0;
    const filter = this.read.filters.SaleOffered!;
    const logs = [...(await this.logs(filter(null, null, account), from, latest)), ...(await this.logs(filter(null, null, null), from, latest))];
    const ids = [...new Set(logs.map((l) => Number((l as EventLog).args.saleId)))].sort((a, b) => b - a);
    const rows = await Promise.all(ids.map(async (saleId) => ({ saleId, s: await this.t.reading(this.read.saleInfo!(saleId)) })));
    return rows
      .filter(({ s }) => sameAddress(String(s.seller), account) || sameAddress(String(s.buyer), account))
      .map(({ saleId, s }) => ({ saleId, boxId: Number(s.boxId), seller: String(s.seller), buyer: String(s.buyer), status: SALE_STATUS[Number(s.status)] as VaultSaleStatus }));
  }

  async offerSale(boxId: number, buyer: Address, price: bigint, opts?: ActionOptions): Promise<number> {
    const account = await this.t.account();
    const input = await this.t.encrypt(this.deployed.address, account, (b) => b.add64(price), "the price", opts);
    const receipt = await this.t.send(opts, () => this.t.writer(this.deployed).offerSale!(boxId, getAddress(buyer), input.handles[0], input.inputProof));
    return Number(this.events(receipt, "SaleOffered")[0]!.saleId);
  }

  async cancelSale(saleId: number, opts?: ActionOptions): Promise<void> {
    await this.t.send(opts, () => this.t.writer(this.deployed).cancelSale!(saleId));
  }

  async acceptSale(saleId: number, opts?: ActionOptions): Promise<boolean> {
    const account = await this.t.account();
    const s = await this.t.reading(this.read.saleInfo!(saleId));
    const box = await this.box(Number(s.boxId));
    const key = await this.keyFor(box.collection, box.tokenId, opts);
    await this.settlePending(box.boxId, opts);
    await this.t.ensureOperator(await this.t.cUsdc(), account, this.deployed.address, opts);
    const input = await this.t.encrypt(this.deployed.address, account, (b) => b.add256(key), "the box key", opts);
    await this.t.send(opts, () => this.t.writer(this.deployed).acceptSale!(saleId, input.handles[0], input.inputProof));
    const moved = String((await this.t.reading(this.read.saleInfo!(saleId))).moved);
    const clear = await this.t.userDecrypt([moved], this.deployed.address, opts);
    await this.myBoxes().catch(() => undefined);
    return clear[moved] === true || clear[moved] === 1n;
  }

  async salePrices(saleIds: number[], opts?: ActionOptions): Promise<Record<number, bigint>> {
    const rows = await Promise.all(saleIds.map(async (saleId) => ({ saleId, handle: String((await this.t.reading(this.read.saleInfo!(saleId))).price) })));
    const readable = rows.filter((r) => r.handle !== ZERO);
    if (!readable.length) return {};
    const clear = await this.t.userDecrypt(readable.map((r) => r.handle), this.deployed.address, opts);
    return Object.fromEntries(readable.map((r) => [r.saleId, BigInt(clear[r.handle] as bigint)]));
  }

  // --- internals ---

  /**
   * A request bound to its terms, sent by the relayer when there is one (the wallet otherwise),
   * then its proof. Throws `not-yours` when the key did not match, `missed` when the box changed first.
   */
  private async ask(
    boxId: number,
    action: keyof typeof ACTIONS,
    terms: { to?: Address; price?: bigint; endTime?: number; ref?: string },
    opts?: ActionOptions,
    offer?: string,
  ): Promise<void> {
    const account = await this.t.account();
    const box = await this.t.reading(this.read.boxInfo!(boxId));
    const key = await this.keyFor(String(box.collection), BigInt(box.tokenId), opts);
    const args = [boxId, ACTIONS[action], terms.to ? getAddress(terms.to) : "0x" + "0".repeat(40), terms.price ?? 0n, terms.endTime ?? 0, terms.ref ?? ZERO] as const;
    const hash = BigInt(await this.t.reading(this.read.requestHash!(boxId, box.nonce, ...args.slice(1))));
    const relay = await this.t.relay();
    const input = await this.t.encrypt(this.deployed.address, account, (b) => b.add256(key ^ hash), "the box key", opts, relay?.address ?? account);

    let requestId: number;
    if (relay) {
      const receipt = await this.relayed(opts, "request", () =>
        relay.request({
          boxId,
          action: args[1],
          to: args[2],
          price: String(args[3]),
          endTime: args[4],
          ref: args[5],
          handle: hex(input.handles[0]!),
          inputProof: hex(input.inputProof),
        }),
      );
      requestId = Number(this.events(receipt, "RequestPlaced")[0]!.requestId);
    } else {
      const receipt = await this.t.send(opts, () => this.t.writer(this.deployed).request!(...args, input.handles[0], input.inputProof));
      requestId = Number(this.events(receipt, "RequestPlaced")[0]!.requestId);
    }

    const info = await this.t.reading(this.read.requestInfo!(requestId));
    const decrypted = await this.t.publicDecrypt([String(info.ok)], opts);
    opts?.onStep?.("proving");
    await this.finalize(requestId, decrypted, opts, offer);
    const status = Number((await this.t.reading(this.read.requestInfo!(requestId))).status);
    if (status === REQUEST_REFUSED) throw new ChainError("not-yours", "This box is not yours, or its key is not yours yet. Nothing happened.");
    if (status === REQUEST_STALE) {
      throw new ChainError("missed", offer ? "The offer was gone, or the box changed first. Nothing happened." : "The box changed first (its listing sold or ran out). Nothing happened.");
    }
  }

  /** Step 2 of a request: its proof, with the buyer's order when it accepts an offer. Relayed when there is a relayer. */
  private async finalize(requestId: number, decrypted: { abiEncodedClearValues: string; decryptionProof: string }, opts?: ActionOptions, offer?: string): Promise<void> {
    const relay = await this.t.relay();
    const [cleartexts, proof] = [decrypted.abiEncodedClearValues, decrypted.decryptionProof];
    if (relay) {
      await this.relayed(opts, offer ? "finalizeOffer" : "finalize", () => relay.finalize({ requestId, cleartexts, proof, ...(offer ? { offer } : {}) }), false);
    } else if (offer) {
      await this.t.send(opts, () => this.t.writer(this.deployed).finalizeOffer!(requestId, cleartexts, proof, offer));
    } else {
      await this.t.send(opts, () => this.t.writer(this.deployed).finalize!(requestId, cleartexts, proof));
    }
  }

  /** Every offer posted for `tokenId` of `collection`, or for any of its tokens. */
  private async posted(collection: Address, tokenId: bigint): Promise<{ orderHash: string; parameters: OrderParameters }[]> {
    const latest = await this.t.readProvider.getBlockNumber();
    const from = this.deployed.offers.deployBlock ?? this.deployed.deployBlock ?? 0;
    const filter = this.board.filters.OfferPosted!;
    const any = (1n << 256n) - 1n;
    const logs = [...(await this.logsOf(this.board, filter(collection, tokenId), from, latest)), ...(await this.logsOf(this.board, filter(collection, any), from, latest))];
    return logs.map((l) => ({ orderHash: String((l as EventLog).args.orderHash), parameters: plain((l as EventLog).args.order) as OrderParameters }));
  }

  private async postedOrder(orderHash: string): Promise<OrderParameters> {
    const latest = await this.t.readProvider.getBlockNumber();
    const from = this.deployed.offers.deployBlock ?? this.deployed.deployBlock ?? 0;
    const [log] = await this.logsOf(this.board, this.board.filters.OfferPosted!(null, null, orderHash), from, latest);
    if (!log) throw new ChainError("missed", "No such offer on the board.");
    return plain((log as EventLog).args.order) as OrderParameters;
  }

  /**
   * Settles whatever requests the box waits on, so it can move: anyone's, a stranger's with a
   * wrong key included. Each gets its proof (finalize) or, after a day without one, is expired.
   * Sent by the relayer when there is one, by the wallet otherwise.
   */
  private async settlePending(boxId: number, opts?: ActionOptions): Promise<void> {
    if (Number((await this.t.reading(this.read.boxInfo!(boxId))).pending) === 0) return;
    const latest = await this.t.readProvider.getBlockNumber();
    const placed = await this.logs(this.read.filters.RequestPlaced!(null, boxId), this.deployed.deployBlock ?? 0, latest);
    const now = Math.floor(Date.now() / 1000);
    for (const requestId of [...new Set(placed.map((l) => Number((l as EventLog).args.requestId)))]) {
      const info = await this.t.reading(this.read.requestInfo!(requestId));
      if (Number(info.status) !== REQUEST_PENDING) continue;
      if (now > Number(info.placedAt) + REQUEST_TIMEOUT) {
        await this.t.send(opts, () => this.t.writer(this.deployed).expire!(requestId));
        continue;
      }
      const decrypted = await this.t.publicDecrypt([String(info.ok)], opts);
      opts?.onStep?.("proving");
      // An offer whose key matched needs its order: the one the request named, from the board.
      const offer = Number(info.action) === ACTIONS.acceptOffer ? await this.postedOrder(String(info.ref)).then(encodeOffer, () => undefined) : undefined;
      await this.finalize(requestId, decrypted, opts, offer).catch((error) => {
        // A wrong key, or an offer that cannot fill yet: it waits for its day, then anyone expires it.
        if (!offer) throw error;
      });
    }
  }

  /** A transaction the relayer sends: no wallet prompt, but the same steps and journal entry. */
  private async relayed(opts: ActionOptions | undefined, call: string, sendIt: () => Promise<string>, announce = true): Promise<ContractTransactionReceipt> {
    if (announce) opts?.onStep?.("confirming");
    let hash: string;
    try {
      hash = await sendIt();
    } catch (error) {
      throw new ChainError("network", `The vault relayer could not send it: ${(error as Error).message}`);
    }
    const tx: TxRecord = { hash, call, status: "sent", url: this.t.explorerUrl ? `${this.t.explorerUrl}/tx/${hash}` : null };
    opts?.onTx?.(tx);
    const receipt = await this.t.readProvider.waitForTransaction(hash);
    if (!receipt || receipt.status !== 1) {
      opts?.onTx?.({ ...tx, status: "failed" });
      throw new ChainError("reverted", "The relayed transaction failed on-chain.");
    }
    opts?.onTx?.({ ...tx, status: "confirmed", block: receipt.blockNumber, gasUsed: receipt.gasUsed });
    return receipt as unknown as ContractTransactionReceipt;
  }

  /**
   * The key of the box holding `tokenId` of `collection`: keccak256 of the wallet's key
   * signature and the NFT. One signature a session; nothing is stored.
   */
  private async keyFor(collection: string, tokenId: bigint, opts?: ActionOptions): Promise<bigint> {
    const account = await this.t.account();
    if (this.master?.account !== account) {
      opts?.onStep?.("wallet");
      const signature = await this.t.signText(vaultKeyMessage(this.deployed.address, this.t.chainId));
      this.master = { account, secret: keccak256(signature) };
    }
    return BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "uint256"], [this.master.secret, getAddress(collection), tokenId])));
  }

  private async boxAt(boxId: number, depositor: Address | null): Promise<VaultBox> {
    const b = await this.t.reading(this.read.boxInfo!(boxId));
    const state = STATES[Number(b.state)];
    if (!state || state === "none") throw new ChainError("reverted", "There is no such box.", "NotABox");
    let listing: VaultListing | null = null;
    if (Number(b.listing) > 0) {
      const listingId = Number(b.listing) - 1;
      const l = await this.t.reading(this.read.listingInfo!(listingId));
      listing = { listingId, price: BigInt(l.price), endTime: Number(l.endTime), orderHash: String(l.orderHash) };
    }
    const tokenUri = String(await this.t.reading(this.read.tokenURI!(boxId)).catch(() => ""));
    return {
      boxId,
      collection: String(b.collection),
      tokenId: BigInt(b.tokenId),
      state,
      depositor: depositor ?? "",
      listing,
      proceeds: BigInt(b.proceeds),
      busy: Number(b.pending) > 0,
      delegate: /^0x0{40}$/i.test(String(b.delegate)) ? null : getAddress(String(b.delegate)),
      tokenUri,
    };
  }

  /** Who put each box's NFT in, from the public deposits. */
  private async depositors(): Promise<Map<number, Address>> {
    const latest = await this.t.readProvider.getBlockNumber();
    const logs = await this.logs(this.read.filters.Deposited!(), this.deployed.deployBlock ?? 0, latest);
    return new Map(logs.map((l) => [Number((l as EventLog).args.boxId), String((l as EventLog).args.depositor)]));
  }

  private logs(filter: Parameters<Contract["queryFilter"]>[0], from: number, to: number) {
    return this.logsOf(this.read, filter, from, to);
  }

  /** Events in slices a public endpoint accepts. */
  private async logsOf(contract: Contract, filter: Parameters<Contract["queryFilter"]>[0], from: number, to: number) {
    const out = [];
    for (let lo = Math.max(0, from); lo <= to; lo += LOG_SPAN) {
      out.push(...(await this.t.reading(contract.queryFilter(filter, lo, Math.min(to, lo + LOG_SPAN - 1)))));
    }
    return out;
  }

  private events(receipt: ContractTransactionReceipt, name: string) {
    return receipt.logs.flatMap((log) => {
      if (!sameAddress(log.address, this.deployed.address)) return [];
      const parsed = this.read.interface.parseLog(log);
      return parsed?.name === name ? [parsed.args] : [];
    });
  }
}

/** One NFT's share of an offer: what it nets after the order's own fees, what it pays in all, and how many NFTs it is for. */
function offerTerms(p: OrderParameters): { amount: bigint; paid: bigint; units: bigint } {
  const paid = p.offer.reduce((sum, o) => sum + BigInt(o.startAmount), 0n);
  const fees = p.consideration.filter((c) => Number(c.itemType) === ITEM.ERC20).reduce((sum, c) => sum + BigInt(c.startAmount), 0n);
  const nft = p.consideration.find((c) => Number(c.itemType) !== ITEM.ERC20);
  const units = nft ? BigInt(nft.startAmount) : 1n;
  return { amount: (paid - fees) / units, paid, units };
}

/** What `finalizeOffer` takes: a validated order, so no signature; `VaultOffers` sets the fraction. */
function encodeOffer(parameters: OrderParameters): string {
  return AbiCoder.defaultAbiCoder().encode([ADVANCED_ORDER, "bytes32[]"], [{ parameters, numerator: 1n, denominator: 1n, signature: "0x", extraData: "0x" }, []]);
}

const hex = (v: string | Uint8Array) => (typeof v === "string" ? v : "0x" + Array.from(v, (b) => b.toString(16).padStart(2, "0")).join(""));

/** An ethers Result as plain objects and arrays, the way a contract call takes it back. */
function plain(value: unknown): unknown {
  if (!(value instanceof Array)) return value;
  const r = value as unknown[] & { toObject?: () => Record<string, unknown> };
  const items = [...r].map(plain);
  const keys = r.toObject ? Object.keys(r.toObject()).filter((k) => !/^\d+$/.test(k)) : [];
  if (!keys.length || keys[0]!.startsWith("_")) return items;
  return Object.fromEntries(keys.map((k, i) => [k, items[i]]));
}
