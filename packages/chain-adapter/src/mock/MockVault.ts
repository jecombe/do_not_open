import { ChainError, sameAddress, type ActionOptions, type Address } from "../types";
import { DEFAULT_POCKET_DECOYS, pocketSet } from "../pockets";
import type {
  PocketOptions,
  PocketSale,
  PocketsAdapter,
  PocketsInfo,
  VaultAdapter,
  VaultBox,
  VaultCollection,
  VaultDepositOptions,
  VaultInfo,
  VaultListing,
  VaultOffer,
  VaultSale,
} from "../vault";

/** The vault's address in the demo: it holds the NFTs. */
export const MOCK_VAULT: Address = "0x0000000000000000000000000000000000ba5e00";
/** The demo's test collection, free to mint. */
export const MOCK_VAULT_NFT: Address = "0x00000000000000000000000000000000000ca7e5";
const MOCK_SEAPORT: Address = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const MOCK_WETH: Address = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const MOCK_REGISTRY: Address = "0x00000000000000447e69651d841bD8D104Bed493";
/** The pockets' contract in the demo: it holds every pocket's cUSDC. */
export const MOCK_POCKETS: Address = "0x00000000000000000000000000000000000b0c55";
/** The desk: buys private sales out of pockets and holds the boxes it bought. */
export const MOCK_DESK: Address = "0x0000000000000000000000000000000000000de5";
const POCKETS_MAX_SET = 5;
const USD = 1_000_000n;
/** What the night shift asks your pocket for the box it offers it, in cUSDC. */
const NIGHT_POCKET_PRICE = 5n * USD;

const FEE_BPS = 250n;
const ETH = 10n ** 18n;
/** A Seaport listing of yours finds a buyer this long after it went up, in mock milliseconds. */
const BUYER_AFTER_MS = 20_000;
/** What the night shift offers, in WETH, for each NFT you seal. */
const NIGHT_OFFER = (3n * ETH) / 100n;

/** What the mock vault borrows from the demo around it: the account, the clock, the cUSDC book. */
export interface MockVaultHost {
  account(): Address | null;
  nightShift: Address;
  now(): number;
  send(opts: ActionOptions | undefined, call: string): Promise<void>;
  publish(opts: ActionOptions | undefined, call: string): Promise<void>;
  decrypting(opts: ActionOptions | undefined): Promise<void>;
  cUsdcOf(who: Address): bigint;
  moveCusdc(from: Address, to: Address, amount: bigint): void;
}

interface MockVaultBox extends Omit<VaultBox, "busy"> {
  /** Encrypted on a real chain. The desk, for a box a pocket bought. */
  holder: Address;
  /** The pocket that bought it through the desk, encrypted on a real chain. */
  pocket?: number;
  /** Whether the holder's key is set: a received box has a random key until it is adopted. */
  keyed: boolean;
}

interface MockOffer extends VaultOffer {
  boxId: number;
  status: "open" | "filled" | "cancelled";
}

interface MockSale extends VaultSale {
  /** Encrypted on a real chain, readable by the two sides only. */
  price: bigint;
  /** A sale offered to the desk: the pocket it is reserved for. */
  pocketId?: number;
}

interface MockPocket {
  /** Who derived its key: on a real chain only the key says so, and it is encrypted. */
  owner: Address;
  /** Encrypted on a real chain, readable by the pocket's viewer only. */
  balance: bigint;
}

/**
 * The sealed vault in memory, with the contract's rules: a wrong key settles refused and moves
 * nothing, a listed box stays put, a box that changes hands needs its new holder's key. The
 * night shift holds two NFTs in it, one listed on Seaport, buys any listing of yours after a
 * short while, and makes a WETH offer on every NFT you seal, so every flow can be played alone.
 */
export class MockVault implements VaultAdapter {
  private readonly all: MockVaultBox[] = [];
  private readonly saleList: MockSale[] = [];
  private readonly offerList: MockOffer[] = [];
  private readonly nfts = new Map<string, Address>();
  private readonly eth = new Map<Address, bigint>();
  private listingCount = 0;
  private nextNft = 1;
  /** Mock milliseconds when each of your listings finds its buyer. */
  private readonly buyerAt = new Map<number, number>();
  private readonly pocketList: MockPocket[] = [];
  private pockets_: PocketsAdapter | null = null;

