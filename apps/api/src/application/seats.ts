import type { Address } from "../domain/types";
import type { Store } from "./ports/store";
import { TASK_FIELD, type XPass, type XTask } from "./xPass";

/**
 * The mainnet list's seats, first come, first served, one per person. A person takes a seat
 * either way:
 *
 *   - X: their account is connected on a boarding pass and every required task is done;
 *   - the testnet: their wallet claimed a place and tried the game (minted, opened a box or
 *     fought a duel, all public facts).
 *
 * An X account and the wallet linked to it are one person. Once the seats are taken, nobody new
 * sits down; those seated keep their seat. A claimant who plays only after claiming sits down
 * then, without a check: the count can go a little past the places, and the export ranks them.
 */
export interface SeatsView {
  taken: number;
  /** null: no cap. */
  places: number | null;
  /** The tasks on X a pass needs for a seat. */
  required: readonly XTask[];
}

/** Refused: every seat is taken, and this is someone new. */
export class ListFull extends Error {
  constructor() {
    super("every seat on the mainnet list is taken");
  }
}

export class Seats {
  constructor(
    private readonly store: Store,
    readonly places: number | null,
    /** Addresses that tried the testnet. */
    private readonly players: () => Promise<Set<Address>>,
    /** The tasks on X a pass needs: like, reply and repost only once there is an announcement. */
    readonly required: readonly XTask[],
  ) {}

  /** Whether a pass holds a seat: its X account is connected and every required task is done. */
  passSeated(p: XPass): boolean {
    return !!p.handle && this.required.every((t) => p[TASK_FIELD[t]] !== null);
  }

  /** Whether the X account this wallet is linked to holds a seat. */
  async seatedPassOf(address: Address): Promise<boolean> {
    const p = await this.store.xPassByAddress(address);
    return !!p && this.passSeated(p);
  }

  async taken(): Promise<number> {
    const [passes, claims, players] = await Promise.all([this.store.xPasses(), this.store.allowListClaims(), this.players()]);
    const linked = new Set<Address>();
    let seated = 0;
    for (const p of passes) {
      if (!this.passSeated(p)) continue;
      seated++;
      if (p.address) linked.add(p.address);
    }
    return seated + claims.filter((c) => players.has(c.address) && !linked.has(c.address)).length;
  }

  async view(): Promise<SeatsView> {
    return { taken: await this.taken(), places: this.places, required: this.required };
  }

  /** Throws `ListFull` when someone new is about to sit down and no seat is left. */
  async admit(): Promise<void> {
    if (this.places !== null && (await this.taken()) >= this.places) throw new ListFull();
  }
}
