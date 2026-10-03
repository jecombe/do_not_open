import { digest, draftsFor, tallyOf, type HeraldContext } from "../domain/herald";
import type { LessonWriter } from "./lesson";
import type { Logger } from "./ports/logger";
import { NetworkBusy, type PostStore, type SocialNetwork } from "./ports/herald";
import type { Store } from "./ports/store";

export interface HeraldOptions extends HeraldContext {
  /** Posts sent per rolling 24 hours, at most: the network's free quota is small. */
  maxPerDay: number;
  /** Seconds between two posts sent, at least. */
  minGapSeconds: number;
  /** UTC hour after which the day's digest is written. Null: no digest. */
  digestHourUtc: number | null;
  /** The day's lesson on how the game works, written after this UTC hour. Absent: no lessons. */
  lesson?: { hourUtc: number; writer: LessonWriter } | null;
  /** A post still queued after this many seconds is dropped: old news. */
  staleAfterSeconds: number;
  /** Events read per pass. */
  batch: number;
  /** Tries before a post that keeps failing is given up. */
  maxAttempts: number;
}

export interface HeraldResult {
  queued: number;
  sent: string | null;
}

/**
 * The collection's account on a social network. Each pass reads the events indexed since the
 * last one, words the notable ones (`domain/herald`), queues them, writes the day's digest once
 * its hour has come, the day's lesson likewise, and sends at most one queued post, within the quota and the gap between
 * posts. On a first run it starts from the present: the history is not told again.
 * With a rehearsal network nothing leaves: posts are kept, marked "rehearsed", to be read first.
 */
export class Herald {
  constructor(
    private readonly store: Store & PostStore,
    private readonly network: SocialNetwork,
    private readonly opts: HeraldOptions,
    private readonly log: Logger,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async run(): Promise<HeraldResult> {
    const queued = (await this.compose()) + (await this.composeLesson()) + (await this.composeDigest());
    const sent = await this.publish();
    return { queued, sent };
  }

  private async compose(): Promise<number> {
    let cursor = await this.store.heraldCursor();
    if (!cursor) {
      const indexed = await this.store.cursor();
      if (indexed === null) return 0;
      // Everything up to now is history: start after it.
      await this.store.queuePosts([], { block: indexed, logIndex: 2 ** 31 - 1 }, this.now());
      this.log.info({ block: indexed }, "herald starts from the present");
      return 0;
    }
    const events = await this.store.transaction((tx) => tx.storedEvents(cursor, this.opts.batch));
    if (!events.length) return 0;
    const last = events[events.length - 1]!.event;
    const drafts = draftsFor(events, this.opts);
    return this.store.queuePosts(drafts, { block: last.block, logIndex: last.logIndex }, this.now());
  }

  private async composeDigest(): Promise<number> {
    if (this.opts.digestHourUtc === null) return 0;
    const now = this.now();
    const date = new Date(now * 1000);
    if (date.getUTCHours() < this.opts.digestHourUtc) return 0;
    const day = date.toISOString().slice(0, 10);
    if (await this.store.hasPost(`digest:${day}`)) return 0;
    // The last 24 hours, newest first: stop at the first event older than that.
    const since = now - 86_400;
    const recent = (await this.store.activity({ limit: 5_000 })).filter((e) => e.timestamp !== null && e.timestamp >= since);
    const cursor = await this.store.heraldCursor();
    if (!cursor) return 0;
    // A quiet day still records its digest, as skipped, so it is not reconsidered every pass.
    const draft = digest(day, tallyOf(recent)) ?? { key: `digest:${day}`, kind: "digest" as const, text: "", skipped: "nothing happened" };
    return this.store.queuePosts([draft], cursor, now);
  }

  private async composeLesson(): Promise<number> {
    const lesson = this.opts.lesson;
    if (!lesson) return 0;
    const now = this.now();
    const date = new Date(now * 1000);
    if (date.getUTCHours() < lesson.hourUtc) return 0;
    const day = date.toISOString().slice(0, 10);
    if (await this.store.hasPost(`lesson:${day}`)) return 0;
    const cursor = await this.store.heraldCursor();
    if (!cursor) return 0;
    const draft = await lesson.writer.write(day);
    return draft ? this.store.queuePosts([draft], cursor, now) : 0;
  }

  /** Sends the oldest queued post, if its turn has come. Returns its key, or null. */
  private async publish(): Promise<string | null> {
    const now = this.now();
    let post = await this.store.nextQueuedPost();
    while (post && now - post.createdAt > this.opts.staleAfterSeconds) {
      await this.store.updatePost(post.id, { status: "skipped", error: "stale" });
      post = await this.store.nextQueuedPost();
    }
    if (!post) return null;

    const rehearsal = this.network.name === "rehearsal";
    if (!rehearsal) {
      const last = await this.store.lastPostedAt();
      if (last !== null && now - last < this.opts.minGapSeconds) return null;
      if ((await this.store.postedSince(now - 86_400)) >= this.opts.maxPerDay) return null;
    }

    try {
      const sent = await this.network.post(post.text);
      await this.store.updatePost(post.id, sent ? { status: "posted", postedAt: now, externalId: sent.id, url: sent.url, error: null } : { status: "rehearsed", postedAt: now });
      this.log.info({ key: post.key, network: this.network.name, url: sent?.url }, sent ? "herald posted" : "herald rehearsed a post");
      return post.key;
    } catch (error) {
      const attempts = post.attempts + 1;
      const busy = error instanceof NetworkBusy;
      const failed = !busy && attempts >= this.opts.maxAttempts;
      await this.store.updatePost(post.id, { attempts: busy ? post.attempts : attempts, status: failed ? "failed" : "queued", error: (error as Error).message });
      this.log.warn({ key: post.key, attempts, err: (error as Error).message }, failed ? "herald gave up a post" : "herald could not post, will retry");
      return null;
    }
  }
}
