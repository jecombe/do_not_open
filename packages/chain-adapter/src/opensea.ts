/**
 * OpenSea's offers, read from its API for the sealed vault: the offers made on opensea.io for
 * an NFT the vault holds, and what filling one takes.
 *
 * OpenSea's offers live off-chain (a buyer signs a Seaport order, OpenSea keeps it), behind
 * OpenSea's signed zone: Seaport fills one only with `extraData` OpenSea's server signs for the
 * one address that fills it, for a few minutes. So the vault's page cannot read them from the
 * chain as it reads the board's, and the API, which holds the key, reads them for it: the offers
 * on a token (`offers`), and, right before `finalizeOffer`, the order with its signature for the
 * vault's address (`fulfillment`: OpenSea signs for the NFT's holder, which must be the one that
 * calls Seaport, so the vault sends the fill `VaultOffers` writes). The key never reaches a browser.
 *
 * Used by the API (`apps/api`), by the fork check (`scripts/opensea-fork.ts`: a live offer filled
 * by `VaultOffers` on a fork of mainnet) and, for the order's shape, by the EVM adapter. Nothing
 * here touches a wallet. OpenSea closed its testnets: there is nothing to read on Sepolia.
 */

import { AbiCoder } from "ethers";

/** Seaport 1.6 and OpenSea's addresses on mainnet, as `lib/opensea.ts` in contracts-evm has them. */
export const SEAPORT_1_6 = "0x0000000000000068F116a894984e2DB1123eB395";
export const OPENSEA_ZONE = "0x000056F7000000EcE9003ca63978907a00FFD100";
export const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/** OpenSea's name for each network it serves; none for the networks it closed (Sepolia). */
export const OPENSEA_CHAINS: Record<string, string> = { mainnet: "ethereum" };

/** Seaport's item types, as the offers use them. */
export const ITEM = { NATIVE: 0, ERC20: 1, ERC721: 2, ERC721_WITH_CRITERIA: 4 } as const;
/** `CriteriaResolver.side`: the consideration side, where the NFT an offer asks for is. */
const CONSIDERATION_SIDE = 1;

export interface SeaportItem {
  itemType: number;
  token: string;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
}
export interface SeaportConsiderationItem extends SeaportItem {
  recipient: string;
}
/** A Seaport order's parameters, as `OrderParameters`. */
export interface SeaportOrderParameters {
  offerer: string;
  zone: string;
  offer: SeaportItem[];
  consideration: SeaportConsiderationItem[];
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: string;
  salt: bigint;
  conduitKey: string;
  totalOriginalConsiderationItems: bigint;
}
/** An `AdvancedOrder`: what `fulfillAdvancedOrder` takes, the zone's `extraData` included. */
export interface AdvancedOrder {
  parameters: SeaportOrderParameters;
  numerator: bigint;
  denominator: bigint;
  signature: string;
  extraData: string;
}

export const ORDER_PARAMETERS_TYPE =
  "(address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)";
/** What `finalizeOffer` and `VaultOffers.fill` decode: abi.encode(AdvancedOrder, bytes32[] criteriaProof). */
export const ADVANCED_ORDER_TYPE = `(${ORDER_PARAMETERS_TYPE} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)`;

/** An offer OpenSea holds on a token, as the vault's page lists it next to the board's. */
export interface MarketOffer {
  orderHash: string;
  /** The Seaport the offer is on (1.6). */
  protocolAddress: string;
  buyer: string;
  /** Wei of WETH one NFT nets, the order's own fees (OpenSea's, the creator's) taken. */
  amount: bigint;
  /** Unix seconds. */
  endTime: number;
  /** An offer on any NFT of the collection (a collection offer), not on this one alone. */
  anyToken: boolean;
  /** The order as OpenSea holds it, without the zone's `extraData`: enough for `inspect`. */
  parameters: SeaportOrderParameters;
}

