import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { askInput, type AskManual } from "../../application/askManual";
import { Unauthorized, type SignIn } from "../../application/auth";
import type { Metadata } from "../../application/metadata";
import { BadRequest, NotFound, type Queries } from "../../application/queries";
import { RelayerRefused, type RelayerGate, type RelayerOp } from "../../application/relayerGate";
import { normalizeAddress } from "../../domain/types";
import type { IndexerStatus } from "../Indexer";
import type { EndpointStatus } from "../chain/RpcPool";

export interface HttpDeps {
  queries: Queries;
  metadata: Metadata;
  signIn: SignIn;
  /** The relayer proxy. Absent: the app talks to Zama's relayer directly. */
  relayer?: RelayerGate;
  /** Relayer submissions per minute per IP. */
  relayerRatePerMinute?: number;
  /** The manual's chatbot. */
  chat?: AskManual;
  /** Chat questions per minute per IP. */
  chatRatePerMinute?: number;
  /** Absent when this process does not index (ROLE=api). */
  indexer?: { status(): IndexerStatus; nudge(): void };
  rpcStatus?: () => EndpointStatus[];
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

  app.get("/health", async (_req, reply) => {
    const block = await queries.indexedBlock();
    const indexer = deps.indexer?.status() ?? null;
    reply.header("cache-control", "no-store");
    return { ok: true, block, indexer, rpc: deps.rpcStatus?.() ?? null };
  });

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

  // --- duels ---

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

  app.get("/v1/me", async (req, reply) => {
    const who = bearer(req);
    return send(reply, await queries.account(who), "private, no-store");
  });

  // --- indexer ---

  /** The app calls this after a transaction is mined, so the index catches it within seconds. */
  app.post("/v1/sync/nudge", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (_req, reply) => {
    deps.indexer?.nudge();
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

  // --- the manual's chatbot ---

  const chat = deps.chat;
  if (chat) {
    app.post("/v1/chat", { config: { rateLimit: { max: deps.chatRatePerMinute ?? 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const input = askInput.parse(req.body);
      reply.header("cache-control", "no-store");
      return { data: await chat.ask(input, req.ip) };
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
