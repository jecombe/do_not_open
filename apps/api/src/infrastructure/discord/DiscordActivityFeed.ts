import { activityText, type Activity, type ActivityFeed } from "../../application/activity";

/** Discord's limit on a message's text. */
const MAX_CONTENT = 2000;

interface Log {
  warn(obj: object, msg: string): void;
}

/**
 * Tells the team's private channel what players do, through one of its webhooks. Messages go
 * out one at a time, in order; a request never waits on them. Past `maxQueued` waiting (a flood,
 * Discord down), new ones are dropped and counted, and the next message that goes out says how
 * many. Mentions are never parsed, so an idea's text can't ping anyone.
 */
export class DiscordActivityFeed implements ActivityFeed {
  private queue: string[] = [];
  private sending = false;
  private dropped = 0;

  constructor(
    /** https://discord.com/api/webhooks/<id>/<token> */
    private readonly webhookUrl: string,
    private readonly log: Log,
    private readonly opts: { prefix?: string; maxQueued?: number; timeoutMs?: number; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  tell(activity: Activity): void {
    if (this.queue.length >= (this.opts.maxQueued ?? 50)) {
      this.dropped++;
      return;
    }
    // The network first: testnet and mainnet may share the channel.
    this.queue.push(`${this.opts.prefix ?? ""}${activityText(activity)}`);
    void this.drain();
  }

  /** Resolves once every queued message went out or was given up on (tests). */
  async idle(): Promise<void> {
    while (this.sending || this.queue.length) await new Promise((r) => setTimeout(r, 5));
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const dropped = this.dropped;
        this.dropped = 0;
        const text = this.queue.shift()! + (dropped ? `\n_(${dropped} more dropped: too many at once)_` : "");
        // A message that did not go out hands its count of dropped ones to the next.
        if (!(await this.send(text))) this.dropped += dropped;
      }
    } finally {
      this.sending = false;
    }
  }

  /** One message, tried again once after a rate limit; any other failure is logged and dropped. True: it went out. */
  private async send(text: string): Promise<boolean> {
    const fetcher = this.opts.fetcher ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetcher(this.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: text.slice(0, MAX_CONTENT), allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        });
        if (res.status === 429 && attempt === 0) {
          const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
          const after = Number(body?.retry_after ?? res.headers.get("retry-after"));
          await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2_000, 30_000));
          continue;
        }
        if (!res.ok) this.log.warn({ status: res.status }, "activity feed: Discord refused a message");
        return res.ok;
      } catch (error) {
        this.log.warn({ err: error }, "activity feed: Discord did not answer");
        return false;
      }
    }
    return false;
  }
}
