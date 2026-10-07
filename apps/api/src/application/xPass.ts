import { DISCORD_BONUS, X_PASS_BONUS } from "@dno/chain-adapter/standings";
import { normalizeAddress, type Address } from "../domain/types";
import type { Clock, SignatureVerifier } from "./auth";
import type { Store } from "./ports/store";

/**
 * The X boarding pass: a player connects their X account (Sign in with X, OAuth 2.0 with PKCE;
 * or, where no X app is configured, a post carrying their pass code, read through X's public
 * oEmbed), declares the tasks they did on X, and may link a wallet for the testnet points. X's
 * follows, likes and reposts cannot be read without a paid API, so the tasks are declared and
 * the team checks the list by hand before mainnet. Joining the Discord server is proved instead:
 * the player runs `/board` there with a one-time code from the site, and Discord says who ran it.
 */
export interface XPass {
  /** sha256 of the secret token the browser keeps: the token itself is never stored. */
  id: string;
  /** Public, goes in the tweet: `DNO-` and six letters or digits. */
  code: string;
  /** Lower-cased, without the @, once a sign-in or a tweet proved it. */
  handle: string | null;
  /** X's id of the account, from a sign-in: it outlives a change of handle. */
  xUserId: string | null;
  tweetId: string | null;
  tweetUrl: string | null;
  /** When the player said they did each task on X (declared, not checked: X's follows, likes
   *  and reposts cannot be read without a paid API). */
  followedAt: number | null;
  postedAt: number | null;
  likedAt: number | null;
  repliedAt: number | null;
  repostedAt: number | null;
  /** The wallet the player linked by signing, for the testnet points. Private. */
  address: Address | null;
  /** The Discord account that ran `/board` in the server with this pass's code. Private. */
  discordUserId: string | null;
  discordJoinedAt: number | null;
  createdAt: number;
  verifiedAt: number | null;
  updatedAt: number;
}

export interface XPassView {
  code: string;
  /** Whether the pass holds a seat on the mainnet list: account connected, every required task done. */
  seated: boolean;
  handle: string | null;
  tweetUrl: string | null;
  followed: boolean;
  /** Each task the player declared done. */
  tasks: Record<XTask, boolean>;
  address: Address | null;
  /** Whether the pass's holder joined the Discord server and proved it with `/board`. */
  discord: boolean;
  /** Bonus points the pass adds to its wallet on the allow list. */
  bonus: number;
}

/** The tasks on X a pass asks for: follow the account, post a boarding tweet, like, reply to and
 *  repost the announcement. */
export const X_TASKS = ["follow", "post", "like", "reply", "repost"] as const;
export type XTask = (typeof X_TASKS)[number];
export const TASK_FIELD = { follow: "followedAt", post: "postedAt", like: "likedAt", reply: "repliedAt", repost: "repostedAt" } as const satisfies Record<XTask, keyof XPass>;

/** Sign in with X: OAuth 2.0, authorization code with PKCE, read-only scopes. */
export interface XSignIn {
  authorizeUrl(state: string, challenge: string): string;
  /** The account behind an authorization code. Throws when X refuses it or cannot be reached. */
  account(code: string, verifier: string): Promise<{ id: string; username: string }>;
}

export interface LoginSecrets {
  /** A random OAuth state, and a PKCE verifier with its S256 challenge. */
  state(): string;
  pkce(): { verifier: string; challenge: string };
}

/** How long a sign-in started on the site may take on X. */
export const SIGN_IN_TTL = 10 * 60;

/** How long a `/board` code from the site stays good. */
export const DISCORD_CODE_TTL = 15 * 60;
/** A Discord account younger than this cannot board: fresh accounts are free to make. */
export const DISCORD_MIN_AGE = 30 * 24 * 60 * 60;

/** How a `/board` on Discord went. */
export type DiscordBoarding = "ok" | "already" | "unknown-code" | "too-young" | "wrong-server" | "off";

