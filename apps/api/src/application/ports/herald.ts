import type { Draft, PostKind } from "../../domain/herald";

/** "rehearsed": written and kept, never sent (no network). "skipped": too old by the time its turn came. */
export type PostStatus = "queued" | "posted" | "rehearsed" | "skipped" | "failed";

export interface Post {
  id: number;
  key: string;
  kind: PostKind;
  text: string;
  status: PostStatus;
  /** Unix seconds. */
  createdAt: number;
  postedAt: number | null;
  /** The network's id for it, and where to see it. */
  externalId: string | null;
  url: string | null;
  attempts: number;
  error: string | null;
}

/** Where the herald has read the events up to. */
export interface EventPosition {
  block: number;
  logIndex: number;
}

/** A draft to queue; with `skipped`, it is recorded as done without ever being sent (a quiet day's digest). */
export type QueuedDraft = Draft & { skipped?: string };

/** The herald's queue of posts. Not a read model: a replay of the chain keeps it. */
export interface PostStore {
  heraldCursor(): Promise<EventPosition | null>;
  /** Queues the drafts whose key was never queued and moves the cursor, in one go. Returns how many were new. */
  queuePosts(drafts: QueuedDraft[], cursor: EventPosition, now: number): Promise<number>;
  /** The oldest post still waiting its turn. */
  nextQueuedPost(): Promise<Post | null>;
  updatePost(id: number, patch: Partial<Pick<Post, "status" | "postedAt" | "externalId" | "url" | "attempts" | "error">>): Promise<void>;
  hasPost(key: string): Promise<boolean>;
  /** Posts actually sent since `since` (unix seconds). */
  postedSince(since: number): Promise<number>;
  lastPostedAt(): Promise<number | null>;
  /** Newest first. */
  posts(limit: number): Promise<Post[]>;
}

/** Where posts go out. `post` returns null when nothing was sent: a rehearsal. */
export interface SocialNetwork {
  readonly name: string;
  post(text: string): Promise<{ id: string; url: string } | null>;
}

/** The network refused for now (rate limit): try again after `retryAt` (unix seconds), if known. */
export class NetworkBusy extends Error {
  constructor(readonly retryAt: number | null) {
    super("the network is rate limiting");
  }
}
