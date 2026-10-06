import { X_PASS_BONUS } from "@dno/chain-adapter/standings";
import { normalizeAddress, type Address } from "../domain/types";
import type { Clock, SignatureVerifier } from "./auth";
import type { Store } from "./ports/store";

/**
 * The X boarding pass: a player proves an X account by posting a tweet that carries their pass
 * code, declares they follow the collection's account, and may link a wallet for the testnet
 * points. No X API key: the tweet is read through X's public oEmbed. The follow cannot be read
 * for free, so it is declared, and the team checks the list by hand before mainnet.
 */
export interface XPass {
  /** sha256 of the secret token the browser keeps: the token itself is never stored. */
  id: string;
  /** Public, goes in the tweet: `DNO-` and six letters or digits. */
  code: string;
  /** Lower-cased, without the @, once a tweet proved it. */
  handle: string | null;
  tweetId: string | null;
  tweetUrl: string | null;
  /** When the player said they follow the account (declared, not checked). */
  followedAt: number | null;
  /** The wallet the player linked by signing, for the testnet points. Private. */
  address: Address | null;
  createdAt: number;
  verifiedAt: number | null;
  updatedAt: number;
}

export interface XPassView {
  code: string;
  handle: string | null;
  tweetUrl: string | null;
  followed: boolean;
  address: Address | null;
  /** Bonus points the pass adds to its wallet on the allow list. */
  bonus: number;
}

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

export type XPassRefusal = "no-pass" | "bad-tweet-url" | "tweet-not-found" | "code-missing" | "tweet-used" | "x-down" | "connect-x-first" | "address-taken" | "bad-message" | "bad-signature";

export class XPassRefused extends Error {
  constructor(
    readonly code: XPassRefusal,
    message: string,
  ) {
    super(message);
  }
}

export { X_PASS_BONUS, xPassWalletMessage } from "@dno/chain-adapter/standings";

const TWEET_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:[/?#].*)?$/;

/** `{ handle, id }` of a tweet link, or null. */
export function parseTweetUrl(url: string): { handle: string; id: string } | null {
  const m = TWEET_URL.exec(url.trim());
  return m ? { handle: m[1]!.toLowerCase(), id: m[2]! } : null;
}

export class XPasses {
  constructor(
    private readonly store: Store,
    private readonly tweets: TweetLookup,
    private readonly secrets: PassSecrets,
    private readonly verifier: SignatureVerifier,
    private readonly clock: Clock,
  ) {}

  /** A new, empty pass: the token goes to the browser, once. */
  async start(): Promise<{ token: string; pass: XPassView }> {
    const { token, id } = this.secrets.token();
    let code = this.secrets.code();
    // Codes are short: draw again on the rare clash.
    for (let i = 0; i < 5 && (await this.store.xPassByCode(code)); i++) code = this.secrets.code();
    const now = this.clock.now();
    const pass: XPass = { id, code, handle: null, tweetId: null, tweetUrl: null, followedAt: null, address: null, createdAt: now, verifiedAt: null, updatedAt: now };
    await this.store.saveXPass(pass);
    return { token, pass: view(pass) };
  }

  async status(token: string): Promise<XPassView> {
    return view(await this.find(token));
  }

  async follow(token: string): Promise<XPassView> {
    const pass = await this.find(token);
    if (pass.followedAt) return view(pass);
    const now = this.clock.now();
    const next = { ...pass, followedAt: now, updatedAt: now };
    await this.store.saveXPass(next);
    return view(next);
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

    const now = this.clock.now();
    const older = await this.store.xPassByHandle(tweet.handle);
    let next: XPass = { ...pass, handle: tweet.handle, tweetId: tweet.id, tweetUrl: `https://x.com/${tweet.handle}/status/${tweet.id}`, verifiedAt: pass.verifiedAt ?? now, updatedAt: now };
    if (older && older.id !== pass.id) {
      next = { ...next, followedAt: next.followedAt ?? older.followedAt, address: next.address ?? older.address, createdAt: Math.min(older.createdAt, pass.createdAt) };
      await this.store.deleteXPass(older.id);
    }
    await this.store.saveXPass(next);
    return view(next);
  }

  /** Links a wallet, signed by it. The pass needs its X account first. */
  async linkWallet(token: string, rawAddress: string, message: string, signature: string): Promise<XPassView> {
    const pass = await this.find(token);
    if (!pass.handle) throw new XPassRefused("connect-x-first", "verify your X post first");
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
    return view(next);
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

/** The allow list bonus of each wallet linked to a verified pass. */
export async function xPassBonuses(store: Store): Promise<Map<Address, number>> {
  const bonus = new Map<Address, number>();
  for (const p of await store.xPasses()) if (p.handle && p.address) bonus.set(p.address, X_PASS_BONUS);
  return bonus;
}

function view(p: XPass): XPassView {
  return { code: p.code, handle: p.handle, tweetUrl: p.tweetUrl, followed: p.followedAt !== null, address: p.address, bonus: p.handle && p.address ? X_PASS_BONUS : 0 };
}
