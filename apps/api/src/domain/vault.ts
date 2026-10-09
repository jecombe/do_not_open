import type { ProtocolEvent } from "./events";
import type { Address } from "./types";

/** What a vault request asks, in the contract's order (SealedVault.Action). */
export type VaultAction = "withdraw" | "list" | "unlist" | "claim";
export const VAULT_ACTIONS: readonly VaultAction[] = ["withdraw", "list", "unlist", "claim"];

/** How a vault request ended: done, a wrong key (refused), a box that changed first (stale), or no proof within a day (expired). */
export type VaultRequestOutcome = "done" | "refused" | "stale" | "expired";

/** Where a vault box stands, as its public events tell (SealedVault.BoxState). */
export type VaultBoxState = "sealed" | "listed" | "sold" | "withdrawn" | "claimed";
export const VAULT_BOX_STATES: readonly VaultBoxState[] = ["sealed", "listed", "sold", "withdrawn", "claimed"];

export type VaultEvent = Extract<ProtocolEvent, { name: `Vault${string}` }>;

/**
 * The vault in numbers, folded from its public events: every box's state, its Seaport listings
 * and sales, the private sales offered and settled (never their price nor whether one moved
 * anything: that is encrypted), and its requests. Nothing about who holds what.
 */
export interface VaultSummary {
  boxes: Record<VaultBoxState, number>;
  deposits: number;
  withdrawals: number;
  /** Seaport listings ever placed, and those live now (listed, not yet sold, taken down or expired). */
  listings: number;
  listed: number;
  unlisted: number;
  expired: number;
  seaportSales: number;
  /** Wei: what Seaport buyers paid, and what holders collected from sales (the fee taken). */
  seaportVolume: string;
  claimed: string;
  privateSales: { offered: number; settled: number; cancelled: number; open: number };
  requests: { placed: Record<VaultAction, number>; settled: Record<VaultRequestOutcome, number>; pending: number };
  collections: { collection: Address; deposits: number; inVault: number }[];
}

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** In the vault: sealed, listed or sold but not yet collected. */
const HELD: readonly VaultBoxState[] = ["sealed", "listed", "sold"];

export function summarizeVault(events: readonly ProtocolEvent[]): VaultSummary {
  const state = new Map<number, VaultBoxState>();
  const collectionOf = new Map<number, Address>();
  const live = new Set<number>();
  const sales = new Map<number, "open" | "settled" | "cancelled">();
  const pending = new Set<number>();
  const s: VaultSummary = {
    boxes: zeros(VAULT_BOX_STATES),
    deposits: 0,
    withdrawals: 0,
    listings: 0,
    listed: 0,
    unlisted: 0,
    expired: 0,
    seaportSales: 0,
    seaportVolume: "0",
    claimed: "0",
    privateSales: { offered: 0, settled: 0, cancelled: 0, open: 0 },
    requests: { placed: zeros(VAULT_ACTIONS), settled: zeros(["done", "refused", "stale", "expired"] as const), pending: 0 },
    collections: [],
  };
  let volume = 0n;
  let claimed = 0n;
  for (const e of events) {
    switch (e.name) {
      case "VaultDeposited":
        s.deposits++;
        state.set(e.boxId, "sealed");
        collectionOf.set(e.boxId, e.collection);
        break;
      case "VaultWithdrawn":
        s.withdrawals++;
        state.set(e.boxId, "withdrawn");
        break;
      case "VaultListed":
        s.listings++;
        live.add(e.listingId);
        state.set(e.boxId, "listed");
        break;
      case "VaultUnlisted":
      case "VaultListingExpired":
        if (e.name === "VaultUnlisted") s.unlisted++;
        else s.expired++;
        live.delete(e.listingId);
        state.set(e.boxId, "sealed");
        break;
      case "VaultSoldOnSeaport":
        s.seaportSales++;
        volume += BigInt(e.price);
        live.delete(e.listingId);
        state.set(e.boxId, "sold");
        break;
      case "VaultClaimed":
        claimed += BigInt(e.amount);
        state.set(e.boxId, "claimed");
        break;
      case "VaultSaleOffered":
        s.privateSales.offered++;
        sales.set(e.saleId, "open");
        break;
      case "VaultSaleSettled":
        s.privateSales.settled++;
        sales.set(e.saleId, "settled");
        break;
      case "VaultSaleCancelled":
        s.privateSales.cancelled++;
        sales.set(e.saleId, "cancelled");
        break;
      case "VaultRequestPlaced":
        s.requests.placed[e.action]++;
        pending.add(e.requestId);
        break;
      case "VaultRequestSettled":
        s.requests.settled[e.status]++;
        pending.delete(e.requestId);
        break;
    }
  }
  for (const st of state.values()) s.boxes[st]++;
  s.listed = live.size;
  s.seaportVolume = volume.toString();
  s.claimed = claimed.toString();
  s.privateSales.open = [...sales.values()].filter((v) => v === "open").length;
  s.requests.pending = pending.size;
  const byCollection = new Map<Address, { deposits: number; inVault: number }>();
  for (const [boxId, collection] of collectionOf) {
    const row = byCollection.get(collection) ?? { deposits: 0, inVault: 0 };
    row.deposits++;
    if (HELD.includes(state.get(boxId)!)) row.inVault++;
    byCollection.set(collection, row);
  }
  s.collections = [...byCollection].map(([collection, r]) => ({ collection, ...r })).sort((a, b) => b.deposits - a.deposits);
  return s;
}

/** A vault event for the admin site's feed: what happened to which box, never to whom. */
export interface VaultFeedItem {
  at: number | null;
  block: number;
  txHash: string;
  name: VaultEvent["name"];
  boxId: number | null;
  /** The request's action or outcome, a sale's or a listing's id, a price in wei: whatever the event adds. */
  detail: string | null;
}

export function feedItemOf(e: VaultEvent): VaultFeedItem {
  const boxId = "boxId" in e ? e.boxId : null;
  const detail =
    e.name === "VaultRequestPlaced" ? e.action
    : e.name === "VaultRequestSettled" ? e.status
    : e.name === "VaultListed" || e.name === "VaultSoldOnSeaport" ? e.price
    : e.name === "VaultClaimed" ? e.amount
    : e.name === "VaultSaleSettled" || e.name === "VaultSaleCancelled" ? `#${e.saleId}`
    : null;
  return { at: e.timestamp, block: e.block, txHash: e.txHash, name: e.name, boxId, detail };
}
