import { encodeSeed, seedToHex } from "@dno/generator";
import { buildServer } from "../src/infrastructure/http/server";
import { beforeEach, describe, expect, it } from "vitest";
import { Herald, type HeraldOptions } from "../src/application/herald";
import { NetworkBusy, type SocialNetwork } from "../src/application/ports/herald";
import { silentLogger } from "../src/application/ports/logger";
import { Metadata } from "../src/application/metadata";
import { Queries } from "../src/application/queries";
import { SignIn } from "../src/application/auth";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import { digest, draftsFor, fit, MAX_POST, serial, tallyOf } from "../src/domain/herald";
import type { ProtocolEvent } from "../src/domain/events";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ALICE, BOB, ev, FakeChainState } from "./fixtures";

// A ghost Maine Coon (breed roll 240), smug (mood roll 200), in a party hat, in the attic, next to a broken wine glass.
const SEED = seedToHex(encodeSeed({ stateRoll: 60_000, rolls: { breed: 240, mood: 200, accessory: 215, brokenThing: 200, room: 200 }, cosmetic: 7 }));
const opened = (tokenId: number, block: number) => ev("Observed", block, { tokenId, openedBy: ALICE, seed: SEED, state: 2, score: 1234, golden: false });

describe("what the herald says", () => {
  it("words an opening from the seed, without naming the opener", () => {
    const [d] = draftsFor([{ event: opened(421, 10), enrichment: null }], { boxUrl: "https://dno.test/app.html?box=" });
    expect(d!.key).toBe("opening:421");
    expect(d!.text).toContain("DNO-0421 has been opened.");
    expect(d!.text).toContain("Inside: a ghost Maine Coon");
    expect(d!.text).toContain("https://dno.test/app.html?box=421");
    expect(d!.text).not.toContain(ALICE);
    expect(d!.text.length).toBeLessThanOrEqual(MAX_POST);
  });

  it("words milestones, duels, entanglements, the vet and the scale, and nothing else", () => {
    const events: ProtocolEvent[] = [
      ev("MilestoneReached", 1, { index: 0, sold: 100 }),
      ev("DuelResolved", 2, { duelId: 7, winner: 3, loser: 17, traitIndex: 1, roll: 0 }),
      ev("Entangled", 3, { tokenA: 3, tokenB: 17 }),
      ev("AliveProven", 4, { tokenId: 42, alive: true }),
      ev("Weighed", 5, { tokenId: 42, weight: "5000", build: 2, sick: false, disease: 0 }),
      ev("Shaken", 6, { tokenId: 42, viewer: BOB, paid: true }),
      ev("MintPlaced", 7, { firstTokenId: 50, buyer: BOB, count: 10 }),
    ];
    const drafts = draftsFor(events.map((event) => ({ event, enrichment: null })));
    expect(drafts.map((d) => d.kind)).toEqual(["milestone", "duel", "entangled", "vet", "weighIn"]);
    expect(drafts[1]!.text).toContain("DNO-0003 beat DNO-0017 on mood");
    for (const d of drafts) expect(d.text).not.toMatch(/0x[0-9a-f]{40}/);
  });

  it("sums the day, and keeps quiet on a day nothing happened", () => {
    const t = tallyOf([ev("MintPlaced", 1, { firstTokenId: 0, buyer: ALICE, count: 10 }), opened(1, 2), ev("Fed", 3, { tokenId: 1, feeder: BOB })]);
    expect(t).toMatchObject({ shipped: 10, opened: 1, pets: 1, shakes: 0 });
    expect(digest("2026-10-03", t)!.text).toContain("10 box numbers shipped");
    expect(digest("2026-10-03", tallyOf([]))).toBeNull();
  });

  it("cuts a long post at a word", () => {
    const cut = fit("word ".repeat(100));
    expect(cut.length).toBeLessThanOrEqual(MAX_POST);
    expect(cut.endsWith("word…")).toBe(true);
    expect(serial(7)).toBe("DNO-0007");
  });
});

class FakeNetwork implements SocialNetwork {
  sent: string[] = [];
  fail: Error | null = null;
  constructor(readonly name = "x") {}
  async post(text: string) {
    if (this.fail) throw this.fail;
    this.sent.push(text);
    return this.name === "rehearsal" ? null : { id: String(this.sent.length), url: `https://x.com/dno/status/${this.sent.length}` };
  }
}

const OPTS: HeraldOptions = { channel: "x", maxPerDay: 2, minGapSeconds: 600, digestHourUtc: null, staleAfterSeconds: 3_600, batch: 100, maxAttempts: 2 };

