import type { Clock } from "./auth";
import type { PocketCall, PocketTxs, VaultFinalizeTx, VaultRequestTx, VaultSender } from "./ports/vault";
import type { Address } from "../domain/types";

export type VaultRelayRefusal = "reverted" | "daily-cap";
export type VaultRelayKind = "request" | "finalize" | PocketCall;
/** How a relay ended: sent, refused (the vault would revert, or the day's cap), or failed sending. */
export type VaultRelayOutcome = "sent" | VaultRelayRefusal | "failed";

/** A relayed transaction turned away: nothing was sent. */
export class VaultRelayRefused extends Error {
  constructor(
    readonly code: VaultRelayRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The sealed vault's relayer: it sends holders' requests and their proofs from its own wallet,
 * so the holder's address appears in no transaction. It learns nothing a chain observer would
 * not: the key arrives encrypted for the vault and bound to the request's terms, so the relayer
 * can neither read it, change the terms, nor reuse it. It sends the pockets' opens and spends and
 * the desk's purchases the same way: keys bound to their terms, amounts encrypted, so it learns
 * neither who pays whom nor how much. It pays the gas, so it keeps a daily cap
 * per process (the per-IP rate limit is the HTTP layer's).
 */
export class VaultRelay {
  private day = -1;
  private sentToday = 0;
  /** What this process relayed since it started, by transaction and outcome: the monitoring's counter. */
  readonly outcomes = new Map<`${VaultRelayKind}:${VaultRelayOutcome}`, number>();

  constructor(
    private readonly sender: VaultSender,
    private readonly clock: Clock,
    private readonly perDay: number,
  ) {}

  get address(): Address {
    return this.sender.address;
  }

  /** Sent today (UTC) by this process, out of its daily cap. */
  today(): { sent: number; perDay: number } {
    this.roll();
    return { sent: this.sentToday, perDay: this.perDay };
  }

  /** The relayer wallet's balance in wei, or null when the sender cannot tell. */
  balance(): Promise<bigint | null> {
    return this.sender.balance ? this.sender.balance() : Promise.resolve(null);
  }

  request(tx: VaultRequestTx): Promise<string> {
    return this.spend("request", () => this.sender.request(tx));
  }

  finalize(tx: VaultFinalizeTx): Promise<string> {
    return this.spend("finalize", () => this.sender.finalize(tx));
  }

  pockets<C extends PocketCall>(call: C, tx: PocketTxs[C]): Promise<string> {
    return this.spend(call, () => this.sender.pockets(call, tx));
  }

  private roll() {
    const day = Math.floor(this.clock.now() / 86_400);
    if (day !== this.day) {
      this.day = day;
      this.sentToday = 0;
    }
  }

  private count(kind: VaultRelayKind, outcome: VaultRelayOutcome) {
    const key = `${kind}:${outcome}` as const;
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
  }

  private async spend(kind: VaultRelayKind, send: () => Promise<string>): Promise<string> {
    this.roll();
    if (this.sentToday >= this.perDay) {
      this.count(kind, "daily-cap");
      throw new VaultRelayRefused("daily-cap", "The vault relayer sent all it may today. Send the request from your wallet, or try tomorrow.");
    }
    let hash: string;
    try {
      hash = await send();
    } catch (error) {
      this.count(kind, error instanceof VaultRelayRefused ? error.code : "failed");
      throw error;
    }
    this.sentToday += 1;
    this.count(kind, "sent");
    return hash;
  }
}
