import { Wallet } from "ethers";
import { beforeEach, describe, expect, it } from "vitest";
import { AllowList } from "../src/application/allowList";
import { parseTweetUrl, X_PASS_BONUS, xPassBonuses, XPasses, xPassWalletMessage, type Tweet, type TweetLookup } from "../src/application/xPass";
import { ethersVerifier, passSecrets } from "../src/infrastructure/auth/crypto";
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
    expect(pass).toEqual({ code: expect.stringMatching(/^DNO-[A-HJ-NP-Z2-9]{6}$/), handle: null, tweetUrl: null, followed: false, tasks: { follow: false, like: false, reply: false, repost: false }, address: null, bonus: 0 });
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
    expect(moved).toMatchObject({ code: next.pass.code, handle: "cat", followed: true, tasks: { follow: true, like: false, reply: false, repost: true }, address: wallet.address.toLowerCase(), bonus: X_PASS_BONUS });
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
