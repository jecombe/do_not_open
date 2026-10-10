import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { giftTree, type GiftProofs } from "../../application/whitelistGifts";
import type { AllowList } from "../../application/allowList";
import { ListFull, type Seats } from "../../application/seats";
import { IDEA_MAX, type Ideas } from "../../application/ideas";
import { X_TASKS, XPassRefused, type XPassRefusal, type XPasses } from "../../application/xPass";
import { askInput, type AskManual } from "../../application/askManual";
import { Unauthorized, type SignIn } from "../../application/auth";
import type { AcceptTerms } from "../../application/terms";
import type { PostStore } from "../../application/ports/herald";
import type { Metadata } from "../../application/metadata";
import { BadRequest, NotFound, type Queries } from "../../application/queries";
import { RelayerRefused, type RelayerGate, type RelayerOp } from "../../application/relayerGate";
import { StudioRefused, type Studio } from "../../application/studio";
import { RatRefused, type Rats } from "../../application/rats";
import { VaultRelayRefused, type VaultRelay } from "../../application/vaultRelay";
import type { StudioJob } from "../../domain/studio";
import { normalizeAddress, type Address } from "../../domain/types";
import { signedByDiscord, type DiscordClerk } from "../discord/DiscordClerk";
import type { IndexerStatus } from "../Indexer";
import type { EndpointStatus } from "../chain/RpcPool";
import type { Metrics } from "./metrics";
import { registerAdmin, type AdminDeps } from "./admin";