  constructor(private readonly host: MockVaultHost) {
    const night = host.nightShift;
    for (let i = 0; i < 2; i++) {
      const tokenId = this.mintTo(night);
      this.nfts.set(String(tokenId), MOCK_VAULT);
      this.all.push(this.newBox(night, tokenId));
    }
    this.eth.set(night, 50n * ETH);
    this.listBox(this.all[0]!, ETH / 20n, Math.floor(host.now() / 1000) + 7 * 86_400);
    // Strangers' pockets, so yours hides among others from the start, one of them the night shift's.
    for (let i = 0; i < 4; i++) this.pocketList.push({ owner: `0x00000000000000000000000000000000000c0c${i.toString(16).padStart(2, "0")}` as Address, balance: 0n });
    this.pocketList.push({ owner: night, balance: 500n * USD });
  }

  pockets(): PocketsAdapter {
    this.pockets_ ??= this.makePockets();
    return this.pockets_;
  }

  async info(): Promise<VaultInfo> {
    const collections: VaultCollection[] = [{ address: MOCK_VAULT_NFT, name: "Mock Kittens", mintable: true }];
    return {
      address: MOCK_VAULT,
      explorerUrl: null,
      explorer: null,
      marketplace: null,
      feeBps: Number(FEE_BPS),
      seaport: MOCK_SEAPORT,
      weth: MOCK_WETH,
      delegateRegistry: MOCK_REGISTRY,
      collections,
      relayer: "0x000000000000000000000000000000000000a11e",
      coin: "ETH",
    };
  }

  async boxes(): Promise<VaultBox[]> {
    this.settle();
    return this.all.map((_, id) => this.view(id)).reverse();
  }

  async box(boxId: number): Promise<VaultBox> {
    this.settle();
    return this.view(boxId);
  }

  async myBoxes(): Promise<number[]> {
    const me = this.host.account();
    return this.all.flatMap((b, id) => (me && b.holder === me && !gone(b) ? [id] : []));
  }

  /** The demo keeps no WETH: its offers are paid from the buyer's ETH, as if wrapped on the spot. */
  async wethBalance(_owner: Address): Promise<bigint> {
    return 0n;
  }

  async walletNfts(collection: Address): Promise<bigint[]> {
    const me = this.host.account();
    if (!me || !sameAddress(collection, MOCK_VAULT_NFT)) return [];
    return [...this.nfts].flatMap(([id, owner]) => (owner === me ? [BigInt(id)] : []));
  }

  async mintTestNft(collection: Address, opts?: ActionOptions): Promise<bigint> {
    const me = this.signer();
    if (!sameAddress(collection, MOCK_VAULT_NFT)) throw revert("NotMintable");
    await this.host.send(opts, "mint");
    return this.mintTo(me);
  }

  /** Decoys move nothing, so the mock leaves them out. */
  async deposit(collection: Address, tokenId: bigint, opts?: VaultDepositOptions): Promise<number> {
    const me = this.signer();
    if (!sameAddress(collection, MOCK_VAULT_NFT)) throw revert("CollectionNotAllowed");
    if (this.nfts.get(String(tokenId)) !== me) throw revert("ERC721InsufficientApproval");
    await this.host.send(opts, "approve");
    await this.host.send(opts, "deposit");
    this.nfts.set(String(tokenId), MOCK_VAULT);
    this.all.push(this.newBox(me, tokenId));
    const boxId = this.all.length - 1;
    this.postOffer(boxId, this.host.nightShift, NIGHT_OFFER, Math.floor(this.host.now() / 1000) + 7 * 86_400);
    return boxId;
  }

  async withdraw(boxId: number, to: Address, opts?: ActionOptions): Promise<void> {
    const b = this.get(boxId);
    if (b.state !== "sealed" && b.state !== "listed") throw revert("WrongState");
    await this.request(b, opts);
    b.listing = null;
    b.state = "withdrawn";
    b.delegate = null;
    this.nfts.set(String(b.tokenId), to);
  }

  async list(boxId: number, price: bigint, endTime: number, opts?: ActionOptions): Promise<VaultListing> {
    const b = this.get(boxId);
    if (b.state !== "sealed") throw revert("WrongState");
    if (price <= 0n) throw revert("BadPrice");
    if (endTime <= Math.floor(this.host.now() / 1000)) throw revert("BadEndTime");
    await this.request(b, opts);
    const listing = this.listBox(b, price, endTime);
    this.buyerAt.set(listing.listingId, this.host.now() + BUYER_AFTER_MS);
    return listing;
  }