/** When a Discord account was made, in seconds: its id is a snowflake whose top bits count ms since 2015. */
export const discordCreatedAt = (userId: string): number => Number((BigInt(userId) >> 22n) + 1_420_070_400_000n) / 1000;

/** What X's public oEmbed says about a tweet. */
export interface Tweet {
  id: string;
  handle: string;
  text: string;
}

export interface TweetLookup {
  /** The tweet, or null when X does not know it (deleted, private, wrong id). Throws when X cannot be reached. */
  tweet(handle: string, id: string): Promise<Tweet | null>;
}

export interface PassSecrets {
  /** A new random token and its hash: the browser keeps the token, the store the hash. */
  token(): { token: string; id: string };
  hash(token: string): string;
  code(): string;
}

export type XPassRefusal =
  | "no-pass"
  | "bad-tweet-url"
  | "tweet-not-found"
  | "code-missing"
  | "tweet-used"
  | "x-down"
  | "connect-x-first"
  | "address-taken"
  | "bad-message"
  | "bad-signature"
  | "sign-in-off"
  | "sign-in-expired"
  | "sign-in-refused"
  | "list-full"
  | "discord-off";

export class XPassRefused extends Error {
  constructor(
    readonly code: XPassRefusal,
    message: string,
  ) {
    super(message);
  }
}

export { DISCORD_BONUS, X_PASS_BONUS, xPassWalletMessage } from "@dno/chain-adapter/standings";

