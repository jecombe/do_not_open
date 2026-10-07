import { Wallet } from "ethers";
import { beforeEach, describe, expect, it } from "vitest";
import { AllowList } from "../src/application/allowList";
import { DISCORD_BONUS, DISCORD_CODE_TTL, DISCORD_MIN_AGE, discordCreatedAt, parseTweetUrl, SIGN_IN_TTL, X_PASS_BONUS, xPassBonuses, XPasses, xPassWalletMessage, type Tweet, type TweetLookup, type XSignIn } from "../src/application/xPass";
import { ethersVerifier, loginSecrets, passSecrets } from "../src/infrastructure/auth/crypto";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { OEmbedTweets, oEmbedText } from "../src/infrastructure/x/OEmbedTweets";

/** X as the tests see it: posts by id, or down. */
class FakeTweets implements TweetLookup {
  posts = new Map<string, Tweet>();
  down = false;
  post(handle: string, id: string, text: string) {
    this.posts.set(id, { id, handle, text });
    return `https://x.com/${handle}/status/${id}`;
  }
  async tweet(_handle: string, id: string) {
    if (this.down) throw new Error("down");
    return this.posts.get(id) ?? null;
  }
}

describe("X boarding passes", () => {
  let store: MemoryStore;
  let tweets: FakeTweets;
  let passes: XPasses;
  let now: number;
  const wallet = Wallet.createRandom();

  beforeEach(() => {
    store = new MemoryStore();
    tweets = new FakeTweets();
    now = 1_000;
    passes = new XPasses(store, tweets, passSecrets, ethersVerifier, { now: () => now });
  });

  const linkMessage = (address: string, code: string) => xPassWalletMessage(address, code, new Date(now * 1000));

  it("hands out a token once, and keeps only its hash", async () => {
    const { token, pass } = await passes.start();
    expect(pass).toEqual({ code: expect.stringMatching(/^DNO-[A-HJ-NP-Z2-9]{6}$/), seated: false, handle: null, tweetUrl: null, followed: false, tasks: { follow: false, post: false, like: false, reply: false, repost: false }, address: null, discord: false, bonus: 0 });
    const [stored] = await store.xPasses();
    expect(stored!.id).toBe(passSecrets.hash(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    await expect(passes.status("not-a-token")).rejects.toMatchObject({ code: "no-pass" });
  });

  it("proves the X account with a post that carries the code", async () => {
    const { token, pass } = await passes.start();
    await expect(passes.verifyTweet(token, "https://example.com/x")).rejects.toMatchObject({ code: "bad-tweet-url" });
    await expect(passes.verifyTweet(token, "https://x.com/cat/status/1")).rejects.toMatchObject({ code: "tweet-not-found" });
    const without = tweets.post("cat", "2", "boarding #DoNotOpen");
    await expect(passes.verifyTweet(token, without)).rejects.toMatchObject({ code: "code-missing" });
    tweets.down = true;
    await expect(passes.verifyTweet(token, without)).rejects.toMatchObject({ code: "x-down" });
    tweets.down = false;
    // The author comes from X, whatever handle the link shows.
    tweets.post("Real_Cat".toLowerCase(), "3", `I'm boarding ${pass.code.toLowerCase()} #DoNotOpen`);
    const done = await passes.verifyTweet(token, "https://twitter.com/whoever/status/3?s=20");
    expect(done).toMatchObject({ handle: "real_cat", tweetUrl: "https://x.com/real_cat/status/3" });
  });

  it("notes each task once, when the player says it is done", async () => {
    const { token } = await passes.start();
    now = 1_010;
    await passes.declare(token, "like");
    now = 1_020;
    expect((await passes.declare(token, "like")).tasks.like).toBe(true);
    expect((await store.xPasses())[0]).toMatchObject({ likedAt: 1_010, repliedAt: null, repostedAt: null });
  });

  it("refuses a post that already verified another pass", async () => {
    const a = await passes.start();
    const b = await passes.start();
    const url = tweets.post("cat", "4", `${a.pass.code} and ${b.pass.code}`);
    await passes.verifyTweet(a.token, url);
    await expect(passes.verifyTweet(b.token, url)).rejects.toMatchObject({ code: "tweet-used" });
  });

  it("moves an account to a new pass, wallet and follow included, when its owner posts the new code", async () => {
    const old = await passes.start();
    await passes.follow(old.token);
    await passes.declare(old.token, "repost");
    await passes.verifyTweet(old.token, tweets.post("cat", "5", old.pass.code));
    await passes.linkWallet(old.token, wallet.address, linkMessage(wallet.address, old.pass.code), await wallet.signMessage(linkMessage(wallet.address, old.pass.code)));
    // A new browser: a new pass, the same account.
    const next = await passes.start();
    const moved = await passes.verifyTweet(next.token, tweets.post("cat", "6", next.pass.code));
    expect(moved).toMatchObject({ code: next.pass.code, handle: "cat", followed: true, tasks: { follow: true, post: true, like: false, reply: false, repost: true }, address: wallet.address.toLowerCase(), bonus: X_PASS_BONUS });
    expect(await store.xPasses()).toHaveLength(1);
    await expect(passes.status(old.token)).rejects.toMatchObject({ code: "no-pass" });
  });

  it("links a wallet only after X, signed by that wallet, once per wallet", async () => {
    const { token, pass } = await passes.start();
    const message = linkMessage(wallet.address, pass.code);
    const signature = await wallet.signMessage(message);
    await expect(passes.linkWallet(token, wallet.address, message, signature)).rejects.toMatchObject({ code: "connect-x-first" });
    await passes.verifyTweet(token, tweets.post("cat", "7", pass.code));
    const other = Wallet.createRandom();
    await expect(passes.linkWallet(token, wallet.address, message, await other.signMessage(message))).rejects.toMatchObject({ code: "bad-signature" });
    await expect(passes.linkWallet(token, wallet.address, linkMessage(wallet.address, "DNO-AAAAAA"), signature)).rejects.toMatchObject({ code: "bad-message" });
    expect(await passes.linkWallet(token, wallet.address, message, signature)).toMatchObject({ address: wallet.address.toLowerCase(), bonus: X_PASS_BONUS });

    const second = await passes.start();
    await passes.verifyTweet(second.token, tweets.post("dog", "8", second.pass.code));
    const m2 = linkMessage(wallet.address, second.pass.code);
    await expect(passes.linkWallet(second.token, wallet.address, m2, await wallet.signMessage(m2))).rejects.toMatchObject({ code: "address-taken" });
  });

  it("adds its bonus to the linked wallet on the allow list", async () => {
    const { token, pass } = await passes.start();
    await passes.verifyTweet(token, tweets.post("cat", "9", pass.code));
    const list = new AllowList(store, ethersVerifier, { now: () => now }, 500, () => xPassBonuses(store));
    expect((await list.status(wallet.address)).points).toBe(0);
    const message = linkMessage(wallet.address, pass.code);
    await passes.linkWallet(token, wallet.address, message, await wallet.signMessage(message));
    expect(await list.status(wallet.address)).toMatchObject({ bonus: X_PASS_BONUS, points: X_PASS_BONUS, rank: null });
  });
});

describe("boarding from Discord", () => {
  const GUILD = "555";
  /** A Discord user id (a snowflake) for an account made at `seconds`. */
  const userMadeAt = (seconds: number) => String((BigInt(seconds * 1000) - 1_420_070_400_000n) << 22n);
  let store: MemoryStore;
  let tweets: FakeTweets;
  let passes: XPasses;
  let now: number;
  let old: string;

  beforeEach(() => {
    store = new MemoryStore();
    tweets = new FakeTweets();
    now = 1_800_000_000;
    old = userMadeAt(now - DISCORD_MIN_AGE - 1);
    passes = new XPasses(store, tweets, passSecrets, ethersVerifier, { now: () => now }, null, null, { guildId: GUILD });
  });

  it("reads when an account was made from its id", () => {
    expect(discordCreatedAt("175928847299117063")).toBeCloseTo(1_462_015_105.796, 2);
  });

  it("is off without a server", async () => {
    const off = new XPasses(store, tweets, passSecrets, ethersVerifier, { now: () => now });
    const { token } = await off.start();
    expect(off.discordEnabled).toBe(false);
    await expect(off.discordCode(token)).rejects.toMatchObject({ code: "discord-off" });
    expect(await off.joinDiscord("DNO-AAAAAA", { userId: old, guildId: GUILD })).toBe("off");
  });

  it("ties the account that runs /board in the server to the pass, once per code", async () => {
    const { token } = await passes.start();
    const { code, expiresAt } = await passes.discordCode(token);
    expect(expiresAt).toBe(now + DISCORD_CODE_TTL);
    expect(await passes.joinDiscord(code, { userId: old, guildId: null })).toBe("wrong-server");
    expect(await passes.joinDiscord(code, { userId: old, guildId: "666" })).toBe("wrong-server");
    expect(await passes.joinDiscord(code, { userId: userMadeAt(now - 3_600), guildId: GUILD })).toBe("too-young");
    expect(await passes.joinDiscord(` ${code.toLowerCase()} `, { userId: old, guildId: GUILD })).toBe("ok");
    expect(await passes.status(token)).toMatchObject({ discord: true, bonus: 0 });
    expect(await store.xPassByDiscordUser(old)).toMatchObject({ discordJoinedAt: now });
    // The code is spent.
    expect(await passes.joinDiscord(code, { userId: old, guildId: GUILD })).toBe("unknown-code");
    expect(await passes.joinDiscord((await passes.discordCode(token)).code, { userId: old, guildId: GUILD })).toBe("already");
  });

  it("lets a code expire, and keeps only the newest code of a pass", async () => {
    const { token } = await passes.start();
    const first = await passes.discordCode(token);
    const second = await passes.discordCode(token);
    expect(await passes.joinDiscord(first.code, { userId: old, guildId: GUILD })).toBe("unknown-code");
    now += DISCORD_CODE_TTL;
    expect(await passes.joinDiscord(second.code, { userId: old, guildId: GUILD })).toBe("unknown-code");
  });

  it("moves an account to the newest pass it boards", async () => {
    const a = await passes.start();
    const b = await passes.start();
    await passes.joinDiscord((await passes.discordCode(a.token)).code, { userId: old, guildId: GUILD });
    await passes.joinDiscord((await passes.discordCode(b.token)).code, { userId: old, guildId: GUILD });
    expect((await passes.status(a.token)).discord).toBe(false);
    expect((await passes.status(b.token)).discord).toBe(true);
  });

  it("takes a code handed out by one API replica on another", async () => {
    const { token } = await passes.start();
    const replica = new XPasses(store, tweets, passSecrets, ethersVerifier, { now: () => now }, null, null, { guildId: GUILD });
    const { code } = await passes.discordCode(token);
    expect(await replica.joinDiscord(code, { userId: old, guildId: GUILD })).toBe("ok");
    expect(await passes.joinDiscord(code, { userId: old, guildId: GUILD })).toBe("unknown-code");
  });

  it("adds its bonus on top of the X one, on the linked wallet", async () => {
    const wallet = Wallet.createRandom();
    const { token, pass } = await passes.start();
    await passes.joinDiscord((await passes.discordCode(token)).code, { userId: old, guildId: GUILD });
    await passes.verifyTweet(token, tweets.post("cat", "9", pass.code));
    const message = xPassWalletMessage(wallet.address, pass.code, new Date(now * 1000));
    expect(await passes.linkWallet(token, wallet.address, message, await wallet.signMessage(message))).toMatchObject({ discord: true, bonus: X_PASS_BONUS + DISCORD_BONUS });
    expect((await xPassBonuses(store)).get(wallet.address.toLowerCase() as never)).toBe(X_PASS_BONUS + DISCORD_BONUS);
  });
});

/** X's OAuth as the tests see it: codes it knows, the account behind each. */
class FakeX implements XSignIn {
  accounts = new Map<string, { id: string; username: string }>();
  verifiers: string[] = [];
  authorizeUrl(state: string, challenge: string) {
    return `https://x.test/authorize?state=${state}&challenge=${challenge}`;
  }
  async account(code: string, verifier: string) {
    this.verifiers.push(verifier);
    const a = this.accounts.get(code);
    if (!a) throw new Error("bad code");
    return a;
  }
}

describe("Sign in with X", () => {
  let store: MemoryStore;
  let x: FakeX;
  let passes: XPasses;
  let now: number;
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

  beforeEach(() => {
    store = new MemoryStore();
    x = new FakeX();
    now = 1_000;
    passes = new XPasses(store, new FakeTweets(), passSecrets, ethersVerifier, { now: () => now }, { x, secrets: loginSecrets });
  });

  it("is off without an X app", async () => {
    const off = new XPasses(store, new FakeTweets(), passSecrets, ethersVerifier, { now: () => now });
    expect(off.signInEnabled).toBe(false);
    const { token } = await off.start();
    await expect(off.startSignIn(token, "https://site.test/")).rejects.toMatchObject({ code: "sign-in-off" });
  });

  it("puts the account X names on the pass the sign-in started from, once per state", async () => {
    const { token } = await passes.start();
    const { url } = await passes.startSignIn(token, "https://site.test/fr/");
    x.accounts.set("good", { id: "42", username: "Herald_DNO" });
    const state = stateOf(url);
    expect(await passes.finishSignIn(state, "good")).toEqual({ returnTo: "https://site.test/fr/", outcome: "ok" });
    expect(await passes.status(token)).toMatchObject({ handle: "herald_dno" });
    expect((await store.xPasses())[0]!.xUserId).toBe("42");
    // The PKCE verifier went to X, and the state cannot be used twice.
    expect(x.verifiers).toHaveLength(1);
    expect(await passes.finishSignIn(state, "good")).toEqual({ returnTo: null, outcome: "sign-in-expired" });
  });

  it("finishes on another API replica than the one it started on", async () => {
    const { token } = await passes.start();
    const replica = new XPasses(store, new FakeTweets(), passSecrets, ethersVerifier, { now: () => now }, { x, secrets: loginSecrets });
    x.accounts.set("good", { id: "42", username: "cat" });
    const state = stateOf((await passes.startSignIn(token, "https://site.test/")).url);
    expect(await replica.finishSignIn(state, "good")).toEqual({ returnTo: "https://site.test/", outcome: "ok" });
    expect(await passes.finishSignIn(state, "good")).toEqual({ returnTo: null, outcome: "sign-in-expired" });
  });

  it("sends the player back with what went wrong", async () => {
    const { token } = await passes.start();
    const refused = stateOf((await passes.startSignIn(token, "https://site.test/")).url);
    expect(await passes.finishSignIn(refused, null)).toEqual({ returnTo: "https://site.test/", outcome: "sign-in-refused" });
    const bad = stateOf((await passes.startSignIn(token, "https://site.test/")).url);
    expect((await passes.finishSignIn(bad, "unknown")).outcome).toBe("x-down");
    const late = stateOf((await passes.startSignIn(token, "https://site.test/")).url);
    now += SIGN_IN_TTL;
    expect((await passes.finishSignIn(late, "good")).outcome).toBe("sign-in-expired");
    expect(await passes.status(token)).toMatchObject({ handle: null });
  });

  it("moves an account to a new pass, tasks and wallet included, even under a new handle", async () => {
    const old = await passes.start();
    await passes.declare(old.token, "follow");
    x.accounts.set("a", { id: "42", username: "cat" });
    await passes.finishSignIn(stateOf((await passes.startSignIn(old.token, "https://site.test/")).url), "a");
    const next = await passes.start();
    await passes.declare(next.token, "post");
    x.accounts.set("b", { id: "42", username: "cat_renamed" });
    await passes.finishSignIn(stateOf((await passes.startSignIn(next.token, "https://site.test/")).url), "b");
    expect(await passes.status(next.token)).toMatchObject({ handle: "cat_renamed", tasks: { follow: true, post: true } });
    expect(await store.xPasses()).toHaveLength(1);
  });
});

describe("tweet links and oEmbed", () => {
  it("reads the handle and id of a post link", () => {
    expect(parseTweetUrl("https://x.com/Cat_1/status/123")).toEqual({ handle: "cat_1", id: "123" });
    expect(parseTweetUrl(" https://mobile.twitter.com/cat/status/9?s=20 ")).toEqual({ handle: "cat", id: "9" });
    expect(parseTweetUrl("https://x.com/cat")).toBeNull();
    expect(parseTweetUrl("https://evil.com/x.com/cat/status/1")).toBeNull();
  });

  it("turns oEmbed's HTML into text", () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">I&#39;m boarding DNO-7F3K &amp; <a href="https://t.co/x">#DoNotOpen</a></p>&mdash; Cat (@cat) <a href="https://twitter.com/cat/status/1">Oct 6</a></blockquote>';
    expect(oEmbedText(html)).toBe("I'm boarding DNO-7F3K & #DoNotOpen — Cat (@cat) Oct 6");
  });

  it("asks oEmbed for the post, and says null when X does not know it", async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      if (url.includes("404")) return new Response("", { status: 404 });
      return Response.json({ author_url: "https://twitter.com/Cat", html: "<p>hello DNO-AAAAAA</p>" });
    }) as typeof fetch;
    const o = new OEmbedTweets(fake);
    expect(await o.tweet("cat", "1")).toEqual({ id: "1", handle: "cat", text: "hello DNO-AAAAAA" });
    expect(await o.tweet("cat", "404")).toBeNull();
    expect(asked[0]).toContain(encodeURIComponent("https://twitter.com/cat/status/1"));
  });
});