  async unlist(boxId: number, opts?: ActionOptions): Promise<void> {
    const b = this.get(boxId);
    this.settle();
    if (b.state !== "listed") throw revert("WrongState");
    await this.request(b, opts);
    b.listing = null;
    b.state = "sealed";
  }

  async buy(boxId: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const b = this.get(boxId);
    this.settle();
    if (b.state !== "listed" || !b.listing) throw revert("OrderIsCancelled");
    if ((this.eth.get(me) ?? 0n) < b.listing.price) throw new ChainError("insufficient-funds", "Not enough ETH for the price.");
    await this.host.send(opts, "fulfillOrder");
    this.credit(me, -b.listing.price);
    this.fill(b, me);
  }

  async claim(boxId: number, to: Address, opts?: ActionOptions): Promise<bigint> {
    const b = this.get(boxId);
    this.settle();
    if (b.state !== "sold") throw revert("WrongState");
    await this.request(b, opts);
    const amount = b.proceeds;
    b.proceeds = 0n;
    b.state = "claimed";
    this.credit(to, amount);
    return amount;
  }

  async offers(boxId: number): Promise<VaultOffer[]> {
    const b = this.get(boxId);
    this.settle();
    if (b.state !== "sealed" && b.state !== "listed") return [];
    const now = Math.floor(this.host.now() / 1000);
    return this.offerList
      .filter((o) => o.boxId === boxId && o.status === "open" && o.endTime > now && this.ethOf(o.buyer) >= o.amount)
      .map(({ boxId: _boxId, status: _status, ...o }) => o)
      .sort((x, y) => (x.amount === y.amount ? 0 : x.amount > y.amount ? -1 : 1));
  }

  async makeOffer(boxId: number, amount: bigint, endTime: number, opts?: ActionOptions): Promise<string> {
    const me = this.signer();
    const b = this.get(boxId);
    if (b.state !== "sealed" && b.state !== "listed") throw new ChainError("missed", "This NFT is no longer in the vault.");
    if (amount <= 0n) throw revert("BadPrice");
    if (this.ethOf(me) < amount) throw new ChainError("insufficient-funds", "Not enough ETH to wrap for this offer.");
    // Wrap, let Seaport take the WETH, sign the order, post it.
    await this.host.send(opts, "deposit");
    await this.host.send(opts, "approve");
    opts?.onStep?.("wallet");
    await this.host.send(opts, "post");
    return this.postOffer(boxId, me, amount, endTime);
  }

  async cancelOffer(orderHash: string, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const o = this.offerList.find((x) => x.orderHash === orderHash);
    if (!o || o.status !== "open") throw new ChainError("missed", "No such offer on the board.");
    if (o.buyer !== me) throw new ChainError("not-yours", "Only the buyer who made this offer can cancel it.");
    await this.host.send(opts, "cancel");
    o.status = "cancelled";
  }

  async acceptOffer(boxId: number, orderHash: string, to: Address, opts?: ActionOptions): Promise<bigint> {
    const b = this.get(boxId);
    this.settle();
    const o = this.offerList.find((x) => x.orderHash === orderHash && x.boxId === boxId);
    if (b.state !== "sealed" && b.state !== "listed") throw revert("WrongState");
    if (!o || o.status !== "open" || o.endTime * 1000 <= this.host.now() || this.ethOf(o.buyer) < o.amount) {
      throw new ChainError("missed", "This offer is gone: cancelled, filled or ended.");
    }
    await this.request(b, opts);
    o.status = "filled";
    this.credit(o.buyer, -o.amount);
    this.nfts.set(String(b.tokenId), o.buyer);
    const net = o.amount - (o.amount * FEE_BPS) / 10_000n;
    this.credit(to, net);
    b.listing = null;
    b.delegate = null;
    b.state = "claimed";
    return net;
  }

  async delegate(boxId: number, delegate: Address | null, opts?: ActionOptions): Promise<void> {
    const b = this.get(boxId);
    if (b.state !== "sealed" && b.state !== "listed") throw revert("WrongState");
    await this.request(b, opts);
    b.delegate = delegate;
  }