/** `MarketOffer` as JSON carries it (bigints as decimal strings). */
export interface MarketOfferJson {
  orderHash: string;
  protocolAddress: string;
  buyer: string;
  amount: string;
  endTime: number;
  anyToken: boolean;
  parameters: Record<string, unknown>;
}

/** What filling an OpenSea offer takes, signed for one fulfiller for a short while. */
export interface MarketFulfillment {
  /** abi.encode(AdvancedOrder, bytes32[] criteriaProof), the zone's `extraData` in the order. */
  offer: string;
  /** When OpenSea's signature expires (unix seconds), or null when it says nothing. */
  expiresAt: number | null;
}

export interface OpenSeaOptions {
  apiKey: string;
  /** OpenSea's chain name: "ethereum". */
  chain?: string;
  /** The WETH offers pay in on that chain. */
  weth?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class OpenSeaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** OpenSea's API, for the vault: offers on a token, and the fulfillment of one. */
export class OpenSeaOffers {
  readonly chain: string;
  private readonly weth: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly slugs = new Map<string, Promise<string | null>>();

  constructor(private readonly opts: OpenSeaOptions) {
    this.chain = opts.chain ?? "ethereum";
    this.weth = (opts.weth ?? MAINNET_WETH).toLowerCase();
    this.base = (opts.baseUrl ?? "https://api.opensea.io/api/v2").replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * The live offers OpenSea holds for `tokenId` of `collection`, paid in WETH, that `VaultOffers`
   * could fill: the best offer on this token and the collection's offers (any token; OpenSea's
   * first page, its best), trait offers left out, best first. What the buyer can pay is Seaport's
   * to check when it fills. OpenSea's API (read on 2026-10-10) lists a token's offers only as
   * its best one; `/orders/{chain}/seaport/offers`, which listed them all, is gone (405).
   */
  async offers(collection: string, tokenId: bigint, now = Math.floor(Date.now() / 1000)): Promise<MarketOffer[]> {
    const slug = await this.slugOf(collection);
    if (!slug) return [];
    const [best, whole] = await Promise.all([this.bestOffer(slug, tokenId), this.collectionOffers(slug)]);
    const seen = new Set<string>();
    const rows: MarketOffer[] = [];
    for (const raw of [...best, ...whole]) {
      const offer = this.usable(raw, collection, tokenId, now);
      if (!offer || seen.has(offer.orderHash)) continue;
      seen.add(offer.orderHash);
      rows.push(offer);
    }
    return rows.sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  }

  /**
   * The order to fill offer `orderHash` with `tokenId` of `collection`, signed by OpenSea's zone
   * for `fulfiller` (the NFT's holder, which calls Seaport: the vault): what `finalizeOffer`
   * takes. OpenSea signs only for the address that holds the NFT. Ask right before sending: the
   * signature lasts minutes.
   */
  async fulfillment(orderHash: string, protocolAddress: string, fulfiller: string, collection: string, tokenId: bigint): Promise<MarketFulfillment> {
    const data = (await this.call("/offers/fulfillment_data", {
      offer: { hash: orderHash, chain: this.chain, protocol_address: protocolAddress },
      fulfiller: { address: fulfiller },
      consideration: { asset_contract_address: collection, token_id: tokenId.toString() },
    })) as { fulfillment_data?: { transaction?: { input_data?: Record<string, unknown> } } };
    const input = data.fulfillment_data?.transaction?.input_data;
    if (!input) throw new OpenSeaError(502, "OpenSea sent no fulfillment data.");
    const picked = pickOrder(input, orderHash);
    const { order, criteriaProof } = picked;
    const expiresAt = zoneExpiration(order.extraData);
    const signedFor = zoneFulfiller(order.extraData);
    if (signedFor && signedFor.toLowerCase() !== fulfiller.toLowerCase()) throw new OpenSeaError(502, `OpenSea signed for ${signedFor}, not ${fulfiller}.`);
    return { offer: encodeAdvancedOrder(order, criteriaProof), expiresAt };
  }

