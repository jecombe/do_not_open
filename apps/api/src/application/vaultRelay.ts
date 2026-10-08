import type { Clock } from "./auth";
import type { VaultFinalizeTx, VaultRequestTx, VaultSender } from "./ports/vault";
import type { Address } from "../domain/types";

export type VaultRelayRefusal = "reverted" | "daily-cap";

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
 * can neither read it, change the terms, nor reuse it. It pays the gas, so it keeps a daily cap
 * per process (the per-IP rate limit is the HTTP layer's).
 */
export class VaultRelay {
  private day = -1;
  private sentToday = 0;

  constructor(
    private readonly sender: VaultSender,
    private readonly clock: Clock,
    private readonly perDay: number,
  ) {}

  get address(): Address {
    return this.sender.address;
  }

  request(tx: VaultRequestTx): Promise<string> {
    return this.spend(() => this.sender.request(tx));
  }

  finalize(tx: VaultFinalizeTx): Promise<string> {
    return this.spend(() => this.sender.finalize(tx));
  }

  private async spend(send: () => Promise<string>): Promise<string> {
    const day = Math.floor(this.clock.now() / 86_400);
    if (day !== this.day) {
      this.day = day;
      this.sentToday = 0;
    }
    if (this.sentToday >= this.perDay) throw new VaultRelayRefused("daily-cap", "The vault relayer sent all it may today. Send the request from your wallet, or try tomorrow.");
    const hash = await send();
    this.sentToday += 1;
    return hash;
  }
}