  async send(boxId: number, to: Address, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const b = this.get(boxId);
    if (b.state !== "sealed") throw revert("WrongState");
    await this.host.send(opts, "confidentialTransfer");
    // A "maybe": it moves only for the holder, and the box loses its key.
    if (b.holder === me) {
      b.holder = to;
      b.keyed = false;
    }
  }

  async adopt(boxId: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const b = this.get(boxId);
    await this.host.send(opts, "setKey");
    if (b.holder === me) b.keyed = true;
  }

  async sales(): Promise<VaultSale[]> {
    const me = this.host.account();
    return this.saleList
      .filter((s) => me && (s.seller === me || s.buyer === me))
      .map(({ price: _price, pocketId: _pocketId, ...s }) => s)
      .reverse();
  }

  async offerSale(boxId: number, buyer: Address, price: bigint, opts?: ActionOptions): Promise<number> {
    const me = this.signer();
    const b = this.get(boxId);
    if (b.state !== "sealed") throw revert("WrongState");
    if (sameAddress(buyer, me)) throw revert("NotBuyer");
    opts?.onStep?.("encrypting");
    await this.host.send(opts, "offerSale");
    this.saleList.push({ saleId: this.saleList.length, boxId, seller: me, buyer, status: "open", price });
    const saleId = this.saleList.length - 1;
    // The night shift takes whatever is offered to it, at once, if its cUSDC covers it.
    if (sameAddress(buyer, this.host.nightShift)) this.settleSale(this.saleList[saleId]!);
    return saleId;
  }

  async cancelSale(saleId: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const s = this.sale(saleId);
    if (s.seller !== me) throw revert("NotSeller");
    await this.host.send(opts, "cancelSale");
    s.status = "cancelled";
  }

  async acceptSale(saleId: number, opts?: ActionOptions): Promise<boolean> {
    const me = this.signer();
    const s = this.sale(saleId);
    if (s.buyer !== me) throw revert("NotBuyer");
    if (this.get(s.boxId).state !== "sealed") throw revert("WrongState");
    opts?.onStep?.("encrypting");
    await this.host.send(opts, "acceptSale");
    const moved = this.settleSale(s);
    await this.host.decrypting(opts);
    return moved;
  }

  async salePrices(saleIds: number[], opts?: ActionOptions): Promise<Record<number, bigint>> {
    const me = this.signer();
    await this.host.decrypting(opts);
    const out: Record<number, bigint> = {};
    for (const id of saleIds) {
      const s = this.saleList[id];
      if (s && (s.seller === me || s.buyer === me)) out[id] = s.price;
    }
    return out;
  }

