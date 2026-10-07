import { allowListMessage } from "@dno/chain-adapter/standings";
import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { activityText, type Activity, type ActivityFeed } from "../src/application/activity";
import { AllowList } from "../src/application/allowList";
import { Ideas } from "../src/application/ideas";
import { Seats } from "../src/application/seats";
import { XPasses, xPassWalletMessage, type Tweet } from "../src/application/xPass";
import { ethersVerifier, loginSecrets, passSecrets } from "../src/infrastructure/auth/crypto";
import { DiscordActivityFeed } from "../src/infrastructure/discord/DiscordActivityFeed";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";

class Recorder implements ActivityFeed {
  told: Activity[] = [];
  tell(a: Activity) {
    this.told.push(a);
  }
}

const GUILD = "1168659424009793589";
/** A Discord account made long ago: its id's top bits count ms since 2015. */
const OLD_USER = String(1n << 22n);

/** A boarding desk, a whitelist and a suggestion box around one store, telling one feed. */
function desk() {
  const store = new MemoryStore();
  const feed = new Recorder();
  const clock = { now: () => 2_000_000_000 };
  const posts = new Map<string, Tweet>();
  const accounts = new Map<string, { id: string; username: string }>();
  let list: AllowList | null = null;
  // No testnet play in these tests: a seat comes from a pass's tasks only.
  const seats = new Seats(store, 100, async () => new Set(), ["follow", "post"]);
  list = new AllowList(store, ethersVerifier, clock, 100, async () => new Map(), seats, feed);
  const x = { authorizeUrl: (state: string) => `https://x.test/?state=${state}`, account: async (code: string) => accounts.get(code)! };
  const passes = new XPasses(store, { tweet: async (_h, id) => posts.get(id) ?? null }, passSecrets, ethersVerifier, clock, { x, secrets: loginSecrets }, seats, { guildId: GUILD }, feed);
  const ideas = new Ideas(store, clock, (token) => passes.handleOf(token), feed);
  return { store, feed, clock, posts, accounts, list, passes, ideas };
}

describe("the team's activity feed", () => {
  it("tells each step of a boarding pass once, with the X handle", async () => {
    const { feed, accounts, passes, clock } = desk();
    const { token, pass } = await passes.start();
    // A pass with no account yet is told by its code.
    await passes.declare(token, "follow");
    await passes.declare(token, "follow");
    accounts.set("ok", { id: "7", username: "Cat_Lover" });
    const { url } = await passes.startSignIn(token, "https://site.test/");
    await passes.finishSignIn(new URL(url).searchParams.get("state")!, "ok");
    // Signing in again on the same pass says nothing new.
    const again = await passes.startSignIn(token, "https://site.test/");
    await passes.finishSignIn(new URL(again.url).searchParams.get("state")!, "ok");
    await passes.declare(token, "post");
    const wallet = Wallet.createRandom();
    const message = xPassWalletMessage(wallet.address, pass.code, new Date(clock.now() * 1000));
    await passes.linkWallet(token, wallet.address, message, await wallet.signMessage(message));
    await passes.linkWallet(token, wallet.address, message, await wallet.signMessage(message));
    await passes.joinDiscord((await passes.discordCode(token)).code, { userId: OLD_USER, guildId: GUILD });

    expect(feed.told).toEqual([
      { kind: "task", handle: null, code: pass.code, task: "follow" },
      { kind: "x-connected", handle: "cat_lover", via: "sign-in", code: pass.code },
      { kind: "task", handle: "cat_lover", code: pass.code, task: "post" },
      { kind: "seated", handle: "cat_lover", code: pass.code },
      { kind: "wallet", handle: "cat_lover", code: pass.code },
      { kind: "discord", handle: "cat_lover", code: pass.code },
    ]);
    // The wallet never goes out next to the handle.
    expect(JSON.stringify(feed.told)).not.toContain(wallet.address.toLowerCase().slice(2));
  });

  it("tells a seat taken by proving the account with a post", async () => {
    const { feed, posts, passes } = desk();
    const { token, pass } = await passes.start();
    await passes.declare(token, "follow");
    posts.set("9", { id: "9", handle: "herald", text: `boarding ${pass.code}` });
    await passes.verifyTweet(token, "https://x.com/herald/status/9");
    expect(feed.told.slice(1)).toEqual([
      { kind: "x-connected", handle: "herald", via: "post", code: pass.code },
      { kind: "seated", handle: "herald", code: pass.code },
    ]);
  });

  it("tells a first whitelist claim, with the handle of the pass its wallet is linked to", async () => {
    const { feed, list } = desk();
    const wallet = Wallet.createRandom();
    const message = allowListMessage(wallet.address, new Date());
    await list.claim(wallet.address, message, await wallet.signMessage(message));
    await list.claim(wallet.address, message, await wallet.signMessage(message));
    expect(feed.told).toEqual([{ kind: "claim", handle: null, address: wallet.address.toLowerCase() }]);
  });

  it("tells a new idea, not the same one twice", async () => {
    const { feed, ideas } = desk();
    await ideas.submit("A duel league with seasons", "fr", "");
    await ideas.submit("A duel league   with seasons", "fr", "");
    expect(feed.told).toEqual([{ kind: "idea", handle: null, text: "A duel league with seasons", locale: "fr" }]);
  });

  it("writes messages that link the handle and never show a wallet beside it", () => {
    expect(activityText({ kind: "x-connected", handle: "cat", via: "post", code: "DNO-AAAAAA" })).toBe("𝕏 [@cat](<https://x.com/cat>) connected X on a boarding pass (a post with the code).");
    expect(activityText({ kind: "task", handle: null, code: "DNO-AAAAAA", task: "like" })).toBe("✅ pass DNO-AAAAAA (no X yet) liked the announcement.");
    expect(activityText({ kind: "claim", handle: "cat", address: "0x1234567890abcdef1234567890abcdef12345678" })).toBe("✍️ [@cat](<https://x.com/cat>) claimed a place on the whitelist.");
    expect(activityText({ kind: "claim", handle: null, address: "0x1234567890abcdef1234567890abcdef12345678" })).toBe("✍️ 0x1234…5678 claimed a place on the whitelist.");
    expect(activityText({ kind: "idea", handle: null, text: "x".repeat(600), locale: "en" })).toBe(`💡 someone without a pass left an idea (en):\n> ${"x".repeat(500)}…`);
  });
});

