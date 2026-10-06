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
  /** Points from an X boarding pass linked to this wallet (0 without one). */
  bonus: number;
  points: number;
  claimedAt: number | null;
  rank: number | null;
  claimants: number;
  /** The cap on the list, or null: no cap, every claimant is on it. */
  places: number | null;
}

export interface AllowListEntry {
  rank: number;
  address: Address;
  bonus: number;
  points: number;
  live: PlayerPoints;
  claimedAt: number;
  inPlace: boolean;
}

const MAX_MESSAGE = 1_000;
/** How long the public facts behind the points are reused, in seconds: quest platforms check
 *  addresses in bursts, and each read would otherwise load every duel and every opening. */
export const FACTS_TTL = 30;

type PublicFacts = { duels: SettledDuel[]; openers: Address[] };

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
    /** The list's seats: a new claimant needs one. No cap by default. */
    private readonly seats: { admit(): Promise<void> } | null = null,
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
    // Someone new needs a seat; a wallet already linked to a boarded X account has one.
    if (!kept && this.seats && !(await this.store.xPassByAddress(address))?.handle) await this.seats.admit();
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
    return { live, bonus, points: mine?.points ?? live.points + bonus, claimedAt: mine?.claimedAt ?? null, rank: mine ? i + 1 : null, claimants: ranked.length, places: this.places };
  }

  /** Every claimant, best first: the list to export when it closes. */
  async ranked(): Promise<AllowListEntry[]> {
    const [claims, facts, bonuses] = await Promise.all([this.store.allowListClaims(), this.publicFacts(), this.bonuses()]);
    return claims
      .map((c) => {
        const live = playerPoints(c.address, facts.duels, facts.openers);
        const bonus = bonuses.get(c.address) ?? 0;
        return { address: c.address, bonus, points: Math.max(c.points, live.points) + bonus, claimedAt: c.claimedAt, live };
      })
      .sort(byClaimRank)
      .map((e, i) => ({ rank: i + 1, ...e, inPlace: this.places === null || i < this.places }));
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
    const [duels, opened] = await Promise.all([this.store.duels({ statuses: ["resolved"], limit: ALL_DUELS }), this.store.openedBoxes()]);
    return { duels: settledDuels(duels), openers: opened.flatMap((b) => (b.openedBy ? [b.openedBy] : [])) };
  }
}
