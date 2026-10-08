import { ChainError, sameAddress, type ActionOptions, type Address } from "../types";
import type { VaultAdapter, VaultBox, VaultCollection, VaultInfo, VaultListing, VaultSale } from "../vault";

/** The vault's address in the demo: it holds the NFTs. */
export const MOCK_VAULT: Address = "0x0000000000000000000000000000000000ba5e00";
/** The demo's test collection, free to mint. */
export const MOCK_VAULT_NFT: Address = "0x00000000000000000000000000000000000ca7e5";
const MOCK_SEAPORT: Address = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";

const FEE_BPS = 250n;
const ETH = 10n ** 18n;
/** A Seaport listing of yours finds a buyer this long after it went up, in mock milliseconds. */
const BUYER_AFTER_MS = 20_000;

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
  /** Encrypted on a real chain. */
  holder: Address;
  /** Whether the holder's key is set: a received box has a random key until it is adopted. */
  keyed: boolean;
}

interface MockSale extends VaultSale {
  /** Encrypted on a real chain, readable by the two sides only. */
  price: bigint;
}

/**
 * The sealed vault in memory, with the contract's rules: a wrong key settles refused and moves
 * nothing, a listed box stays put, a box that changes hands needs its new holder's key. The
 * night shift holds two NFTs in it, one listed on Seaport, and buys any listing of yours after a
 * short while, so every flow can be played alone.
 */
export class MockVault implements VaultAdapter {
  private readonly all: MockVaultBox[] = [];
  private readonly saleList: MockSale[] = [];
  private readonly nfts = new Map<string, Address>();
  private readonly eth = new Map<Address, bigint>();
  private listingCount = 0;
  private nextNft = 1;
  /** Mock milliseconds when each of your listings finds its buyer. */
  private readonly buyerAt = new Map<number, number>();

  constructor(private readonly host: MockVaultHost) {
    const night = host.nightShift;
    for (let i = 0; i < 2; i++) {
      const tokenId = this.mintTo(night);
      this.nfts.set(String(tokenId), MOCK_VAULT);
      this.all.push(this.newBox(night, tokenId));
    }
    this.eth.set(night, 50n * ETH);
    this.listBox(this.all[0]!, ETH / 20n, Math.floor(host.now() / 1000) + 7 * 86_400);
  }

  async info(): Promise<VaultInfo> {
    const collections: VaultCollection[] = [{ address: MOCK_VAULT_NFT, name: "Mock Kittens", mintable: true }];
    return { address: MOCK_VAULT, explorerUrl: null, feeBps: Number(FEE_BPS), seaport: MOCK_SEAPORT, collections, relayer: "0x000000000000000000000000000000000000a11e", coin: "ETH" };
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

  async deposit(collection: Address, tokenId: bigint, opts?: ActionOptions): Promise<number> {
    const me = this.signer();
    if (!sameAddress(collection, MOCK_VAULT_NFT)) throw revert("CollectionNotAllowed");
    if (this.nfts.get(String(tokenId)) !== me) throw revert("ERC721InsufficientApproval");
    await this.host.send(opts, "approve");
    await this.host.send(opts, "deposit");
    this.nfts.set(String(tokenId), MOCK_VAULT);
    this.all.push(this.newBox(me, tokenId));
    return this.all.length - 1;
  }

  async withdraw(boxId: number, to: Address, opts?: ActionOptions): Promise<void> {
    const b = this.get(boxId);
    if (b.state !== "sealed" && b.state !== "listed") throw revert("WrongState");
    await this.request(b, opts);
    b.listing = null;
    b.state = "withdrawn";
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
      .map(({ price: _price, ...s }) => s)
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
    if (b.holder !== me || !b.keyed) throw new ChainError("not-yours", "This box is not yours, or its key is not yours yet. Nothing happened.");
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
    const { holder: _holder, keyed: _keyed, ...b } = this.get(boxId);
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
