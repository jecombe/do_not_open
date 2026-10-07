import { whitelistTierOf } from "@dno/game-spec";
import { allowListAddress, byClaimRank, playerPoints, type PlayerPoints, type SettledDuel } from "@dno/chain-adapter/standings";
import { ALL_DUELS, settledDuels } from "../domain/standings";
import { normalizeAddress, type Address } from "../domain/types";
import { Unauthorized, type Clock, type SignatureVerifier } from "./auth";
import { BadRequest } from "./queries";
import type { Store } from "./ports/store";

/** A claim for a place on the mainnet allow list, kept as it was signed. */
export interface AllowListClaim {
  address: Address;
  /** The best points the player had at a claim: duels a test network redeployment forgets still count. */
  points: number;
  /** The last message the wallet signed (EIP-191), and its signature. */
  message: string;
  signature: string;
  /** Unix seconds, by this server's clock: the first claim, and the last one. */
  claimedAt: number;
  updatedAt: number;
}

export interface AllowListView {
  live: PlayerPoints;
  /** Whether this address holds a seat: it claimed and tried the testnet, or its X account did every task. */
  seated: boolean;
  /** Points from an X boarding pass linked to this wallet (0 without one). */
  bonus: number;
  points: number;
  claimedAt: number | null;
  rank: number | null;
  claimants: number;
  /** The cap on the list, or null: no cap, every claimant is on it. */
  places: number | null;
  /** The gift tier this wallet's rank would get if the list closed now (index into the spec's
   *  whitelist tiers), or null: not seated, or past the last tier. */
  tier: number | null;
}

export interface AllowListEntry {
  rank: number;
  address: Address;
  bonus: number;
  points: number;
  live: PlayerPoints;
  claimedAt: number;
  inPlace: boolean;
  /** Holds a seat: tried the testnet, or the X account the wallet is linked to did every task. */
  seated: boolean;
  /** The gift tier, counted among the seated claimants only; null for the others and past the last tier. */
  tier: number | null;
}

const MAX_MESSAGE = 1_000;
/** How long the public facts behind the points are reused, in seconds: quest platforms check
 *  addresses in bursts, and each read would otherwise load every duel and every opening. */
export const FACTS_TTL = 30;

type PublicFacts = { duels: SettledDuel[]; openers: Address[]; minters: Address[] };

/**
 * The mainnet allow list. A player claims a place by signing a message, free and off-chain; the
 * points come only from what the chain already made public about that address (the duels it
 * fought, the boxes it opened). Nobody is ranked who did not ask to be.
 */
export class AllowList {
  private cached: { at: number; facts: Promise<PublicFacts> } | null = null;

  constructor(
    private readonly store: Store,
    private readonly verifier: SignatureVerifier,
    private readonly clock: Clock,
    private readonly places: number | null,
    /** Extra points per wallet, from X boarding passes. None by default. */
    private readonly bonuses: () => Promise<Map<Address, number>> = async () => new Map(),
    /** The list's seats: a claimant who tried the testnet takes one. No cap by default. */
    private readonly seats: { admit(): Promise<void>; seatedPassOf(address: Address): Promise<boolean>; seatedPassWallets(): Promise<Set<Address>> } | null = null,
  ) {}

  async claim(rawAddress: string, message: string, signature: string): Promise<AllowListView> {
    const address = normalizeAddress(rawAddress);
    if (message.length > MAX_MESSAGE) throw new BadRequest("message too long");
    const named = allowListAddress(message);
    if (!named) throw new BadRequest("not a DO NOT OPEN allow list claim");
    if (named !== address) throw new BadRequest("the claim names another address");
    let signer: Address;
    try {
      signer = normalizeAddress(this.verifier.recover(message, signature));
    } catch {
      throw new Unauthorized("unreadable signature");
    }
    if (signer !== address) throw new Unauthorized("signed by another account");
    // A claim reads the chain's facts afresh, so a duel won a moment ago counts.
    const { live } = await this.facts(address, true);
    const kept = await this.store.allowListClaim(address);
    // Someone new who tried the testnet takes a seat, unless the X account their wallet is linked
    // to already has one. Someone who has not played yet claims without one, until they do.
    if (!kept && this.seats && (await this.players(true)).has(address) && !(await this.seats.seatedPassOf(address))) await this.seats.admit();
    const now = this.clock.now();
    await this.store.saveAllowListClaim({
      address,
      points: Math.max(live.points, kept?.points ?? 0),
      message,
      signature,
      claimedAt: kept?.claimedAt ?? now,
      updatedAt: now,
    });
    return this.status(address);
  }