  /** The best offer on one token (an item offer, or a criteria offer that takes it), or none. */
  private async bestOffer(slug: string, tokenId: bigint): Promise<RawOrder[]> {
    try {
      const data = (await this.call(`/offers/collection/${encodeURIComponent(slug)}/nfts/${tokenId}/best`)) as RawOrder;
      return data.order_hash ? [data] : [];
    } catch (error) {
      if (error instanceof OpenSeaError && error.status === 404) return [];
      throw error;
    }
  }

  /** The collection's offers (on any of its tokens), OpenSea's first page: its best. */
  private async collectionOffers(slug: string): Promise<RawOrder[]> {
    const data = (await this.call(`/offers/collection/${encodeURIComponent(slug)}`)) as { offers?: RawOrder[] };
    return data.offers ?? [];
  }

  /** OpenSea's name for the collection at `address`, kept once read. Null when OpenSea has none. */
  slugOf(address: string): Promise<string | null> {
    const key = address.toLowerCase();
    let slug = this.slugs.get(key);
    if (!slug) {
      slug = this.call(`/chain/${this.chain}/contract/${address}`).then(
        (data) => ((data as { collection?: string }).collection ?? null) || null,
        (error) => {
          this.slugs.delete(key);
          if (error instanceof OpenSeaError && error.status === 404) return null;
          throw error;
        },
      );
      this.slugs.set(key, slug);
    }
    return slug;
  }

  /** One usable `MarketOffer` out of an OpenSea row, or null: not WETH, another token, a trait offer, dead or ended. */
  private usable(raw: RawOrder, collection: string, tokenId: bigint, now: number): MarketOffer | null {
    const p = raw.protocol_data?.parameters;
    if (!raw.order_hash || !raw.protocol_address || !p) return null;
    if (raw.cancelled || raw.finalized || raw.marked_invalid) return null;
    if (raw.remaining_quantity !== undefined && raw.remaining_quantity !== null && Number(raw.remaining_quantity) === 0) return null;
    if (typeof raw.status === "string" && DEAD.has(raw.status.toLowerCase())) return null;
    const criteria = raw.criteria;
    if (criteria?.trait || criteria?.traits?.length || criteria?.numeric_traits?.length || criteria?.encoded_token_ids) return null;
    let parameters: SeaportOrderParameters;
    try {
      parameters = orderParameters(p);
    } catch {
      return null;
    }
    const endTime = Number(parameters.endTime);
    if (endTime <= now || Number(parameters.startTime) > now) return null;
    if (parameters.offer.length === 0 || !parameters.offer.every((o) => o.itemType === ITEM.ERC20 && o.token.toLowerCase() === this.weth && o.startAmount === o.endAmount)) return null;
    let fees = 0n;
    let nft: SeaportConsiderationItem | undefined;
    for (const c of parameters.consideration) {
      if (c.startAmount !== c.endAmount) return null;
      if (c.itemType === ITEM.ERC20 && c.token.toLowerCase() === this.weth) fees += c.startAmount;
      else if (!nft && c.token.toLowerCase() === collection.toLowerCase() && (c.itemType === ITEM.ERC721 ? c.identifierOrCriteria === tokenId : c.itemType === ITEM.ERC721_WITH_CRITERIA && c.identifierOrCriteria === 0n)) nft = c;
      else return null;
    }
    if (!nft || nft.startAmount === 0n) return null;
    const paid = parameters.offer.reduce((s, o) => s + o.startAmount, 0n);
    if (paid < fees) return null;
    return {
      orderHash: raw.order_hash,
      protocolAddress: raw.protocol_address,
      buyer: parameters.offerer,
      amount: (paid - fees) / nft.startAmount,
      endTime,
      anyToken: nft.itemType === ITEM.ERC721_WITH_CRITERIA,
      parameters,
    };
  }