  /** The pockets in memory, with the contract's rules: a short balance or a wrong key moves nothing, without an error. */
  private makePockets(): PocketsAdapter {
    const host = this.host;
    const list = this.pocketList;
    const mineOf = (who: Address | null) => (who ? list.findIndex((p) => p.owner === who) : -1);
    const myPocket = () => {
      const id = mineOf(this.signer());
      if (id < 0) throw new ChainError("not-yours", "Open your pocket first.");
      return id;
    };
    const set = (real: number, opts?: PocketOptions, avoid: number[] = []) => pocketSet(real, list.length, opts?.decoys ?? DEFAULT_POCKET_DECOYS, POCKETS_MAX_SET, avoid);
    const info = async (): Promise<PocketsInfo> => ({ address: MOCK_POCKETS, desk: MOCK_DESK, count: list.length, maxSet: POCKETS_MAX_SET });
    const pocketSales = (): (MockSale & { pocketId: number })[] => {
      const id = mineOf(host.account());
      return this.saleList.filter((s): s is MockSale & { pocketId: number } => s.pocketId !== undefined && s.pocketId === id && id >= 0);
    };
    return {
      info,
      mine: async () => {
        const id = mineOf(host.account());
        return id < 0 ? null : id;
      },
      open: async (opts) => {
        const me = this.signer();
        const had = mineOf(me);
        if (had >= 0) return had;
        opts?.onStep?.("wallet");
        opts?.onStep?.("encrypting");
        await host.send(opts, "open");
        list.push({ owner: me, balance: 0n });
        const id = list.length - 1;
        // The night shift offers your new pocket one of its boxes, so buying with a pocket can be played alone.
        const theirs = this.all.findIndex((b) => b.holder === host.nightShift && b.state === "sealed");
        if (theirs >= 0) {
          this.saleList.push({ saleId: this.saleList.length, boxId: theirs, seller: host.nightShift, buyer: MOCK_DESK, status: "open", price: NIGHT_POCKET_PRICE, pocketId: id });
        }
        return id;
      },
      balance: async (opts) => {
        const id = myPocket();
        await host.decrypting(opts);
        return list[id]!.balance;
      },
      deposit: async (amount, opts) => {
        const me = this.signer();
        const to = opts?.to ?? myPocket();
        if (!list[to]) throw revert("NotAPocket");
        set(to, opts);
        opts?.onStep?.("encrypting");
        await host.send(opts, "setOperator");
        await host.send(opts, "deposit");
        // The pockets pull it all or nothing.
        if (host.cUsdcOf(me) >= amount) {
          host.moveCusdc(me, MOCK_POCKETS, amount);
          list[to]!.balance += amount;
        }
      },
      send: async (to, amount, opts) => {
        const id = myPocket();
        if (!list[to]) throw revert("NotAPocket");
        set(id, opts);
        set(to, opts);
        opts?.onStep?.("wallet");
        opts?.onStep?.("encrypting");
        await host.send(opts, "send");
        if (list[id]!.balance >= amount) {
          list[id]!.balance -= amount;
          list[to]!.balance += amount;
        }
      },
      withdraw: async (to, amount, opts) => {
        const id = myPocket();
        set(id, opts);
        opts?.onStep?.("wallet");
        opts?.onStep?.("encrypting");
        await host.send(opts, "withdraw");
        if (list[id]!.balance >= amount) {
          list[id]!.balance -= amount;
          host.moveCusdc(MOCK_POCKETS, to, amount);
        }
      },
      offerSale: async (boxId, pocketId, price, opts) => {
        const me = this.signer();
        const b = this.get(boxId);
        if (b.state !== "sealed") throw revert("WrongState");
        if (!list[pocketId]) throw revert("NotAPocket");
        opts?.onStep?.("encrypting");
        await host.send(opts, "offerSale");
        await host.send(opts, "reserve");
        const sale: MockSale = { saleId: this.saleList.length, boxId, seller: me, buyer: MOCK_DESK, status: "open", price, pocketId };
        this.saleList.push(sale);
        // The night shift's pocket buys whatever is offered to it, if it covers the price.
        if (list[pocketId]!.owner === host.nightShift) this.buyForPocket(sale, pocketId);
        return sale.saleId;
      },
      sales: async () => pocketSales().map(({ price: _price, ...s }): PocketSale => ({ ...s })).reverse(),
      salePrices: async (saleIds, opts) => {
        await host.decrypting(opts);
        const out: Record<number, bigint> = {};
        for (const s of pocketSales()) if (saleIds.includes(s.saleId)) out[s.saleId] = s.price;
        return out;
      },
      buy: async (saleId, opts) => {
        const id = myPocket();
        const s = this.sale(saleId);
        if (s.pocketId !== id) throw revert("NotReserved");
        opts?.onStep?.("wallet");
        opts?.onStep?.("encrypting");
        await host.send(opts, "ask");
        await host.decrypting(opts);
        if (list[id]!.balance < s.price) throw new ChainError("not-yours", "Your pocket does not cover the price. Nothing happened; the sale is still open.");
        opts?.onStep?.("proving");
        await host.send(opts, "buy");
        return this.buyForPocket(s, id);
      },
      boxes: async () => {
        const id = mineOf(host.account());
        return this.all.flatMap((b, boxId) => (id >= 0 && b.holder === MOCK_DESK && b.pocket === id && !gone(b) ? [boxId] : []));
      },
    };
  }

  /** The desk's purchase: the pocket pays, the box moves to the desk with the buyer's key, if the seller still holds it. */
  private buyForPocket(s: MockSale, pocketId: number): boolean {
    const p = this.pocketList[pocketId]!;
    const b = this.get(s.boxId);
    s.status = "settled";
    if (p.balance < s.price || b.holder !== s.seller || b.state !== "sealed") return false;
    p.balance -= s.price;
    const fee = (s.price * FEE_BPS) / 10_000n;
    this.host.moveCusdc(MOCK_POCKETS, s.seller, s.price - fee);
    this.host.moveCusdc(MOCK_POCKETS, MOCK_VAULT, fee);
    b.holder = MOCK_DESK;
    b.pocket = pocketId;
    b.keyed = true;
    return true;
  }