  async status(rawAddress: string): Promise<AllowListView> {
    const address = normalizeAddress(rawAddress);
    const ranked = await this.ranked();
    const i = ranked.findIndex((e) => e.address === address);
    const mine = i >= 0 ? ranked[i]! : null;
    const live = mine ? mine.live : (await this.facts(address)).live;
    const bonus = mine ? mine.bonus : ((await this.bonuses()).get(address) ?? 0);
    const seated = (!!mine && (await this.players()).has(address)) || (!!this.seats && (await this.seats.seatedPassOf(address)));
    return { live, seated, bonus, points: mine?.points ?? live.points + bonus, claimedAt: mine?.claimedAt ?? null, rank: mine ? i + 1 : null, claimants: ranked.length, places: this.places, tier: mine?.tier ?? null };
  }

  /** Every claimant, best first: the list to export when it closes. The seated ones, in that
   *  order, get the gift tiers. */
  async ranked(): Promise<AllowListEntry[]> {
    const [claims, facts, bonuses, players, passWallets] = await Promise.all([
      this.store.allowListClaims(),
      this.publicFacts(),
      this.bonuses(),
      this.players(),
      this.seats ? this.seats.seatedPassWallets() : Promise.resolve(new Set<Address>()),
    ]);
    let seatedRank = 0;
    return claims
      .map((c) => {
        const live = playerPoints(c.address, facts.duels, facts.openers);
        const bonus = bonuses.get(c.address) ?? 0;
        return { address: c.address, bonus, points: Math.max(c.points, live.points) + bonus, claimedAt: c.claimedAt, live };
      })
      .sort(byClaimRank)
      .map((e, i) => {
        const seated = players.has(e.address) || passWallets.has(e.address);
        return { rank: i + 1, ...e, inPlace: this.places === null || i < this.places, seated, tier: seated ? whitelistTierOf(++seatedRank) : null };
      });
  }

  /** Addresses that tried the testnet: minted, opened a box, or fought a duel. Public facts only. */
  async players(fresh = false): Promise<Set<Address>> {
    const f = await this.publicFacts(fresh);
    const out = new Set<Address>([...f.minters, ...f.openers].map(normalizeAddress));
    for (const d of f.duels) {
      if (d.challenger.toLowerCase() === d.accepter.toLowerCase()) continue;
      out.add(normalizeAddress(d.challenger));
      out.add(normalizeAddress(d.accepter));
    }
    return out;
  }

  private async facts(address: Address, fresh = false): Promise<{ live: PlayerPoints }> {
    const f = await this.publicFacts(fresh);
    return { live: playerPoints(address, f.duels, f.openers) };
  }

  private publicFacts(fresh = false): Promise<PublicFacts> {
    const now = this.clock.now();
    if (!fresh && this.cached && now - this.cached.at < FACTS_TTL) return this.cached.facts;
    const facts = this.loadFacts();
    this.cached = { at: now, facts };
    // A failed read is not kept: the next call tries again.
    facts.catch(() => {
      if (this.cached?.facts === facts) this.cached = null;
    });
    return facts;
  }

  private async loadFacts(): Promise<PublicFacts> {
    const [duels, opened, minters] = await Promise.all([this.store.duels({ statuses: ["resolved"], limit: ALL_DUELS }), this.store.openedBoxes(), this.store.minters()]);
    return { duels: settledDuels(duels), openers: opened.flatMap((b) => (b.openedBy ? [b.openedBy] : [])), minters };
  }
}