  private async call(path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.base}${path}`, {
        method: body ? "POST" : "GET",
        headers: { accept: "application/json", "x-api-key": this.opts.apiKey, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new OpenSeaError(res.status, `OpenSea answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (error instanceof OpenSeaError) throw error;
      throw new OpenSeaError(503, `OpenSea could not be reached: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** An order as OpenSea's API lists it (the fields read here). */
interface RawOrder {
  order_hash?: string;
  protocol_address?: string;
  protocol_data?: { parameters?: Record<string, unknown>; signature?: string };
  cancelled?: boolean;
  finalized?: boolean;
  marked_invalid?: boolean;
  remaining_quantity?: number | string | null;
  status?: string;
  /** A criteria offer's scope: the collection, or some of its tokens (traits, or listed ids): those are left out. */
  criteria?: { trait?: unknown; traits?: unknown[] | null; numeric_traits?: unknown[] | null; encoded_token_ids?: string | null } | null;
}

/** `status` values OpenSea gives an offer that will not fill. */
const DEAD = new Set(["cancelled", "canceled", "expired", "filled", "fulfilled", "inactive", "invalid"]);

const big = (v: unknown): bigint => BigInt(typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? v : String(v));
const str = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("not a string");
  return v;
};

/** Seaport order parameters out of JSON (OpenSea's, or the API's), their numbers as bigints. */
export function orderParameters(p: Record<string, unknown>): SeaportOrderParameters {
  const item = (i: Record<string, unknown>): SeaportItem => ({
    itemType: Number(i.itemType),
    token: str(i.token),
    identifierOrCriteria: big(i.identifierOrCriteria),
    startAmount: big(i.startAmount),
    endAmount: big(i.endAmount),
  });
  return {
    offerer: str(p.offerer),
    zone: str(p.zone),
    offer: (p.offer as Record<string, unknown>[]).map(item),
    consideration: (p.consideration as Record<string, unknown>[]).map((c) => ({ ...item(c), recipient: str(c.recipient) })),
    orderType: Number(p.orderType),
    startTime: big(p.startTime),
    endTime: big(p.endTime),
    zoneHash: str(p.zoneHash),
    salt: big(p.salt),
    conduitKey: str(p.conduitKey),
    totalOriginalConsiderationItems: big(p.totalOriginalConsiderationItems ?? (p.consideration as unknown[]).length),
  };
}

/** The parameters as JSON carries them: every number a decimal string. */
export function orderParametersJson(p: SeaportOrderParameters): Record<string, unknown> {
  const item = (i: SeaportItem) => ({ itemType: i.itemType, token: i.token, identifierOrCriteria: i.identifierOrCriteria.toString(), startAmount: i.startAmount.toString(), endAmount: i.endAmount.toString() });
  return {
    offerer: p.offerer,
    zone: p.zone,
    offer: p.offer.map(item),
    consideration: p.consideration.map((c) => ({ ...item(c), recipient: c.recipient })),
    orderType: p.orderType,
    startTime: p.startTime.toString(),
    endTime: p.endTime.toString(),
    zoneHash: p.zoneHash,
    salt: p.salt.toString(),
    conduitKey: p.conduitKey,
    totalOriginalConsiderationItems: p.totalOriginalConsiderationItems.toString(),
  };
}

export function marketOfferJson(o: MarketOffer): MarketOfferJson {
  return { orderHash: o.orderHash, protocolAddress: o.protocolAddress, buyer: o.buyer, amount: o.amount.toString(), endTime: o.endTime, anyToken: o.anyToken, parameters: orderParametersJson(o.parameters) };
}

export function marketOfferFromJson(j: MarketOfferJson): MarketOffer {
  return { orderHash: j.orderHash, protocolAddress: j.protocolAddress, buyer: j.buyer, amount: BigInt(j.amount), endTime: Number(j.endTime), anyToken: !!j.anyToken, parameters: orderParameters(j.parameters) };
}

/** The buyer's order out of what OpenSea's fulfillment names (`matchAdvancedOrders` or `fulfillAdvancedOrder`), with its criteria proof. */
function pickOrder(input: Record<string, unknown>, orderHash: string): { order: AdvancedOrder; criteriaProof: string[] } {
  const raw = (input.orders as Record<string, unknown>[] | undefined) ?? [((input.advancedOrder ?? input.order) as Record<string, unknown> | undefined) ?? {}];
  const orders = raw.map((o) => ({
    parameters: orderParameters(o.parameters as Record<string, unknown>),
    numerator: big(o.numerator ?? 1),
    denominator: big(o.denominator ?? 1),
    signature: str(o.signature ?? "0x"),
    extraData: str(o.extraData ?? "0x"),
  }));
  // The buyer's: the one that offers the ERC-20 (the fulfiller's mirror, if any, offers the NFT).
  const index = orders.findIndex((o) => o.parameters.offer.length > 0 && o.parameters.offer.every((i) => i.itemType === ITEM.ERC20));
  if (index < 0) throw new OpenSeaError(502, `OpenSea's fulfillment of ${orderHash} holds no WETH offer.`);
  const resolvers = (input.criteriaResolvers as Record<string, unknown>[] | undefined) ?? [];
  const resolver = resolvers.find((r) => Number(r.orderIndex) === index && Number(r.side) === CONSIDERATION_SIDE);
  return { order: orders[index]!, criteriaProof: resolver ? (resolver.criteriaProof as string[]) : [] };
}

/**
 * The zone's `extraData` as OpenSea's signed zone (SIP-7) writes it: a version byte, the
 * fulfiller (20 bytes), the expiration (8 bytes, unix seconds), the signature (64 bytes), context.
 */
export function zoneExpiration(extraData: string): number | null {
  const hex = extraData.replace(/^0x/, "");
  if (hex.length < 2 * 93 || hex.slice(0, 2) !== "00") return null;
  return Number(BigInt("0x" + hex.slice(2 * 21, 2 * 29)));
}

export function zoneFulfiller(extraData: string): string | null {
  const hex = extraData.replace(/^0x/, "");
  if (hex.length < 2 * 93 || hex.slice(0, 2) !== "00") return null;
  return "0x" + hex.slice(2, 2 * 21);
}

/** abi.encode(AdvancedOrder, bytes32[] criteriaProof): what `finalizeOffer` and `VaultOffers.fill` take. */
export function encodeAdvancedOrder(order: AdvancedOrder, criteriaProof: string[] = []): string {
  return AbiCoder.defaultAbiCoder().encode([ADVANCED_ORDER_TYPE, "bytes32[]"], [order, criteriaProof]);
}

/** The order back out of what `finalizeOffer` takes. */
export function decodeAdvancedOrder(encoded: string): { order: AdvancedOrder; criteriaProof: string[] } {
  // ethers hands tuples back as arrays: read them by position, as the ABI lays them out.
  const [o, proof] = AbiCoder.defaultAbiCoder().decode([ADVANCED_ORDER_TYPE, "bytes32[]"], encoded) as unknown as [unknown[], string[]];
  const [p, numerator, denominator, signature, extraData] = o as [unknown[], bigint, bigint, string, string];
  const item = (i: unknown[]): SeaportItem => ({ itemType: Number(i[0]), token: String(i[1]), identifierOrCriteria: BigInt(i[2] as bigint), startAmount: BigInt(i[3] as bigint), endAmount: BigInt(i[4] as bigint) });
  return {
    order: {
      parameters: {
        offerer: String(p[0]),
        zone: String(p[1]),
        offer: [...(p[2] as unknown[][])].map(item),
        consideration: [...(p[3] as unknown[][])].map((c) => ({ ...item(c), recipient: String(c[5]) })),
        orderType: Number(p[4]),
        startTime: BigInt(p[5] as bigint),
        endTime: BigInt(p[6] as bigint),
        zoneHash: String(p[7]),
        salt: BigInt(p[8] as bigint),
        conduitKey: String(p[9]),
        totalOriginalConsiderationItems: BigInt(p[10] as bigint),
      },
      numerator: BigInt(numerator),
      denominator: BigInt(denominator),
      signature: String(signature),
      extraData: String(extraData),
    },
    criteriaProof: [...proof],
  };
}