  /** ETH in the demo, for Seaport prices. */
  ethOf(who: Address): bigint {
    return this.eth.get(who) ?? 0n;
  }

  giveEth(who: Address, amount: bigint): void {
    this.credit(who, amount);
  }

  // --- internals ---

  /** A key-bound request and its proof: refused unless the connected account holds the box with its key. */
  private async request(b: MockVaultBox, opts: ActionOptions | undefined): Promise<void> {
    const me = this.signer();
    opts?.onStep?.("encrypting");
    await this.host.send(opts, "request");
    await this.host.publish(opts, "finalize");
    const mine = b.holder === me || (b.holder === MOCK_DESK && b.pocket !== undefined && this.pocketList[b.pocket]?.owner === me);
    if (!mine || !b.keyed) throw new ChainError("not-yours", "This box is not yours, or its key is not yours yet. Nothing happened.");
  }

  private settleSale(s: MockSale): boolean {
    s.status = "settled";
    const b = this.get(s.boxId);
    const paid = this.host.cUsdcOf(s.buyer) >= s.price;
    if (!paid || b.holder !== s.seller) return false;
    const fee = (s.price * FEE_BPS) / 10_000n;
    this.host.moveCusdc(s.buyer, s.seller, s.price - fee);
    this.host.moveCusdc(s.buyer, MOCK_VAULT, fee);
    b.holder = s.buyer;
    b.keyed = true;
    return true;
  }

  /** Your listings find their buyer once their time comes, as if someone on a marketplace filled them. */
  private settle(): void {
    for (const b of this.all) {
      if (b.state !== "listed" || !b.listing) continue;
      const at = this.buyerAt.get(b.listing.listingId);
      if (b.listing.endTime * 1000 < this.host.now()) {
        b.listing = null;
        b.state = "sealed";
      } else if (at !== undefined && this.host.now() >= at) {
        this.fill(b, this.host.nightShift);
      }
    }
  }

  private fill(b: MockVaultBox, buyer: Address): void {
    const price = b.listing!.price;
    const fee = (price * FEE_BPS) / 10_000n;
    this.nfts.set(String(b.tokenId), buyer);
    b.proceeds = price - fee;
    b.state = "sold";
    b.delegate = null;
  }

  private postOffer(boxId: number, buyer: Address, amount: bigint, endTime: number): string {
    const orderHash = `0x0ffe${this.offerList.length.toString(16).padStart(60, "0")}`;
    this.offerList.push({ orderHash, boxId, buyer, amount, endTime, anyToken: false, status: "open" });
    return orderHash;
  }

  private listBox(b: MockVaultBox, price: bigint, endTime: number): VaultListing {
    const listingId = this.listingCount++;
    b.listing = { listingId, price, endTime, orderHash: `0x${listingId.toString(16).padStart(64, "0")}` };
    b.state = "listed";
    return b.listing;
  }

  private newBox(depositor: Address, tokenId: bigint): MockVaultBox {
    const boxId = this.all.length;
    return {
      boxId,
      collection: MOCK_VAULT_NFT,
      tokenId,
      state: "sealed",
      depositor,
      listing: null,
      proceeds: 0n,
      delegate: null,
      tokenUri: "",
      holder: depositor,
      keyed: true,
    };
  }

  private mintTo(who: Address): bigint {
    const id = BigInt(this.nextNft++);
    this.nfts.set(String(id), who);
    return id;
  }

  private view(boxId: number): VaultBox {
    const { holder: _holder, keyed: _keyed, pocket: _pocket, ...b } = this.get(boxId);
    return { ...b, listing: b.listing ? { ...b.listing } : null, busy: false };
  }

  private get(boxId: number): MockVaultBox {
    const b = this.all[boxId];
    if (!b) throw revert("NotABox");
    return b;
  }

  private sale(saleId: number): MockSale {
    const s = this.saleList[saleId];
    if (!s || s.status !== "open") throw revert("SaleNotOpen");
    return s;
  }

  private signer(): Address {
    const me = this.host.account();
    if (!me) throw new ChainError("not-connected", "No account connected.");
    return me;
  }

  private credit(who: Address, delta: bigint): void {
    this.eth.set(who, (this.eth.get(who) ?? 0n) + delta);
  }
}

const gone = (b: MockVaultBox) => b.state === "withdrawn" || b.state === "claimed";
const revert = (reason: string) => new ChainError("reverted", `The vault refused: ${reason}.`, reason);
