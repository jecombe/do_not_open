import type { Draft, PostKind } from "../../domain/herald";

/** "rehearsed": written and kept, never sent (no network). "skipped": too old by the time its turn came. */
export type PostStatus = "queued" | "posted" | "rehearsed" | "skipped" | "failed";

export interface Post {
  id: number;
  /** The account it is queued for ("x", "discord"): each network keeps its own queue and quota. */
  network: string;
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

/**
 * The herald's queues of posts, one per network, each with where it read the events up to.
 * Not a read model: a replay of the chain keeps them.
 */
export interface PostStore {
  heraldCursor(network: string): Promise<EventPosition | null>;
  /** Queues the drafts whose key was never queued on that network and moves its cursor, in one go. Returns how many were new. */
  queuePosts(network: string, drafts: QueuedDraft[], cursor: EventPosition, now: number): Promise<number>;
  /** The network's oldest post still waiting its turn. */
  nextQueuedPost(network: string): Promise<Post | null>;
  updatePost(id: number, patch: Partial<Pick<Post, "status" | "postedAt" | "externalId" | "url" | "attempts" | "error">>): Promise<void>;
  hasPost(network: string, key: string): Promise<boolean>;
  /** Posts actually sent on the network since `since` (unix seconds). */
  postedSince(network: string, since: number): Promise<number>;
  lastPostedAt(network: string): Promise<number | null>;
  /** Newest first; every network's unless one is named. */
  posts(limit: number, network?: string): Promise<Post[]>;
}

/** Where posts go out. `post` returns null when nothing was sent: a rehearsal. */
export interface SocialNetwork {
  /** "rehearsal" for one that sends nothing. */
  readonly name: string;
  post(text: string): Promise<{ id: string; url: string } | null>;
}

/** The network refused for now (rate limit): try again after `retryAt` (unix seconds), if known. */
export class NetworkBusy extends Error {
  constructor(readonly retryAt: number | null) {
    super("the network is rate limiting");
  }
}
