import type { Address } from "../domain/types";
import type { Store } from "./ports/store";

/**
 * The mainnet list's seats: one per person, first come, first served. A person is an X account
 * proved on a boarding pass, or a wallet that claimed a place without one; an X account and the
 * wallet linked to it are one person. Once the seats are taken, nobody new gets in; those inside
 * keep doing their tasks, linking a wallet and updating their points.
 */
export interface SeatsView {
  taken: number;
  /** null: no cap. */
  places: number | null;
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
  ) {}

  async taken(): Promise<number> {
    const [passes, claims] = await Promise.all([this.store.xPasses(), this.store.allowListClaims()]);
    const linked = new Set<Address>();
    let boarded = 0;
    for (const p of passes) {
      if (!p.handle) continue;
      boarded++;
      if (p.address) linked.add(p.address);
    }
    return boarded + claims.filter((c) => !linked.has(c.address)).length;
  }

  async view(): Promise<SeatsView> {
    return { taken: await this.taken(), places: this.places };
  }

  /** Throws `ListFull` when someone new asks for a seat and none is left. */
  async admit(): Promise<void> {
    if (this.places !== null && (await this.taken()) >= this.places) throw new ListFull();
  }
}