export interface HttpDeps {
  queries: Queries;
  metadata: Metadata;
  signIn: SignIn;
  /** Signed release forms. Absent: the app keeps its signatures in the browser only. */
  terms?: AcceptTerms;
  /** The mainnet allow list, with the token that reads the whole list. Absent: no claims. */
  allowList?: { list: AllowList; adminToken: string | null; seats?: Seats; gifts?: GiftProofs };
  /** The boarding page's suggestion box; the allow list's admin token reads it. */
  ideas?: { box: Ideas; adminToken: string | null };
  /** X boarding passes; the admin token (the allow list's) lists them all; Sign in with X
   *  sends players back only to `returnOrigins`. */
  xPasses?: { passes: XPasses; adminToken: string | null; returnOrigins: string[]; announcement?: string | null };
  /** The relayer proxy. Absent: the app talks to Zama's relayer directly. */
  relayer?: RelayerGate;
  /** Relayer submissions per minute per IP. */
  relayerRatePerMinute?: number;
  /** The studio: cats drawn by paid AI services out of packs bought on-chain. */
  studio?: {
    studio: Studio;
    /** Where this API is reached from outside: job files are linked through it. */
    publicUrl: string;
    /** Fetches the services' files for the proxy routes. */
    fetch?: typeof fetch;
    /** Hosts the service's files may come from (and their subdomains). fal.ai's by default. */
    fileHosts?: string[];
  };
  /** The depot's rats: read back, described for marketplaces, and adopted. */
  rats?: Rats;
  /** The sealed vault's relayer. Absent: holders send their requests from their own wallet. */
  vaultRelay?: VaultRelay;
  /** Vault relays per minute per IP. */
  vaultRelayRatePerMinute?: number;
  /** The manual's chatbot. */
  chat?: AskManual;
  /** The Warden: the same chat on the vault's and the project's docs (`book: "vault"`). */
  vaultChat?: AskManual;
  /** Chat questions per minute per IP. */
  chatRatePerMinute?: number;
  /** The manual's chatbot as Discord's `/ask`, with the application's public key that signs each call. */
  discord?: { clerk: DiscordClerk; publicKey: string };
  /** The collection's accounts: their posts, sent or rehearsed. With a token, only for whoever has it. */
  herald?: { posts: Pick<PostStore, "posts">; adminToken: string | null };
  /** Absent when this process does not index (ROLE=api). */
  indexer?: { status(): IndexerStatus; nudge(): void };
  /** Wakes the indexer wherever it runs (ROLE=api: over Postgres). Defaults to `indexer.nudge`. */
  nudge?: () => void;
  rpcStatus?: () => EndpointStatus[];
  /** Prometheus metrics at GET /metrics. The edge proxy refuses that path from outside; the monitoring stack scrapes it over the Docker network. */
  metrics?: Metrics;
  /** The team's admin site, under /admin. Absent (no ADMIN_PASSWORD): nothing is served there. */
  admin?: AdminDeps;
  /** Origins allowed to call from a browser. `*` alone allows any; inside an origin, it matches one DNS label. */
  corsOrigins: string[];
  /** Requests per minute per IP. */
  rateLimitPerMinute: number;
  logger?: boolean | object;
  /** Trust X-Forwarded-For: the API runs behind Caddy. */
  trustProxy?: boolean;
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not an address").transform(normalizeAddress);
const id = z.coerce.number().int().min(0).max(2 ** 31 - 1);
const ids = z
  .string()
  .regex(/^\d+(,\d+)*$/, "comma-separated token ids")
  .transform((s) => [...new Set(s.split(",").map(Number))])
  .refine((a) => a.length <= 500, "at most 500 token ids");

/** "https://app-*.vercel.app" matches every preview deployment; other entries match as they are. */
function originPattern(origin: string): string | RegExp {
  if (!origin.includes("*")) return origin;
  const escaped = origin.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+");
  return new RegExp(`^${escaped}$`);
}

/** Short public caching: a CDN or the browser answers repeat visits; data is a block or two old anyway. */
const PUBLIC_CACHE = "public, max-age=5, stale-while-revalidate=30";
const PRIVATE_CACHE = "private, max-age=5";

export async function buildServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: deps.trustProxy ?? false, bodyLimit: 16 * 1024 });
  const { queries } = deps;

  await app.register(cors, {
    origin: deps.corsOrigins.includes("*") ? true : deps.corsOrigins.map(originPattern),
    methods: ["GET", "POST", "OPTIONS"],
    // The Relayer SDK names itself in two headers, and polls on Retry-After.
    allowedHeaders: ["content-type", "authorization", "zama-sdk-version", "zama-sdk-name"],
    exposedHeaders: ["retry-after"],
    maxAge: 86_400,
  });
  await app.register(rateLimit, { max: deps.rateLimitPerMinute, timeWindow: "1 minute" });

  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({ error: "bad-request", message: error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") });
    if (error instanceof BadRequest) return reply.status(400).send({ error: "bad-request", message: error.message });
    if (error instanceof NotFound) return reply.status(404).send({ error: "not-found", message: error.message });
    if (error instanceof Unauthorized) return reply.status(401).send({ error: "unauthorized", message: error.message });
    if (error instanceof ListFull) return reply.status(409).send({ error: "list-full", message: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.status(error.statusCode).send({ error: "request", message: error.message });
    app.log.error(error);
    return reply.status(500).send({ error: "internal", message: "something went wrong" });
  });

  /** Every answer says how fresh it is: the last block indexed. */
  const send = async (reply: FastifyReply, data: unknown, cache = PUBLIC_CACHE) => {
    reply.header("cache-control", cache);
    return { block: await queries.indexedBlock(), data };
  };

  const bearer = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw new Unauthorized("sign in first");
    return deps.signIn.whoIs(h.slice(7));
  };

  // --- health ---

  if (deps.metrics) {
    const metrics = deps.metrics;
    app.addHook("onResponse", async (req, reply) => {
      metrics.observe(req.method, req.routeOptions.url ?? "unmatched", reply.statusCode, reply.elapsedTime / 1000);
    });
    app.get("/metrics", { config: { rateLimit: false } }, async (_req, reply) => {
      reply.header("content-type", metrics.contentType).header("cache-control", "no-store");
      return metrics.render();
    });
  }

  app.get("/health", async (_req, reply) => {
    const block = await queries.indexedBlock();
    const indexer = deps.indexer?.status() ?? null;
    reply.header("cache-control", "no-store");
    return { ok: true, block, indexer, rpc: deps.rpcStatus?.() ?? null };
  });

  if (deps.admin) await registerAdmin(app, deps.admin);

  // --- collection and boxes ---

  app.get("/v1/collection", async (_req, reply) => send(reply, await queries.collection()));

  app.get("/v1/boxes", async (req, reply) => {
    const q = z.object({ from: id, to: id }).parse(req.query);
    return send(reply, await queries.boxes(q.from, q.to));
  });

  app.get("/v1/boxes/:id", async (req, reply) => {
    const { id: tokenId } = z.object({ id }).parse(req.params);
    return send(reply, await queries.box(tokenId));
  });

  app.get("/v1/boxes/:id/pantry", async (req, reply) => {
    const { id: tokenId } = z.object({ id }).parse(req.params);
    return send(reply, await queries.boxPantry(tokenId));
  });

  app.get("/v1/boxes/:id/activity", async (req, reply) => {
    const { id: tokenId } = z.object({ id }).parse(req.params);
    const q = z.object({ before: id.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    return send(reply, await queries.activity({ tokenId, beforeBlock: q.before, limit: q.limit }));
  });

  app.get("/v1/pairs/:a/:b", async (req, reply) => {
    const p = z.object({ a: id, b: id }).parse(req.params);
    return send(reply, await queries.pair(p.a, p.b));
  });

  app.get("/v1/leaderboard", async (_req, reply) => send(reply, await queries.leaderboard()));

  app.get("/v1/leaderboard/duels", async (_req, reply) => send(reply, await queries.duelStandings()));

  // --- duels ---

  app.get("/v1/proposals", async (req, reply) => {
    const q = z.object({ tokens: ids }).parse(req.query);
    // Token ids in a query reveal what the caller holds to this server: not cached by anyone in between.
    return send(reply, await queries.proposals(q.tokens), "private, no-store");
  });

  app.get("/v1/duels", async (req, reply) => {
    const q = z
      .object({
        account: address.optional(),
        tokens: ids.optional(),
        open: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    // Token ids in a query reveal what the caller holds to this server: not cached by anyone in between.
    return send(reply, await queries.duels({ account: q.account, tokenIds: q.tokens, open: q.open === "true", limit: q.limit }), q.tokens ? "private, no-store" : PUBLIC_CACHE);
  });

  // Before /v1/duels/:id, which would read "shelf" as an id.
  app.get("/v1/duels/shelf", async (_req, reply) => send(reply, await queries.duelShelf()));

  app.get("/v1/duels/:id", async (req, reply) => {
    const { id: duelId } = z.object({ id }).parse(req.params);
    return send(reply, await queries.duel(duelId));
  });

  // --- accounts ---

  app.get("/v1/accounts/:address", async (req, reply) => {
    const p = z.object({ address }).parse(req.params);
    return send(reply, await queries.account(p.address));
  });

  app.get("/v1/accounts/:address/requests", async (req, reply) => {
    const p = z.object({ address }).parse(req.params);
    return send(reply, await queries.pendingRequests(p.address), PRIVATE_CACHE);
  });

  app.get("/v1/accounts/:address/transfers", async (req, reply) => {
    const p = z.object({ address }).parse(req.params);
    const q = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() }).parse(req.query);
    return send(reply, await queries.transfers(p.address, q.after ?? 0, q.limit), PRIVATE_CACHE);
  });

  // --- economy, feed, stats ---

  app.get("/v1/economy", async (_req, reply) => {
    const economy = await queries.economy();
    if (!economy) throw new NotFound("no croquette economy on this network");
    return send(reply, economy);
  });

  app.get("/v1/activity", async (req, reply) => {
    const q = z.object({ before: id.optional(), limit: z.coerce.number().int().min(1).max(200).optional(), account: address.optional() }).parse(req.query);
    return send(reply, await queries.activity({ beforeBlock: q.before, limit: q.limit, account: q.account }));
  });

  app.get("/v1/stats", async (_req, reply) => send(reply, await queries.stats()));

  // --- sign-in ---

  app.post("/v1/auth/nonce", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ address }).parse(req.body);
    reply.header("cache-control", "no-store");
    return deps.signIn.challenge(body.address);
  });

  app.post("/v1/auth/verify", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ address, signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(req.body);
    reply.header("cache-control", "no-store");
    return deps.signIn.verify(body.address, body.signature);
  });

  // --- release form ---

  const terms = deps.terms;
  if (terms) {
    app.post("/v1/terms", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = z.object({ address, message: z.string().min(1).max(4_000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(req.body);
      reply.header("cache-control", "no-store");
      const a = await terms.accept(body.address, body.message, body.signature);
      return { address: a.address, version: a.version, hash: a.hash, receivedAt: a.receivedAt };
    });

    app.get("/v1/terms/:address", async (req, reply) => {
      const p = z.object({ address }).parse(req.params);
      const all = await terms.of(p.address);
      reply.header("cache-control", "no-store");
      return { data: all.map((a) => ({ version: a.version, hash: a.hash, signature: a.signature, message: a.message, receivedAt: a.receivedAt })) };
    });
  }

  // --- mainnet allow list ---

  const allowList = deps.allowList;
  if (allowList) {
    app.post("/v1/allowlist", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = z.object({ address, message: z.string().min(1).max(1_000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(req.body);
      return send(reply, await allowList.list.claim(body.address, body.message, body.signature), "no-store");
    });

    const seats = allowList.seats;
    if (seats) {
      // How many seats are taken on the mainnet list, out of how many: the boarding page's counter.
      app.get("/v1/seats", async (_req, reply) => {
        reply.header("cache-control", "public, max-age=10");
        return { data: await seats.view() };
      });
    }

    app.get("/v1/allowlist/:address", async (req, reply) => {
      const p = z.object({ address }).parse(req.params);
      return send(reply, await allowList.list.status(p.address), "private, no-store");
    });

    // The whole list names every claimant: only for whoever holds the token.
    app.get("/v1/allowlist", async (req, reply) => {
      const q = z.object({ token: z.string().optional() }).parse(req.query);
      reply.header("cache-control", "no-store");
      if (!allowList.adminToken || q.token !== allowList.adminToken) return reply.status(401).send({ error: "unauthorized" });
      return { data: await allowList.list.ranked() };
    });

    // The list as it stands, frozen into the gifts' Merkle tree: what to keep (WHITELIST_GIFTS_TREE)
    // and whose root to set on WhitelistGifts when the list closes.
    app.get("/v1/allowlist/gifts", async (req, reply) => {
      const q = z.object({ token: z.string().optional() }).parse(req.query);
      reply.header("cache-control", "no-store");
      if (!allowList.adminToken || q.token !== allowList.adminToken) return reply.status(401).send({ error: "unauthorized" });
      const tree = giftTree(await allowList.list.ranked());
      return { data: tree ? { root: tree.root, count: tree.length, tree: tree.dump() } : { root: null, count: 0, tree: null } };
    });

    // A wallet's gift proof, once the list is frozen. Public: the claim on-chain shows it anyway.
    const gifts = allowList.gifts;
    app.get("/v1/gifts/:address", async (req, reply) => {
      const p = z.object({ address }).parse(req.params);
      reply.header("cache-control", "public, max-age=60");
      if (!gifts?.frozen) return reply.status(404).send({ error: "not-frozen", message: "the whitelist is not frozen yet" });
      const proof = gifts.proofOf(p.address);
      if (!proof) return reply.status(404).send({ error: "not-on-list", message: "this wallet has no gift" });
      return { data: proof };
    });
  }

  // --- X boarding passes ---

  const xPasses = deps.xPasses;
  if (xPasses) {
    const PASS_STATUS: Record<XPassRefusal, number> = {
      "no-pass": 401,
      "bad-tweet-url": 400,
      "tweet-not-found": 404,
      "code-missing": 400,
      "tweet-used": 409,
      "x-down": 503,
      "connect-x-first": 409,
      "address-taken": 409,
      "bad-message": 400,
      "bad-signature": 401,
      "sign-in-off": 503,
      "sign-in-expired": 400,
      "sign-in-refused": 400,
      "list-full": 409,
      "discord-off": 503,
      "bad-referral": 404,
      "referral-locked": 409,
    };
    const passToken = (req: FastifyRequest) => {
      const h = req.headers.authorization;
      return h?.startsWith("Bearer ") ? h.slice(7) : "";
    };
    const passed = async <T>(reply: FastifyReply, run: () => Promise<T>) => {
      reply.header("cache-control", "private, no-store");
      try {
        return { data: await run() };
      } catch (error) {
        if (!(error instanceof XPassRefused)) throw error;
        return reply.status(PASS_STATUS[error.code]).send({ error: error.code, message: error.message });
      }
    };
    const { passes } = xPasses;

    const referral = z.string().trim().max(20);
    app.post("/v1/xpass", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = z.object({ ref: referral.optional() }).nullish().parse(req.body);
      return passed(reply, () => passes.start(body?.ref || null));
    });
    app.get("/v1/xpass", async (req, reply) => passed(reply, () => passes.status(passToken(req))));
    // Sign in with X: the site asks for the URL (the pass token stays out of any address bar),
    // X sends the player back to the callback, which sends them back to the site.
    const returnOk = (url: string) => {
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return false;
      }
      return xPasses.returnOrigins.some((o) => {
        const p = originPattern(o);
        return typeof p === "string" ? p === origin : p.test(origin);
      });
    };
    app.get("/v1/xpass/x", async (_req, reply) => {
      reply.header("cache-control", "public, max-age=60");
      return { data: { signIn: passes.signInEnabled, announcement: xPasses.announcement ?? null, discord: passes.discordEnabled } };
    });
    app.post("/v1/xpass/x/start", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = z.object({ returnTo: z.string().url().max(500) }).parse(req.body);
      if (!returnOk(body.returnTo)) return reply.status(400).send({ error: "bad-request", message: "returnTo is not one of the site's pages" });
      return passed(reply, () => passes.startSignIn(passToken(req), body.returnTo));
    });
    app.get("/v1/xpass/x/callback", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const q = z.object({ state: z.string().max(200).default(""), code: z.string().max(2_000).optional(), error: z.string().max(200).optional() }).parse(req.query);
      const { returnTo, outcome } = await passes.finishSignIn(q.state, q.error ? null : (q.code ?? null));
      deps.metrics?.signIn(outcome);
      reply.header("cache-control", "no-store");
      if (!returnTo) return reply.status(400).type("text/plain; charset=utf-8").send("This sign-in expired. Go back to the site and connect X again.");
      const back = new URL(returnTo);
      back.searchParams.set("x", outcome);
      back.hash = "boarding";
      return reply.redirect(back.toString(), 303);
    });

    // The pass whose ?ref= link brought this one: once, before the X account is connected.
    app.post("/v1/xpass/referrer", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = z.object({ code: referral.min(1) }).parse(req.body);
      return passed(reply, () => passes.refer(passToken(req), body.code));
    });
    app.post("/v1/xpass/follow", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => passed(reply, () => passes.follow(passToken(req))));
    app.post("/v1/xpass/task", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = z.object({ task: z.enum(X_TASKS) }).parse(req.body);
      return passed(reply, () => passes.declare(passToken(req), body.task));
    });
    app.post("/v1/xpass/tweet", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = z.object({ url: z.string().min(1).max(300) }).parse(req.body);
      return passed(reply, () => passes.verifyTweet(passToken(req), body.url));
    });
    // A one-time code for `/board` on Discord: the bot ties the account that runs it to this pass.
    app.post("/v1/xpass/discord", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => passed(reply, () => passes.discordCode(passToken(req))));
    app.post("/v1/xpass/wallet", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = z.object({ address, message: z.string().min(1).max(1_000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(req.body);
      return passed(reply, () => passes.linkWallet(passToken(req), body.address, body.message, body.signature));
    });
    // Every pass, handles and linked wallets included: only for whoever holds the token.
    app.get("/v1/xpass/all", async (req, reply) => {
      const q = z.object({ token: z.string().optional() }).parse(req.query);
      reply.header("cache-control", "no-store");
      if (!xPasses.adminToken || q.token !== xPasses.adminToken) return reply.status(401).send({ error: "unauthorized" });
      return { data: (await passes.all()).map(({ id: _id, ...p }) => p) };
    });
  }

  // --- the suggestion box ---

  const ideas = deps.ideas;
  if (ideas) {
    app.post("/v1/ideas", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = z.object({ text: z.string().min(1).max(IDEA_MAX * 2), locale: z.string().max(8).default("en") }).parse(req.body);
      const h = req.headers.authorization;
      return send(reply, await ideas.box.submit(body.text, body.locale, h?.startsWith("Bearer ") ? h.slice(7) : ""), "no-store");
    });
    app.get("/v1/ideas/count", async (_req, reply) => send(reply, { received: await ideas.box.count() }, "public, max-age=30"));
    // Every idea: only for whoever holds the token.
    app.get("/v1/ideas", async (req, reply) => {
      const q = z.object({ token: z.string().optional() }).parse(req.query);
      reply.header("cache-control", "no-store");
      if (!ideas.adminToken || q.token !== ideas.adminToken) return reply.status(401).send({ error: "unauthorized" });
      return { data: await ideas.box.all() };
    });
  }

  app.get("/v1/me", async (req, reply) => {
    const who = bearer(req);
    return send(reply, await queries.account(who), "private, no-store");
  });

  // --- indexer ---

  /** The app calls this after a transaction is mined, so the index catches it within seconds. */
  app.post("/v1/sync/nudge", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (_req, reply) => {
    (deps.nudge ?? (() => deps.indexer?.nudge()))();
    return reply.status(202).send({ ok: true });
  });

  // --- relayer proxy (the Relayer SDK's relayerUrl is <this API>/relayer/v2) ---

  const relayer = deps.relayer;
  if (relayer) {
    const op = z.enum(["input-proof", "user-decrypt", "public-decrypt"]);
    const pass = (reply: FastifyReply, r: { status: number; body: unknown; retryAfter: string | null }) => {
      reply.header("cache-control", "no-store");
      if (r.retryAfter) reply.header("retry-after", r.retryAfter);
      return reply.status(r.status).send(r.body);
    };
    // In the relayer's own error shape, so the SDK reports it as it would one of Zama's.
    const refused = (reply: FastifyReply, e: RelayerRefused) =>
      reply
        .status(400)
        .header("cache-control", "no-store")
        .send({ status: "failed", requestId: "dno-gate", error: { label: "request_error", message: `dno:${e.code}: ${e.message}` } });
    const guarded = async (reply: FastifyReply, run: () => Promise<{ status: number; body: unknown; retryAfter: string | null }>) => {
      try {
        return pass(reply, await run());
      } catch (error) {
        if (error instanceof RelayerRefused) return refused(reply, error);
        throw error;
      }
    };

    app.get("/relayer/v2/keyurl", async (_req, reply) => guarded(reply, () => relayer.keyUrl()));

    app.post(
      "/relayer/v2/:op",
      // An encrypted input carries its proof: far bigger than the API's other bodies.
      { bodyLimit: 1024 * 1024, config: { rateLimit: { max: deps.relayerRatePerMinute ?? 60, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const p = z.object({ op }).parse(req.params);
        return guarded(reply, () => relayer.submit(p.op as RelayerOp, req.body, req.headers.authorization));
      },
    );

    // The SDK polls a queued job every second or two: not counted against the IP.
    app.get("/relayer/v2/:op/:jobId", { config: { rateLimit: false } }, async (req, reply) => {
      const p = z.object({ op, jobId: z.string() }).parse(req.params);
      return guarded(reply, () => relayer.poll(p.op as RelayerOp, p.jobId));
    });

    app.get("/v1/relayer/allowance/:address", async (req, reply) => {
      const p = z.object({ address }).parse(req.params);
      return send(reply, await relayer.allowance(p.address), "private, no-store");
    });
  }

  // --- the sealed vault's relayer ---

  // Asked by every vault page: null when there is none, so the page sends from the wallet.
  app.get("/v1/vault/relayer", async (_req, reply) => send(reply, { address: deps.vaultRelay?.address ?? null }, "public, max-age=60"));

  const vaultRelay = deps.vaultRelay;
  if (vaultRelay) {
    const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "hex").max(20_000);
    const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "32 bytes");
    const pocketSet = z.array(id).min(1).max(5);
    const spendInput = z.object({ amount: bytes32, target: bytes32, inputProof: hex, boundKey: bytes32, keyProof: hex });
    const uint = z.string().regex(/^\d{1,78}$/).transform(BigInt);
    const seconds = z.number().int().min(0).max(2 ** 48);
    const tick = z.number().int().min(-887272).max(887272);
    const positionRange = z.object({ token0: address, token1: address, fee: z.number().int().min(1).max(1_000_000), tickLower: tick, tickUpper: tick });
    const positionFunds = z.object({
      set0: pocketSet,
      set1: pocketSet,
      amount0: bytes32,
      amount1: bytes32,
      target0: bytes32,
      target1: bytes32,
      inputProof: hex,
      amount0Min: uint,
      amount1Min: uint,
      deadline: seconds,
    });
    const positionKeys = z.object({ boundKey0: bytes32, boundKey1: bytes32, keyProof: hex });
    const positionOut = z.object({ set0: pocketSet, set1: pocketSet, target0: bytes32, target1: bytes32, inputProof: hex });
    const body = z.discriminatedUnion("call", [
      z.object({
        call: z.literal("request"),
        args: z.object({
          boxId: id,
          action: z.number().int().min(0).max(5),
          to: address,
          price: z.string().regex(/^\d{1,78}$/).transform(BigInt),
          endTime: z.number().int().min(0).max(2 ** 48),
          // Only accepting an offer names one; older pages send none.
          ref: bytes32.default("0x" + "0".repeat(64)),
          handle: bytes32,
          inputProof: hex,
        }),
      }),
      z.object({ call: z.literal("finalize"), args: z.object({ requestId: id, cleartexts: hex, proof: hex, offer: hex.optional() }) }),
      // The pockets and their desk.
      // `pockets` names another token's pockets (cUSDT, cWETH, cZAMA); the cUSDC ones when left out.
      z.object({ call: z.literal("pocketOpen"), args: z.object({ handle: bytes32, inputProof: hex, viewer: address, pockets: address.optional() }) }),
      z.object({ call: z.literal("pocketSend"), args: z.object({ from: pocketSet, to: pocketSet, input: spendInput, pockets: address.optional() }) }),
      z.object({ call: z.literal("pocketWithdraw"), args: z.object({ from: pocketSet, to: address, input: spendInput, pockets: address.optional() }) }),
      z.object({ call: z.literal("deskAsk"), args: z.object({ saleId: id, handle: bytes32, keyProof: hex, boxKey: bytes32 }) }),
      z.object({ call: z.literal("deskBuy"), args: z.object({ askId: id, cleartexts: hex, proof: hex, boxKey: bytes32, boxKeyProof: hex }) }),
      // The liquidity positions: fundings bound to pocket keys, the rest signed by a position's controller.
      z.object({ call: z.literal("positionOpen"), args: z.object({ range: positionRange, controller: address, funds: positionFunds, keys: positionKeys }) }),
      z.object({ call: z.literal("positionAdd"), args: z.object({ positionId: id, funds: positionFunds, keys: positionKeys }) }),
      z.object({ call: z.literal("positionSettle"), args: z.object({ fundingId: id, clear0: uint, proof0: hex, clear1: uint, proof1: hex }) }),
      z.object({ call: z.literal("positionCollect"), args: z.object({ positionId: id, out: positionOut, deadline: seconds, signature: hex }) }),
      z.object({
        call: z.literal("positionDecrease"),
        args: z.object({ positionId: id, liquidity: uint, amount0Min: uint, amount1Min: uint, out: positionOut, deadline: seconds, signature: hex }),
      }),
      z.object({ call: z.literal("positionGive"), args: z.object({ positionId: id, to: address, deadline: seconds, signature: hex }) }),
      z.object({ call: z.literal("positionTakeOut"), args: z.object({ positionId: id, to: address, deadline: seconds, signature: hex }) }),
    ]);
    app.post(
      "/v1/vault/relay",
      // An encrypted input carries its proof: bigger than the API's other bodies.
      { bodyLimit: 64 * 1024, config: { rateLimit: { max: deps.vaultRelayRatePerMinute ?? 10, timeWindow: "1 minute" } } },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const parsed = body.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "bad request" });
        try {
          const d = parsed.data;
          const hash =
            d.call === "request"
              ? await vaultRelay.request(d.args)
              : d.call === "finalize"
                ? await vaultRelay.finalize(d.args)
                : await vaultRelay.pockets(d.call, d.args as never);
          return { hash };
        } catch (error) {
          if (error instanceof VaultRelayRefused) return reply.status(error.code === "daily-cap" ? 429 : 400).send({ error: error.message, code: error.code });
          throw error;
        }
      },
    );
  }

  // --- the studio ---

  const studio = deps.studio;
  if (studio) {
    const base = studio.publicUrl.replace(/\/$/, "");
    const fileUrl = (id: string, file: "image" | "model.glb") => `${base}/v1/studio/jobs/${id}/${file}`;
    const jobJson = (j: StudioJob) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      prompt: j.prompt,
      sketchId: j.sketchId,
      // A model's picture is its sketch's, finished before the model could start.
      imageUrl: j.kind === "model" && j.sketchId ? fileUrl(j.sketchId, "image") : j.status === "done" ? fileUrl(j.id, "image") : null,
      modelUrl: j.kind === "model" && j.status === "done" ? fileUrl(j.id, "model.glb") : null,
      error: j.error,
      createdAt: j.createdAt,
    });
    const STATUS: Record<StudioRefused["code"], number> = {
      "bad-prompt": 400,
      "refused-prompt": 403,
      "not-allowlisted": 403,
      "no-credits": 402,
      "studio-paused": 503,
      "not-found": 404,
    };
    const guarded = async <T>(reply: FastifyReply, run: () => Promise<T>) => {
      reply.header("cache-control", "private, no-store");
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof StudioRefused)) throw error;
        return reply.status(STATUS[error.code]).send({ error: error.code, message: error.message, ...(error.reason ? { reason: error.reason } : {}) });
      }
    };
    const jobId = z.object({ id: z.string().uuid() });
    const fetchFile = studio.fetch ?? fetch;

    app.get("/v1/studio", async (req, reply) => {
      // Signed in or not: a session only adds whether the wallet is on the testers' list.
      const h = req.headers.authorization;
      let who: Address | null = null;
      if (h?.startsWith("Bearer ")) {
        try {
          who = deps.signIn.whoIs(h.slice(7));
        } catch {
          who = null;
        }
      }
      // The answer depends on the token: no cache may hand the anonymous one to a signed-in call.
      reply.header("cache-control", who ? "private, no-store" : "public, max-age=30").header("vary", "authorization");
      return { ...(await studio.studio.info(who)), block: await queries.indexedBlock() };
    });

    app.get("/v1/studio/credits", async (req, reply) => {
      const who = bearer(req);
      return guarded(reply, async () => ({ ...(await studio.studio.credits(who)), block: await queries.indexedBlock() }));
    });

    app.post("/v1/studio/sketches", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const who = bearer(req);
      const body = z.object({ prompt: z.unknown() }).parse(req.body ?? {});
      return guarded(reply, async () => reply.status(202).send({ job: jobJson(await studio.studio.sketch(who, body.prompt)) }));
    });

    app.post("/v1/studio/models", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const who = bearer(req);
      const body = z.object({ sketchId: z.string().uuid() }).parse(req.body);
      return guarded(reply, async () => reply.status(202).send({ job: jobJson(await studio.studio.model(who, body.sketchId)) }));
    });

    app.get("/v1/studio/jobs", async (req, reply) => {
      const who = bearer(req);
      return guarded(reply, async () => ({ jobs: (await studio.studio.jobs(who)).map(jobJson) }));
    });

    app.get("/v1/studio/jobs/:id", async (req, reply) => {
      const who = bearer(req);
      const { id: jobIdValue } = jobId.parse(req.params);
      return guarded(reply, async () => ({ job: jobJson(await studio.studio.job(who, jobIdValue)) }));
    });

    // A finished job's files, from the service through this API: the browser never learns where
    // they are, and a page can draw them without the service's CORS. Ids are random: no sign-in.
    // Only https files on the service's own hosts are fetched, up to a size, and served as an
    // image or a mesh whatever the upstream says, never as something a browser would run.
    const fileHosts = studio.fileHosts ?? ["fal.media", "fal.run", "fal.ai"];
    const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
    // A model is shown up to 100 MB: Tripo's first meshes, before its face limit, weighed more than 40.
    const MAX_FILE_BYTES = { image: 10 * 1024 * 1024, model: 100 * 1024 * 1024 };
    const allowedFile = (raw: string) => {
      try {
        const u = new URL(raw);
        return u.protocol === "https:" && fileHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
      } catch {
        return false;
      }
    };
    const proxy = async (reply: FastifyReply, id: string, file: "image" | "model", fallbackType: string) => {
      const url = await studio.studio.fileOf(id, file);
      if (!url) return reply.status(404).send({ error: "not-found", message: "no such file" });
      if (!allowedFile(url)) return reply.status(502).send({ error: "upstream", message: "the file is not where the service keeps them" });
      const res = await fetchFile(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok || !res.body) return reply.status(502).send({ error: "upstream", message: "the file could not be fetched" });
      const max = MAX_FILE_BYTES[file];
      if (Number(res.headers.get("content-length") ?? 0) > max) return reply.status(502).send({ error: "upstream", message: "the file is too large" });
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > max) return reply.status(502).send({ error: "upstream", message: "the file is too large" });
        chunks.push(chunk);
      }
      const upstreamType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const type = file === "model" ? "model/gltf-binary" : IMAGE_TYPES.has(upstreamType) ? upstreamType : fallbackType;
      return reply
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .type(type)
        .send(Buffer.concat(chunks));
    };
    const fileRoute = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

    app.get("/v1/studio/jobs/:id/image", fileRoute, async (req, reply) => proxy(reply, jobId.parse(req.params).id, "image", "image/jpeg"));
    app.get("/v1/studio/jobs/:id/model.glb", fileRoute, async (req, reply) => proxy(reply, jobId.parse(req.params).id, "model", "model/gltf-binary"));
  }

  // --- the rats ---

  const rats = deps.rats;
  if (rats) {
    const RAT_STATUS: Record<RatRefused["code"], number> = {
      "not-found": 404,
      "not-adoptable": 400,
      "already-adopted": 409,
      "sold-out": 409,
      "wallet-limit": 409,
      "storage-failed": 503,
      "adopt-unavailable": 503,
    };
    const ratId = z.object({ id: z.coerce.number().int().min(1).max(2 ** 31 - 1) });

    app.get("/v1/rats", async (req, reply) => {
      const { owner } = z.object({ owner: address }).parse(req.query);
      reply.header("cache-control", PUBLIC_CACHE);
      return { rats: await rats.list(owner), block: await queries.indexedBlock() };
    });

    app.get("/v1/rats/supply", async (_req, reply) => {
      reply.header("cache-control", PUBLIC_CACHE);
      return { supply: await rats.supply(), block: await queries.indexedBlock() };
    });

    app.get("/v1/rats/:id", async (req, reply) => {
      const { id: ratIdValue } = ratId.parse(req.params);
      reply.header("cache-control", PUBLIC_CACHE);
      return { rat: await rats.get(ratIdValue), block: await queries.indexedBlock() };
    });

    // ERC-721 metadata, at the Rats contract's base URI.
    app.get("/rats/:id", async (req, reply) => {
      const { id: raw } = z.object({ id: z.string().regex(/^\d+(\.json)?$/) }).parse(req.params);
      reply.header("cache-control", "public, max-age=60");
      return rats.metadata(Number(raw.replace(".json", "")));
    });

    // An adopted AI rat's 3D model: kept by this API, not on Arweave. Immutable once saved.
    app.get("/rats/models/:file", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { file } = z.object({ file: z.string().regex(/^0x[0-9a-fA-F]{64}\.glb$/) }).parse(req.params);
      const glb = await rats.model(file.slice(0, -4).toLowerCase());
      return reply
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .type("model/gltf-binary")
        .send(Buffer.from(glb));
    });

    app.get("/rats/:id/image.svg", async (req, reply) => {
      const { id: ratIdValue } = ratId.parse(req.params);
      // A seed rat's picture never changes.
      reply.header("cache-control", "public, max-age=31536000, immutable").type("image/svg+xml");
      return rats.svg(ratIdValue);
    });

    app.post("/v1/studio/jobs/:id/adopt", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const who = bearer(req);
      const { id: job } = z.object({ id: z.string().uuid() }).parse(req.params);
      reply.header("cache-control", "private, no-store");
      try {
        return await rats.adopt(who, job);
      } catch (error) {
        if (!(error instanceof RatRefused)) throw error;
        return reply.status(RAT_STATUS[error.code]).send({ error: error.code, message: error.message });
      }
    });
  }

  // --- the manual's chatbot ---

  const chat = deps.chat;
  if (chat) {
    app.post("/v1/chat", { config: { rateLimit: { max: deps.chatRatePerMinute ?? 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { book, ...input } = askInput.parse(req.body);
      reply.header("cache-control", "no-store");
      const asked = book === "vault" ? deps.vaultChat : chat;
      if (!asked) return reply.status(404).send({ error: "not-found", message: "no chat for this book" });
      return { data: await asked.ask(input, req.ip) };
    });
  }

  const discord = deps.discord;
  if (discord) {
    // The signature covers the raw body, so this route reads it as text. Discord's own servers
    // call it: the signature is the gate, and the chat's daily limits count per Discord user.
    await app.register(async (scope) => {
      scope.removeContentTypeParser("application/json");
      scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
      scope.post("/v1/discord/interactions", { config: { rateLimit: false } }, async (req, reply) => {
        const signature = req.headers["x-signature-ed25519"];
        const timestamp = req.headers["x-signature-timestamp"];
        const raw = typeof req.body === "string" ? req.body : "";
        if (typeof signature !== "string" || typeof timestamp !== "string" || !signedByDiscord(discord.publicKey, signature, timestamp, raw)) {
          return reply.status(401).send({ error: "unauthorized" });
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return reply.status(400).send({ error: "bad-request", message: "not JSON" });
        }
        return discord.clerk.respond(body);
      });
    });
  }

  const herald = deps.herald;
  if (herald) {
    app.get("/v1/herald", async (req, reply) => {
      const q = z
        .object({ token: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), network: z.string().regex(/^[a-z]+$/).optional() })
        .parse(req.query);
      reply.header("cache-control", "no-store");
      if (herald.adminToken && q.token !== herald.adminToken) return reply.status(401).send({ error: "unauthorized" });
      return { data: await herald.posts.posts(q.limit, q.network) };
    });
  }

  // --- token metadata (point the contract's base URI at /metadata/) ---

  app.get("/metadata/:id", async (req, reply) => {
    const { id: raw } = z.object({ id: z.string().regex(/^\d+(\.json)?$/) }).parse(req.params);
    reply.header("cache-control", "public, max-age=60");
    return deps.metadata.json(Number(raw.replace(".json", "")));
  });

  app.get("/metadata/:id/image.svg", async (req, reply) => {
    const { id: tokenId } = z.object({ id }).parse(req.params);
    reply.header("cache-control", "public, max-age=60").type("image/svg+xml");
    return deps.metadata.svg(tokenId);
  });

  return app;
}

/**
 * What an indexer-only process (ROLE=indexer) answers: its health, for the proxy and Docker, and
 * its metrics, for Prometheus. Nothing public goes through it.
 */
export async function buildOpsServer(deps: Pick<HttpDeps, "queries" | "indexer" | "rpcStatus" | "metrics" | "logger">): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  if (deps.metrics) {
    const metrics = deps.metrics;
    app.get("/metrics", async (_req, reply) => {
      reply.header("content-type", metrics.contentType).header("cache-control", "no-store");
      return metrics.render();
    });
  }
  app.get("/health", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return { ok: true, block: await deps.queries.indexedBlock(), indexer: deps.indexer?.status() ?? null, rpc: deps.rpcStatus?.() ?? null };
  });
  return app;
}
