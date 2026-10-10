import { marketOfferFromJson, type MarketFulfillment, type MarketOffer, type MarketOfferJson } from "../opensea";

/**
 * The marketplace's offers, through the API: OpenSea's on mainnet, read with the API's key (it
 * never reaches the page). The offers on a token come as the board's do; the order that fills
 * one, signed by OpenSea's zone for `VaultOffers`, is asked right before `finalizeOffer`.
 */
export class VaultMarket {
  constructor(
    private readonly base: string,
    /** The marketplace's name: "opensea". */
    readonly name: string,
    /** The address OpenSea signs the fills for: `VaultOffers`. */
    readonly fulfiller: string,
  ) {}

  /** The marketplace `apiUrl` reads, or null when it reads none (a test network) or is down. */
  static async find(apiUrl: string): Promise<VaultMarket | null> {
    const base = apiUrl.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/v1/vault/market`);
      if (!res.ok) return null;
      const { data } = (await res.json()) as { data?: { name?: string | null; fulfiller?: string | null } };
      return data?.name && data.fulfiller ? new VaultMarket(base, data.name, data.fulfiller) : null;
    } catch {
      return null;
    }
  }

  /** The live offers on `tokenId` of `collection`, best first. */
  async offers(collection: string, tokenId: bigint): Promise<MarketOffer[]> {
    const res = await fetch(`${this.base}/v1/vault/offers/${collection}/${tokenId}`);
    if (!res.ok) throw new Error(`The API answered ${res.status} for the marketplace's offers.`);
    const { data } = (await res.json()) as { data?: { offers?: MarketOfferJson[] } };
    return (data?.offers ?? []).map(marketOfferFromJson);
  }

  /** The order that fills `orderHash` with the token, signed for `fulfiller` for a few minutes. */
  async fulfillment(orderHash: string, collection: string, tokenId: bigint): Promise<MarketFulfillment> {
    const res = await fetch(`${this.base}/v1/vault/offers/fulfillment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderHash, collection, tokenId: tokenId.toString() }),
    });
    const body = (await res.json().catch(() => ({}))) as { offer?: string; expiresAt?: number | null; error?: string };
    if (!res.ok || !body.offer) throw new Error(body.error ?? `The API answered ${res.status} for the offer's fulfillment.`);
    return { offer: body.offer, expiresAt: body.expiresAt ?? null };
  }
}