describe("the Discord activity feed", () => {
  const ok = () => new Response(null, { status: 204 });
  const idea = (text: string): Activity => ({ kind: "idea", handle: null, text, locale: "en" });

  it("posts in order through the webhook, with the network first and no mentions", async () => {
    const sent: { url: string; body: { content: string; allowed_mentions: unknown } }[] = [];
    const feed = new DiscordActivityFeed("https://discord.test/hook", { warn() {} }, {
      prefix: "**[sepolia]** ",
      fetcher: (async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return ok();
      }) as typeof fetch,
    });
    feed.tell(idea("first idea @everyone"));
    feed.tell(idea("second idea"));
    await feed.idle();
    expect(sent.map((s) => s.body.content)).toEqual(["**[sepolia]** 💡 someone without a pass left an idea (en):\n> first idea @everyone", "**[sepolia]** 💡 someone without a pass left an idea (en):\n> second idea"]);
    expect(sent[0]!.url).toBe("https://discord.test/hook");
    expect(sent[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it("waits out a rate limit once, drops past its queue and says how many, and survives Discord down", async () => {
    const sent: string[] = [];
    const slept: number[] = [];
    const warned: string[] = [];
    let calls = 0;
    const feed = new DiscordActivityFeed("https://discord.test/hook", { warn: (_o, m) => warned.push(m) }, {
      maxQueued: 2,
      sleep: async (ms) => void slept.push(ms),
      fetcher: (async (_url: string, init: RequestInit) => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 });
        if (calls === 3) throw new Error("down");
        sent.push(JSON.parse(String(init.body)).content);
        return ok();
      }) as typeof fetch,
    });
    // The first goes out at once (and meets the rate limit); two wait; the last two are dropped.
    for (const t of ["a", "b", "c", "d", "e"]) feed.tell(idea(t));
    await feed.idle();
    expect(slept).toEqual([1_500]);
    // "b" met Discord down and is given up; "c" carries the count of the dropped ones.
    expect(warned).toEqual(["activity feed: Discord did not answer"]);
    expect(sent).toEqual([expect.stringContaining("> a"), expect.stringMatching(/> c\n_\(2 more dropped/)]);
    feed.tell(idea("f"));
    await feed.idle();
    expect(sent[2]).toContain("> f");
  });
});
