import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AskManual, type AnswerModel, type ChatAnswer } from "../src/application/askManual";
import { Herald, type HeraldOptions } from "../src/application/herald";
import { NetworkBusy, type SocialNetwork } from "../src/application/ports/herald";
import { silentLogger } from "../src/application/ports/logger";
import { SignIn } from "../src/application/auth";
import { Metadata } from "../src/application/metadata";
import { Queries } from "../src/application/queries";
import type { MANUAL_LOCALES, Manual } from "../src/domain/manual";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import manualJson from "../src/infrastructure/chat/manual.json";
import { ASK_COMMAND, clerkReply, DiscordClerk, localeOf, signedByDiscord } from "../src/infrastructure/discord/DiscordClerk";
import { buildServer } from "../src/infrastructure/http/server";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { DiscordNetwork } from "../src/infrastructure/social/DiscordNetwork";
import { ALICE, ev, FakeChainState } from "./fixtures";

const MANUALS = manualJson.locales as Record<(typeof MANUAL_LOCALES)[number], Manual>;
const WEBHOOK = "https://discord.com/api/webhooks/1/abc";

/** A fetch that answers from a list of handlers, and records what it was asked. */
function fakeFetch(handle: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handle(String(url), init);
  }) as typeof fetch;
  return { calls, fetcher };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("the Discord channel", () => {
  it("posts through the webhook, mentioning no one, and links the message", async () => {
    const { calls, fetcher } = fakeFetch((url) => (url === WEBHOOK ? json({ guild_id: "9", channel_id: "8" }) : json({ id: "77", channel_id: "8" })));
    const network = new DiscordNetwork(WEBHOOK, 1_000, fetcher);
    expect(await network.post("📦 DNO-0001 has been opened. @everyone")).toEqual({ id: "77", url: "https://discord.com/channels/9/8/77" });
    await network.post("again");
    // The webhook is described once.
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK, `${WEBHOOK}?wait=true`, `${WEBHOOK}?wait=true`]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ content: "📦 DNO-0001 has been opened. @everyone", allowed_mentions: { parse: [] } });
  });

  it("waits when rate limited and fails on a refusal", async () => {
    let status = 429;
    const { fetcher } = fakeFetch((url) => (url === WEBHOOK ? json({ guild_id: "9" }) : json({ message: "nope", retry_after: 2.5 }, status)));
    const network = new DiscordNetwork(WEBHOOK, 1_000, fetcher);
    await expect(network.post("x")).rejects.toBeInstanceOf(NetworkBusy);
    status = 404;
    await expect(network.post("x")).rejects.toThrow("Discord refused the post (404): nope");
  });
});

describe("a herald per network", () => {
  const OPTS = { maxPerDay: 1, minGapSeconds: 0, digestHourUtc: null, staleAfterSeconds: 3_600, batch: 100, maxAttempts: 2 } satisfies Omit<HeraldOptions, "channel">;
  const network = (name: string, sent: string[]): SocialNetwork => ({ name, post: async (t) => (sent.push(t), { id: String(sent.length), url: `https://${name}/${sent.length}` }) });
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("tells each network everything, within each one's own quota", async () => {
    const x: string[] = [];
    const discord: string[] = [];
    const now = () => 1_800_000_000;
    const heralds = [
      new Herald(store, network("x", x), { ...OPTS, channel: "x" }, silentLogger, now),
      new Herald(store, network("discord", discord), { ...OPTS, channel: "discord", maxPerDay: 10 }, silentLogger, now),
    ];
    const index = (block: number) =>
      store.transaction(async (tx) => {
        await tx.insertEvent(ev("Observed", block, { tokenId: block, openedBy: ALICE, seed: `0x${"11".repeat(8)}`, state: 0, score: 10, golden: false }), null);
        await tx.setCursor(block);
      });
    await index(1);
    for (const h of heralds) await h.run();
    await index(2);
    await index(3);
    for (let i = 0; i < 3; i++) for (const h of heralds) await h.run();
    expect(x).toHaveLength(1);
    expect(discord).toHaveLength(2);
    expect((await store.posts(10, "x")).map((p) => p.status)).toEqual(["queued", "posted"]);
  });
});

