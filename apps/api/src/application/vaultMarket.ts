import type { MarketFulfillment, MarketOffer } from "@dno/chain-adapter/opensea";
import type { Clock } from "./auth";

/** Where a marketplace's offers come from: OpenSea's API (`OpenSeaOffers` in chain-adapter), or a fake in tests. */
export interface OfferSource {
  offers(collection: string, tokenId: bigint): Promise<MarketOffer[]>;
  fulfillment(orderHash: string, protocolAddress: string, fulfiller: string, collection: string, tokenId: bigint): Promise<MarketFulfillment>;
}

/**
 * The marketplace's offers for the sealed vault's page: OpenSea's on mainnet, read with the
 * API's key, which never reaches a browser. The offers on a token are read once every
 * `ttl` seconds for everyone who asks (the page reads them when a box opens); the order that fills one,
 * signed by OpenSea's zone for the vault (`fulfiller`: the NFT's holder, which sends the fill to
 * Seaport) for a few minutes, is asked for each fill, right before `finalizeOffer`. Nothing here learns who holds the box: it reads what
 * opensea.io shows anyone.
 */
export class VaultMarket {
  private readonly cache = new Map<string, { at: number; offers: Promise<MarketOffer[]> }>();

  constructor(
    readonly name: string,
    private readonly source: OfferSource,
    /** The address OpenSea signs the fills for: the vault, which holds the NFT and calls Seaport. */
    readonly fulfiller: string,
    private readonly clock: Clock,
    private readonly ttl = 15,
  ) {}

  /** The live offers on `tokenId` of `collection`, best first; the last reading within `ttl` seconds. */
  offers(collection: string, tokenId: bigint): Promise<MarketOffer[]> {
    const key = `${collection.toLowerCase()}:${tokenId}`;
    const now = this.clock.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttl) return hit.offers;
    const offers = this.source.offers(collection, tokenId);
    this.cache.set(key, { at: now, offers });
    offers.catch(() => this.cache.delete(key));
    if (this.cache.size > 500) for (const [k, v] of this.cache) if (now - v.at >= this.ttl) this.cache.delete(k);
    return offers;
  }

  /** The order that fills `orderHash` with the token, signed for `fulfiller`. Never cached. */
  async fulfillment(orderHash: string, collection: string, tokenId: bigint): Promise<MarketFulfillment> {
    const offer = (await this.offers(collection, tokenId)).find((o) => o.orderHash.toLowerCase() === orderHash.toLowerCase());
    if (!offer) throw new VaultMarketRefused("not-found", "No such offer on the marketplace for this token.");
    return this.source.fulfillment(orderHash, offer.protocolAddress, this.fulfiller, collection, tokenId);
  }
}

export class VaultMarketRefused extends Error {
  constructor(
    readonly code: "not-found",
    message: string,
  ) {
    super(message);
  }
}