describe("the herald", () => {
  let store: MemoryStore;
  let network: FakeNetwork;
  let now: number;
  const herald = (opts: Partial<HeraldOptions> = {}) => new Herald(store, network, { ...OPTS, ...opts }, silentLogger, () => now);
  const index = async (...events: ProtocolEvent[]) =>
    store.transaction(async (tx) => {
      for (const e of events) await tx.insertEvent(e, null);
      await tx.setCursor(Math.max(...events.map((e) => e.block)));
    });

  beforeEach(() => {
    store = new MemoryStore();
    network = new FakeNetwork();
    now = 1_800_000_000;
  });

  it("starts from the present: the history is not told again", async () => {
    await index(opened(1, 10));
    expect(await herald().run()).toEqual({ queued: 0, sent: null });
    await index(opened(2, 11));
    expect(await herald().run()).toEqual({ queued: 1, sent: "opening:2" });
    expect(network.sent).toHaveLength(1);
    expect((await store.posts(10))[0]).toMatchObject({ status: "posted", externalId: "1", url: "https://x.com/dno/status/1" });
  });

  it("keeps to the gap between posts and the day's quota", async () => {
    await index(opened(1, 10));
    await herald().run();
    await index(opened(2, 11), opened(3, 12), opened(4, 13));
    await herald().run();
    expect(network.sent).toHaveLength(1);
    await herald().run();
    expect(network.sent).toHaveLength(1); // too soon
    now += 601;
    await herald().run();
    expect(network.sent).toHaveLength(2);
    now += 601;
    await herald().run();
    expect(network.sent).toHaveLength(2); // two a day
    expect((await store.nextQueuedPost("x"))!.key).toBe("opening:4");
  });

  it("drops old news, retries a failure, and gives up after the last try", async () => {
    await index(opened(1, 10));
    await herald().run();
    await index(opened(2, 11), opened(3, 12));
    network.fail = new Error("boom");
    await herald().run();
    await herald().run();
    const posts = await store.posts(10);
    expect(posts.find((p) => p.key === "opening:2")).toMatchObject({ status: "failed", attempts: 2, error: "boom" });
    network.fail = new NetworkBusy(null);
    await herald().run();
    expect((await store.nextQueuedPost("x"))).toMatchObject({ key: "opening:3", attempts: 0 });
    network.fail = null;
    now += 3_601;
    await herald().run();
    expect((await store.posts(10)).find((p) => p.key === "opening:3")!.status).toBe("skipped");
    expect(network.sent).toHaveLength(0);
  });

  it("rehearses everything at once, sending nothing", async () => {
    network = new FakeNetwork("rehearsal");
    await index(opened(1, 10));
    await herald().run();
    await index(opened(2, 11), opened(3, 12));
    await herald().run();
    await herald().run();
    expect((await store.posts(10)).map((p) => p.status)).toEqual(["rehearsed", "rehearsed"]);
  });

  it("writes the digest once a day, after its hour", async () => {
    now = Date.UTC(2026, 9, 3, 17, 0) / 1000;
    await index(ev("MintPlaced", 10, { firstTokenId: 0, buyer: ALICE, count: 10 }, { timestamp: now - 60 }));
    await herald({ digestHourUtc: 18 }).run();
    expect(await store.hasPost("x", "digest:2026-10-03")).toBe(false);
    now += 3_600;
    await herald({ digestHourUtc: 18 }).run();
    await herald({ digestHourUtc: 18 }).run();
    const digests = (await store.posts(10)).filter((p) => p.kind === "digest");
    expect(digests).toHaveLength(1);
    expect(digests[0]!.text).toContain("10 box numbers shipped");
  });

  it("records a quiet day's digest as skipped", async () => {
    now = Date.UTC(2026, 9, 3, 19, 0) / 1000;
    await index(ev("MintPlaced", 10, { firstTokenId: 0, buyer: ALICE, count: 10 }, { timestamp: now - 3 * 86_400 }));
    await herald({ digestHourUtc: 18 }).run();
    await herald({ digestHourUtc: 18 }).run();
    expect((await store.posts(10)).filter((p) => p.kind === "digest").map((p) => p.status)).toEqual(["skipped"]);
  });
});

describe("GET /v1/herald", () => {
  it("lists the posts, behind the token when there is one", async () => {
    const store = new MemoryStore();
    await store.queuePosts("x", [{ key: "opening:1", kind: "opening", text: "📦 DNO-0001 has been opened." }], { block: 1, logIndex: 0 }, 1);
    await store.queuePosts("discord", [{ key: "opening:1", kind: "opening", text: "📦 DNO-0001 has been opened." }], { block: 1, logIndex: 0 }, 1);
    const queries = new Queries(store, new FakeChainState());
    const app = await buildServer({
      queries,
      metadata: new Metadata(queries, "https://api.test"),
      signIn: new SignIn(store, ethersVerifier, new HmacSessions("s".repeat(32)), { now: () => 1 }, "test", () => "n"),
      herald: { posts: store, adminToken: "secret" },
      corsOrigins: [],
      rateLimitPerMinute: 10_000,
    });
    expect((await app.inject({ method: "GET", url: "/v1/herald" })).statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/v1/herald?token=secret" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toHaveLength(2);
    const discord = await app.inject({ method: "GET", url: "/v1/herald?token=secret&network=discord" });
    expect(discord.json().data).toEqual([expect.objectContaining({ network: "discord", key: "opening:1", status: "queued" })]);
    await app.close();
  });
});