const TWEET_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:[/?#].*)?$/;

/** `{ handle, id }` of a tweet link, or null. */
export function parseTweetUrl(url: string): { handle: string; id: string } | null {
  const m = TWEET_URL.exec(url.trim());
  return m ? { handle: m[1]!.toLowerCase(), id: m[2]! } : null;
}

export class XPasses {
  /** Sign-ins under way, by OAuth state: one API process serves them, and a lost one is just retried. */
  private readonly pending = new Map<string, { passId: string; verifier: string; returnTo: string; expiresAt: number }>();

  constructor(
    private readonly store: Store,
    private readonly tweets: TweetLookup,
    private readonly secrets: PassSecrets,
    private readonly verifier: SignatureVerifier,
    private readonly clock: Clock,
    private readonly signIn: { x: XSignIn; secrets: LoginSecrets } | null = null,
    /** The list's seats: a pass takes one once its account is connected and its tasks done. */
    private readonly seats: { admit(): Promise<void>; passSeated(p: XPass): boolean } | null = null,
    /** The Discord server whose members can board with `/board`; null: no Discord step. */
    private readonly discord: { guildId: string } | null = null,
  ) {}

  /** `/board` codes handed out, by code: one API process serves them, and a lost one is just asked again. */
  private readonly boardCodes = new Map<string, { passId: string; expiresAt: number }>();

  /** Whether the Discord step is on: a server to join, and the bot that serves `/board` in it. */
  get discordEnabled(): boolean {
    return this.discord !== null;
  }

  /** A one-time code the player types in `/board` on Discord, which ties their account to this pass. */
  async discordCode(token: string): Promise<{ code: string; expiresAt: number }> {
    if (!this.discord) throw new XPassRefused("discord-off", "the Discord step is not configured here");
    const pass = await this.find(token);
    const now = this.clock.now();
    for (const [k, v] of this.boardCodes) if (v.expiresAt <= now || v.passId === pass.id) this.boardCodes.delete(k);
    let code = this.secrets.code();
    for (let i = 0; i < 5 && this.boardCodes.has(code); i++) code = this.secrets.code();
    const expiresAt = now + DISCORD_CODE_TTL;
    this.boardCodes.set(code, { passId: pass.id, expiresAt });
    return { code, expiresAt };
  }

  /**
   * Someone ran `/board <code>` on Discord. It counts in the collection's server only, from an
   * account at least DISCORD_MIN_AGE old. One Discord account boards one pass: run again with a
   * newer code, it moves to that pass.
   */
  async joinDiscord(rawCode: string, member: { userId: string; guildId: string | null }): Promise<DiscordBoarding> {
    if (!this.discord) return "off";
    if (member.guildId !== this.discord.guildId) return "wrong-server";
    const now = this.clock.now();
    const code = rawCode.trim().toUpperCase();
    const started = this.boardCodes.get(code);
    if (!started || started.expiresAt <= now) return "unknown-code";
    if (now - discordCreatedAt(member.userId) < DISCORD_MIN_AGE) return "too-young";
    const pass = await this.store.xPassById(started.passId);
    if (!pass) return "unknown-code";
    this.boardCodes.delete(code);
    if (pass.discordUserId === member.userId) return "already";
    const older = await this.store.xPassByDiscordUser(member.userId);
    if (older && older.id !== pass.id) await this.store.saveXPass({ ...older, discordUserId: null, discordJoinedAt: null, updatedAt: now });
    await this.store.saveXPass({ ...pass, discordUserId: member.userId, discordJoinedAt: now, updatedAt: now });
    return "ok";
  }

  /** Whether Sign in with X is configured; without it, the code-in-a-post proof stands in. */
  get signInEnabled(): boolean {
    return this.signIn !== null;
  }

  /** Starts Sign in with X for a pass: the browser goes to the URL returned. */
  async startSignIn(token: string, returnTo: string): Promise<{ url: string }> {
    if (!this.signIn) throw new XPassRefused("sign-in-off", "Sign in with X is not configured here");
    const pass = await this.find(token);
    const now = this.clock.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k);
    const state = this.signIn.secrets.state();
    const { verifier, challenge } = this.signIn.secrets.pkce();
    this.pending.set(state, { passId: pass.id, verifier, returnTo, expiresAt: now + SIGN_IN_TTL });
    return { url: this.signIn.x.authorizeUrl(state, challenge) };
  }

  /**
   * X sent the player back. Returns where to send them, and how it went. The account lands on
   * the pass the sign-in started from; an account already on an older pass moves to this one.
   */
  async finishSignIn(state: string, code: string | null): Promise<{ returnTo: string | null; outcome: "ok" | XPassRefusal }> {
    const started = this.pending.get(state);
    this.pending.delete(state);
    if (!this.signIn || !started) return { returnTo: null, outcome: "sign-in-expired" };
    const { returnTo } = started;
    if (started.expiresAt <= this.clock.now()) return { returnTo, outcome: "sign-in-expired" };
    if (!code) return { returnTo, outcome: "sign-in-refused" };
    let account: { id: string; username: string };
    try {
      account = await this.signIn.x.account(code, started.verifier);
    } catch {
      return { returnTo, outcome: "x-down" };
    }
    const pass = await this.store.xPassById(started.passId);
    if (!pass) return { returnTo, outcome: "no-pass" };
    try {
      await this.attach(pass, { handle: account.username.toLowerCase(), xUserId: account.id });
    } catch (e) {
      if (e instanceof XPassRefused) return { returnTo, outcome: e.code };
      throw e;
    }
    return { returnTo, outcome: "ok" };
  }

  /** A new, empty pass: the token goes to the browser, once. */
  async start(): Promise<{ token: string; pass: XPassView }> {
    const { token, id } = this.secrets.token();
    let code = this.secrets.code();
    // Codes are short: draw again on the rare clash.
    for (let i = 0; i < 5 && (await this.store.xPassByCode(code)); i++) code = this.secrets.code();
    const now = this.clock.now();
    const pass: XPass = { id, code, handle: null, tweetId: null, tweetUrl: null, xUserId: null, followedAt: null, postedAt: null, likedAt: null, repliedAt: null, repostedAt: null, address: null, discordUserId: null, discordJoinedAt: null, createdAt: now, verifiedAt: null, updatedAt: now };
    await this.store.saveXPass(pass);
    return { token, pass: this.view(pass) };
  }

  async status(token: string): Promise<XPassView> {
    return this.view(await this.find(token));
  }

  /** Notes a task the player says they did on X. The first time counts; again is a no-op. */
  async declare(token: string, task: XTask): Promise<XPassView> {
    const pass = await this.find(token);
    const field = TASK_FIELD[task];
    if (pass[field] !== null) return this.view(pass);
    const now = this.clock.now();
    const next = { ...pass, [field]: now, updatedAt: now };
    await this.sitDown(pass, next);
    await this.store.saveXPass(next);
    return this.view(next);
  }

  follow(token: string): Promise<XPassView> {
    return this.declare(token, "follow");
  }

  /**
   * Proves the X account: the tweet must exist and carry the pass code. An account already on an
   * older pass (a lost token, another browser) moves to this one, with its wallet and follow:
   * only the account's owner could post the new code.
   */
  async verifyTweet(token: string, url: string): Promise<XPassView> {
    const pass = await this.find(token);
    const link = parseTweetUrl(url);
    if (!link) throw new XPassRefused("bad-tweet-url", "paste the link of your post, like https://x.com/you/status/123");
    let tweet: Tweet | null;
    try {
      tweet = await this.tweets.tweet(link.handle, link.id);
    } catch {
      throw new XPassRefused("x-down", "X did not answer: try again in a minute");
    }
    if (!tweet) throw new XPassRefused("tweet-not-found", "X does not show this post: check it is public and not deleted");
    if (!tweet.text.toUpperCase().includes(pass.code.toUpperCase())) throw new XPassRefused("code-missing", `the post must contain your code ${pass.code}`);
    const used = await this.store.xPassByTweet(tweet.id);
    if (used && used.id !== pass.id) throw new XPassRefused("tweet-used", "this post already verified another pass");

    // That post carried the code: it is the boarding tweet, the "post" task done and proved.
    const posted = pass.postedAt === null ? { ...pass, postedAt: this.clock.now() } : pass;
    return this.view(await this.attach(posted, { handle: tweet.handle, tweetId: tweet.id, tweetUrl: `https://x.com/${tweet.handle}/status/${tweet.id}` }));
  }

  /**
   * Puts a proved X account on a pass. An account already on an older pass (a lost token,
   * another browser) moves to this one with its tasks and wallet: only its owner could prove it.
   */
  private async attach(pass: XPass, proof: { handle: string; xUserId?: string; tweetId?: string; tweetUrl?: string }): Promise<XPass> {
    const now = this.clock.now();
    const byId = proof.xUserId ? await this.store.xPassByXUser(proof.xUserId) : null;
    const byHandle = await this.store.xPassByHandle(proof.handle);
    let next: XPass = {
      ...pass,
      handle: proof.handle,
      xUserId: proof.xUserId ?? pass.xUserId,
      tweetId: proof.tweetId ?? pass.tweetId,
      tweetUrl: proof.tweetUrl ?? pass.tweetUrl,
      verifiedAt: pass.verifiedAt ?? now,
      updatedAt: now,
    };
    for (const older of [byId, byHandle]) {
      if (!older || older.id === pass.id) continue;
      next = {
        ...next,
        xUserId: next.xUserId ?? older.xUserId,
        tweetId: next.tweetId ?? older.tweetId,
        tweetUrl: next.tweetUrl ?? older.tweetUrl,
        ...Object.fromEntries(X_TASKS.map((t) => [TASK_FIELD[t], next[TASK_FIELD[t]] ?? older[TASK_FIELD[t]]])),
        address: next.address ?? older.address,
        discordUserId: next.discordUserId ?? older.discordUserId,
        discordJoinedAt: next.discordUserId ? next.discordJoinedAt : older.discordJoinedAt,
        createdAt: Math.min(older.createdAt, next.createdAt),
      };
    }
    // Someone who had no seat, on this pass or an older one of the same account, sits down now.
    await this.sitDown(pass, next, [byId, byHandle]);
    for (const older of [byId, byHandle]) if (older && older.id !== pass.id) await this.store.deleteXPass(older.id);
    await this.store.saveXPass(next);
    return next;
  }

  /** Checks for a free seat when a pass is about to take one it did not have. */
  private async sitDown(before: XPass, after: XPass, older: (XPass | null)[] = []): Promise<void> {
    if (!this.seats || !this.seats.passSeated(after)) return;
    if (this.seats.passSeated(before) || older.some((o) => o && this.seats!.passSeated(o))) return;
    try {
      await this.seats.admit();
    } catch {
      throw new XPassRefused("list-full", "every seat on the mainnet list is taken");
    }
  }

  private view(p: XPass): XPassView {
    return view(p, this.seats ? this.seats.passSeated(p) : !!p.handle);
  }

  /** Links a wallet, signed by it. The pass needs its X account first. */
  async linkWallet(token: string, rawAddress: string, message: string, signature: string): Promise<XPassView> {
    const pass = await this.find(token);
    if (!pass.handle) throw new XPassRefused("connect-x-first", "connect your X account first");
    const address = normalizeAddress(rawAddress);
    const lines = message.split("\n");
    if (message.length > 1_000 || !lines[0]?.startsWith(`I, ${address}, link this wallet to my DO NOT OPEN boarding pass ${pass.code}.`)) {
      throw new XPassRefused("bad-message", "sign the message the site shows, for this wallet and this pass");
    }
    let signer: string;
    try {
      signer = normalizeAddress(this.verifier.recover(message, signature));
    } catch {
      throw new XPassRefused("bad-signature", "unreadable signature");
    }
    if (signer !== address) throw new XPassRefused("bad-signature", "signed by another wallet");
    const other = await this.store.xPassByAddress(address);
    if (other && other.id !== pass.id) throw new XPassRefused("address-taken", "this wallet is already linked to another X account");
    const next = { ...pass, address, updatedAt: this.clock.now() };
    await this.store.saveXPass(next);
    return this.view(next);
  }

  /** The X handle on the pass a token opens, or null. */
  async handleOf(token: string): Promise<string | null> {
    const pass = token ? await this.store.xPassById(this.secrets.hash(token)) : null;
    return pass?.handle ?? null;
  }

  /** Every pass, for the team's checks before mainnet. */
  all(): Promise<XPass[]> {
    return this.store.xPasses();
  }

  private async find(token: string): Promise<XPass> {
    const pass = token ? await this.store.xPassById(this.secrets.hash(token)) : null;
    if (!pass) throw new XPassRefused("no-pass", "no boarding pass for this token: start a new one");
    return pass;
  }
}

/** What a pass adds to its wallet: the X bonus once it is verified and linked, and the Discord one on top. */
export const passBonus = (p: XPass): number => (p.handle && p.address ? X_PASS_BONUS + (p.discordUserId ? DISCORD_BONUS : 0) : 0);

/** The allow list bonus of each wallet linked to a verified pass. */
export async function xPassBonuses(store: Store): Promise<Map<Address, number>> {
  const bonus = new Map<Address, number>();
  for (const p of await store.xPasses()) if (p.address && passBonus(p) > 0) bonus.set(p.address, passBonus(p));
  return bonus;
}

function view(p: XPass, seated: boolean): XPassView {
  const tasks = Object.fromEntries(X_TASKS.map((t) => [t, p[TASK_FIELD[t]] !== null])) as Record<XTask, boolean>;
  return { code: p.code, seated, handle: p.handle, tweetUrl: p.tweetUrl, followed: tasks.follow, tasks, address: p.address, discord: p.discordUserId !== null, bonus: passBonus(p) };
}