describe("the clerk on Discord", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = (keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  const signed = (body: string, timestamp = "1700000000") => ({
    "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex"),
    "x-signature-timestamp": timestamp,
    "content-type": "application/json",
  });
  const model: AnswerModel = { answer: async () => ({ text: "Shaking costs nothing but your dignity.", sections: ["box"] }) };
  const command = (options: { name: string; value: string | boolean }[], locale = "fr") => ({
    type: 2,
    token: "tok",
    locale,
    member: { user: { id: "42" } },
    data: { name: "ask", options },
  });

  it("checks Discord's signature", () => {
    const body = JSON.stringify({ type: 1 });
    const h = signed(body);
    expect(signedByDiscord(publicKey, h["x-signature-ed25519"], h["x-signature-timestamp"], body)).toBe(true);
    expect(signedByDiscord(publicKey, h["x-signature-ed25519"], h["x-signature-timestamp"], `${body} `)).toBe(false);
    expect(signedByDiscord(publicKey, "zz", h["x-signature-timestamp"], body)).toBe(false);
  });

  it("reads Discord's locales", () => {
    expect([localeOf("fr"), localeOf("es-419"), localeOf("it"), localeOf("en-GB"), localeOf("de"), localeOf(undefined)]).toEqual(["fr", "es", "it", "en", "en", "en"]);
  });

  it("answers later by editing the deferred message, only to the asker", async () => {
    const { calls, fetcher } = fakeFetch(() => json({}));
    const clerk = new DiscordClerk(new AskManual(MANUALS, model, { perIpPerDay: 5, perDay: 5, cacheSize: 5 }), { applicationId: "app", manualUrl: "https://dno.test/docs.html" }, silentLogger, fetcher);
    expect(clerk.respond(command([{ name: "question", value: "Ça coûte quoi de secouer ?" }]))).toEqual({ type: 5, data: { flags: 64 } });
    await clerk.idle();
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/webhooks/app/tok/messages/@original");
    expect(calls[0]!.init.method).toBe("PATCH");
    const content = JSON.parse(String(calls[0]!.init.body)).content as string;
    expect(content).toContain("> Ça coûte quoi de secouer ?");
    expect(content).toContain("Shaking costs nothing but your dignity.");
    expect(content).toContain("(<https://dno.test/docs.html#box>)");
  });

  it("quotes the manual without a model, and keeps within Discord's limit", async () => {
    const chat = new AskManual(MANUALS, null, { perIpPerDay: 5, perDay: 5, cacheSize: 5 });
    const a: ChatAnswer = await chat.ask({ question: "what happens when I open a box", locale: "en", history: [] }, "t");
    const text = clerkReply("what happens when I open a box", a, "en", null);
    expect(text).toContain("The clerk is away from the desk.");
    const long: ChatAnswer = { ...a, passages: a.passages.map((p) => ({ ...p, text: p.text.repeat(30) })) };
    expect(clerkReply("q".repeat(500), long, "en", "https://dno.test/docs.html").length).toBeLessThanOrEqual(2000);
  });

  it("serves the interactions route only to Discord", async () => {
    const store = new MemoryStore();
    const queries = new Queries(store, new FakeChainState());
    const clerk = new DiscordClerk(new AskManual(MANUALS, null, { perIpPerDay: 5, perDay: 5, cacheSize: 5 }), { applicationId: "app", manualUrl: null }, silentLogger, fakeFetch(() => json({})).fetcher);
    const app = await buildServer({
      queries,
      metadata: new Metadata(queries, "https://api.test"),
      signIn: new SignIn(store, ethersVerifier, new HmacSessions("s".repeat(32)), { now: () => 1 }, "test", () => "n"),
      discord: { clerk, publicKey },
      corsOrigins: [],
      rateLimitPerMinute: 10_000,
    });
    const ping = JSON.stringify({ type: 1 });
    expect((await app.inject({ method: "POST", url: "/v1/discord/interactions", payload: ping, headers: { ...signed(ping), "x-signature-ed25519": "00".repeat(64) } })).statusCode).toBe(401);
    const pong = await app.inject({ method: "POST", url: "/v1/discord/interactions", payload: ping, headers: signed(ping) });
    expect(pong.json()).toEqual({ type: 1 });
    const other = JSON.stringify({ type: 2, token: "t", locale: "it", data: { name: "dance" } });
    expect((await app.inject({ method: "POST", url: "/v1/discord/interactions", payload: other, headers: signed(other) })).json()).toEqual({ type: 4, data: { content: "Il deposito conosce solo /ask.", flags: 64 } });
    await clerk.idle();
    await app.close();
  });

  it("declares a command Discord accepts", () => {
    expect(ASK_COMMAND.description.length).toBeLessThanOrEqual(100);
    for (const o of ASK_COMMAND.options) {
      expect(o.description.length).toBeLessThanOrEqual(100);
      for (const d of Object.values(o.description_localizations)) expect(d.length).toBeLessThanOrEqual(100);
      for (const n of Object.values(o.name_localizations)) expect(n).toMatch(/^[-_\p{L}\p{N}]{1,32}$/u);
    }
    for (const d of Object.values(ASK_COMMAND.description_localizations)) expect(d.length).toBeLessThanOrEqual(100);
  });
});
