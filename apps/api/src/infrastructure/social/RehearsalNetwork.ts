import type { SocialNetwork } from "../../application/ports/herald";
import type { Logger } from "../../application/ports/logger";

/** Sends nothing: each post is logged and kept as "rehearsed", to be read before going live. */
export class RehearsalNetwork implements SocialNetwork {
  readonly name = "rehearsal";

  constructor(private readonly log: Logger) {}

  async post(text: string) {
    this.log.info({ text }, "herald rehearsal");
    return null;
  }
}
