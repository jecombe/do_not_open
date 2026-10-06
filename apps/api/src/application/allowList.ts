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
  points: number;
  claimedAt: number | null;
  rank: number | null;
  claimants: number;
  places: number;
}

export interface AllowListEntry {
  rank: number;
  address: Address;
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
    private readonly places: number,
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
    const live = i >= 0 ? ranked[i]!.live : (await this.facts(address)).live;
    const mine = i >= 0 ? ranked[i]! : null;
    return { live, points: mine?.points ?? live.points, claimedAt: mine?.claimedAt ?? null, rank: mine ? i + 1 : null, claimants: ranked.length, places: this.places };
  }

  /** Every claimant, best first: the list to export when it closes. */
  async ranked(): Promise<AllowListEntry[]> {
    const [claims, facts] = await Promise.all([this.store.allowListClaims(), this.publicFacts()]);
    return claims
      .map((c) => {
        const live = playerPoints(c.address, facts.duels, facts.openers);
        return { address: c.address, points: Math.max(c.points, live.points), claimedAt: c.claimedAt, live };
      })
      .sort(byClaimRank)
      .map((e, i) => ({ rank: i + 1, ...e, inPlace: i < this.places }));
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
