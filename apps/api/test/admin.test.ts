import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignIn } from "../src/application/auth";
import { ImageArchive } from "../src/application/archive";
import { Insights, seatedAt } from "../src/application/insights";
import { Metadata } from "../src/application/metadata";
import { Queries } from "../src/application/queries";
import { Seats } from "../src/application/seats";
import type { XPass } from "../src/application/xPass";
import { AdminSessions } from "../src/infrastructure/http/admin";
import { ethersVerifier, HmacSessions } from "../src/infrastructure/auth/crypto";
import { buildServer } from "../src/infrastructure/http/server";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ALICE, BOB, ev, FakeChainState } from "./fixtures";

const DAY = 86_400;
const NOW = 20_010 * DAY + 12 * 3600;
const PASSWORD = "correct horse battery staple";

function pass(over: Partial<XPass> & { id: string; code: string }): XPass {
  return {
    handle: null, xUserId: null, tweetId: null, tweetUrl: null, followedAt: null, postedAt: null, likedAt: null, repliedAt: null, repostedAt: null,
    address: null, discordUserId: null, discordJoinedAt: null, referredBy: null, createdAt: NOW - 3 * DAY, verifiedAt: null, updatedAt: NOW - 3 * DAY,
    ...over,
  };
}

async function seeded() {
  const store = new MemoryStore();
  // Three passes: one seated today with a wallet that claimed, one with X and half its tasks, one bare.
  await store.saveXPass(pass({ id: "a", code: "DNO-AAAAAA", handle: "cat", verifiedAt: NOW - 2 * DAY, followedAt: NOW - 2 * DAY, postedAt: NOW - 3600, address: ALICE, discordUserId: "1", discordJoinedAt: NOW - 60, updatedAt: NOW - 60 }));
  await store.saveXPass(pass({ id: "b", code: "DNO-BBBBBB", handle: "dog", verifiedAt: NOW - DAY, followedAt: NOW - DAY, updatedAt: NOW - DAY }));
  await store.saveXPass(pass({ id: "c", code: "DNO-CCCCCC", createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY }));
  await store.saveAllowListClaim({ address: ALICE, points: 3, message: "m", signature: "s", claimedAt: NOW - 1800, updatedAt: NOW - 1800 });
  await store.saveAllowListClaim({ address: BOB, points: 1, message: "m", signature: "s", claimedAt: NOW - 8 * DAY, updatedAt: NOW - 8 * DAY });
  await store.saveIdea({ text: "A duel league with seasons", handle: "cat", locale: "fr", createdAt: NOW - 100 });
  await store.transaction(async (tx) => {
    await tx.insertEvent(ev("MintPlaced", 1, { firstTokenId: 0, buyer: ALICE, count: 3 }, { timestamp: NOW - 3600 }), null);
    await tx.insertEvent(ev("Shaken", 2, { tokenId: 1, viewer: BOB, paid: true }, { timestamp: NOW - DAY }), null);
  });
  const seats = new Seats(store, 10, async () => new Set([BOB]), ["follow", "post"]);
  return { store, seats, insights: new Insights(store, seats, { now: () => NOW }) };
}

