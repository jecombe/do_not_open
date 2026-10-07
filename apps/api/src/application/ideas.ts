import { noActivityFeed, type ActivityFeed } from "./activity";
import type { Clock } from "./auth";
import { BadRequest } from "./queries";
import type { Store } from "./ports/store";

/** An idea a player left in the boarding page's suggestion box. Private: only the team reads them. */
export interface Idea {
  id: number;
  text: string;
  /** The X handle of the pass the browser holds, when there is one. */
  handle: string | null;
  /** The page's language. */
  locale: string;
  /** Unix seconds. */
  createdAt: number;
}

export const IDEA_MIN = 10;
export const IDEA_MAX = 600;

/**
 * The suggestion box. Anyone can drop an idea; nobody but the team reads them back. A handle is
 * attached only from the player's own boarding pass, never typed in, so nobody signs for someone
 * else. The same text twice is kept once.
 */
export class Ideas {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    /** The X handle behind a boarding pass token, or null. */
    private readonly handleOf: (passToken: string) => Promise<string | null> = async () => null,
    /** The team's private channel, told of each new idea. */
    private readonly feed: ActivityFeed = noActivityFeed,
  ) {}

  async submit(rawText: string, locale: string, passToken: string): Promise<{ received: number }> {
    const text = rawText.replace(/\s+/g, " ").trim();
    if (text.length < IDEA_MIN) throw new BadRequest(`an idea needs at least ${IDEA_MIN} characters`);
    if (text.length > IDEA_MAX) throw new BadRequest(`an idea fits in ${IDEA_MAX} characters`);
    const handle = passToken ? await this.handleOf(passToken).catch(() => null) : null;
    const before = await this.store.ideaCount();
    await this.store.saveIdea({ text, handle, locale: locale.slice(0, 8), createdAt: this.clock.now() });
    const received = await this.store.ideaCount();
    // The same text twice is kept once: only a new idea is told.
    if (received > before) this.feed.tell({ kind: "idea", handle, text, locale: locale.slice(0, 8) });
    return { received };
  }

  count(): Promise<number> {
    return this.store.ideaCount();
  }

  all(): Promise<Idea[]> {
    return this.store.ideas();
  }
}