describe("the dashboard", () => {
  it("dates a seat at the account or the last required task, whichever came later", () => {
    const p = pass({ id: "x", code: "DNO-XXXXXX", handle: "h", verifiedAt: 50, followedAt: 10, postedAt: 40 });
    expect(seatedAt(p, ["follow", "post"])).toBe(50);
    expect(seatedAt({ ...p, verifiedAt: 5 }, ["follow", "post"])).toBe(40);
    expect(seatedAt({ ...p, postedAt: null }, ["follow", "post"])).toBeNull();
    expect(seatedAt({ ...p, handle: null }, ["follow", "post"])).toBeNull();
  });

  it("counts the funnel, the day's figures, the seats' pace and the chain's events", async () => {
    const { insights } = await seeded();
    const d = await insights.dashboard(14);
    expect(d.funnel).toEqual([
      { step: "pass", count: 3 },
      { step: "x", count: 2 },
      { step: "task:follow", count: 2 },
      { step: "task:post", count: 1 },
      { step: "seated", count: 1 },
      { step: "wallet", count: 1 },
      { step: "claimed", count: 1 },
      { step: "discord", count: 1 },
    ]);
    const kpi = (key: string) => d.kpis.find((k) => k.key === key)!;
    expect(kpi("passes")).toMatchObject({ total: 3, today: 0, last7: 2, prev7: 1 });
    expect(kpi("seated")).toMatchObject({ total: 1, today: 1 });
    expect(kpi("claims")).toMatchObject({ total: 2, today: 1, last7: 1, prev7: 1 });
    expect(kpi("purchases")).toMatchObject({ total: 1, today: 1 });
    expect(kpi("active")).toMatchObject({ today: 1, yesterday: 1 });
    expect(kpi("passes").spark).toHaveLength(14);
    // The bare claim of a testnet player and the seated pass: 2 of 10, 2 sat this week.
    expect(d.seats).toMatchObject({ taken: 2, places: 10, perDay: 0.3, daysToFull: 28 });
    expect(d.medianToSeat).toBe(3 * DAY - 3600);
    expect(d.boarding.at(-1)).toMatchObject({ seated: 1, claims: 1, discord: 1, ideas: 1 });
    expect(d.chain.at(-1)).toMatchObject({ purchases: 1, active: 1 });
    expect(d.ideasByLocale).toEqual({ fr: 1 });
    expect(d.heatmap.flat().reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(d.recent[0]).toMatchObject({ kind: "discord", who: "@cat" });
    // A claim behind a pass shows its handle, never its wallet.
    expect(d.recent.find((r) => r.kind === "claim" && r.who === "@cat")).toBeTruthy();
    expect(JSON.stringify(d)).not.toContain(ALICE);
  });

  it("lists the players without their wallets, the newest first", async () => {
    const { insights } = await seeded();
    const players = await insights.players();
    expect(players.map((p) => p.code)).toEqual(["DNO-AAAAAA", "DNO-BBBBBB", "DNO-CCCCCC"]);
    expect(players[0]).toMatchObject({ handle: "cat", seated: true, wallet: true, claimed: true, discord: true });
    expect(JSON.stringify(players)).not.toContain(ALICE);
    expect(await insights.walletOf("DNO-AAAAAA")).toBe(ALICE);
  });
});

describe("the admin site's password", () => {
  it("opens a session that a new password closes", () => {
    const s = new AdminSessions(PASSWORD);
    expect(s.passwordMatches(PASSWORD)).toBe(true);
    expect(s.passwordMatches("nope")).toBe(false);
    const token = s.issue(NOW + 60);
    expect(s.valid(token, NOW)).toBe(true);
    expect(s.valid(token, NOW + 61)).toBe(false);
    expect(s.valid(`${NOW + 9999}.${token.split(".")[1]}`, NOW)).toBe(false);
    expect(new AdminSessions(`${PASSWORD}!`).valid(token, NOW)).toBe(false);
    expect(() => new AdminSessions("short")).toThrow();
  });
});

describe("the admin routes", () => {
  let app: FastifyInstance;
  const logged: string[] = [];

  beforeAll(async () => {
    const { store, insights } = await seeded();
    const dir = mkdtempSync(join(tmpdir(), "dno-admin-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>admin</title>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app-1.js"), "console.log(1)");
    const queries = new Queries(store, new FakeChainState(), () => NOW);
    app = await buildServer({
      queries,
      metadata: new Metadata(queries, "https://api.test", new ImageArchive(store, "https://arweave.net")),
      signIn: new SignIn(store, ethersVerifier, new HmacSessions("x".repeat(32)), { now: () => NOW }, "donotopen.test", () => "n"),
      admin: { insights, password: PASSWORD, staticDir: dir, now: () => NOW, log: { info: (_o, m) => void logged.push(m), warn: (_o, m) => void logged.push(m) } },
      corsOrigins: ["*"],
      rateLimitPerMinute: 1000,
    });
  });
  afterAll(() => app.close());

  const login = (password: string) => app.inject({ method: "POST", url: "/admin/api/login", payload: { password } });

  it("answers nothing without the password, and everything with it", async () => {
    expect((await app.inject("/admin/api/dashboard")).statusCode).toBe(401);
    expect((await app.inject("/admin/api/players/DNO-AAAAAA/wallet")).statusCode).toBe(401);
    expect((await app.inject("/admin/api/session")).json()).toEqual({ signedIn: false });
    expect((await login("wrong password!!")).statusCode).toBe(401);

    const ok = await login(PASSWORD);
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(/^dno_admin=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/);
    const headers = { cookie: cookie.split(";")[0]! };

    expect((await app.inject({ url: "/admin/api/session", headers })).json()).toEqual({ signedIn: true });
    const dashboard = await app.inject({ url: "/admin/api/dashboard?days=7", headers });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.headers["cache-control"]).toBe("no-store");
    expect(dashboard.json().funnel[0]).toEqual({ step: "pass", count: 3 });
    expect((await app.inject({ url: "/admin/api/players", headers })).json()).toHaveLength(3);
    expect((await app.inject({ url: "/admin/api/ideas", headers })).json()[0].text).toBe("A duel league with seasons");
    expect((await app.inject({ url: "/admin/api/players/DNO-AAAAAA/wallet", headers })).json()).toEqual({ address: ALICE });
    expect((await app.inject({ url: "/admin/api/players/nope/wallet", headers })).statusCode).toBe(400);
    expect(logged).toEqual(["admin: wrong password", "admin: signed in", "admin: wallet shown"]);

    const out = await app.inject({ method: "POST", url: "/admin/api/logout", headers });
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("serves the app: its assets cached for good, any other page its index", async () => {
    const asset = await app.inject("/admin/assets/app-1.js");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.headers["content-type"]).toContain("javascript");
    const page = await app.inject("/admin/players");
    expect(page.body).toContain("<title>admin</title>");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect((await app.inject("/admin/assets/missing.js")).statusCode).toBe(404);
    expect((await app.inject("/admin/api/unknown")).statusCode).toBe(404);
    expect((await app.inject("/admin")).headers.location).toBe("/admin/");
  });

  it("limits sign-in attempts per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: "POST", url: "/admin/api/login", payload: { password: "still wrong!!!!!" }, remoteAddress: "10.0.0.9" })).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });
});
