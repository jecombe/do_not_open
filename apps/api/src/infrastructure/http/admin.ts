import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Insights } from "../../application/insights";

/**
 * The team's admin site. Its domain (ADMIN_DOMAIN) is routed by the edge proxy to the API under
 * `/admin`; the public API's domain refuses that path. One password (ADMIN_PASSWORD) opens a
 * session held in a signed cookie: no table, every replica checks it alone, and changing the
 * password closes every session. Sign-in attempts are limited per IP.
 */
export interface AdminDeps {
  insights: Insights;
  password: string;
  /** The built admin app (apps/admin/dist): served at /admin. Absent: the routes only (local dev uses Vite). */
  staticDir?: string | null;
  /** Seconds a session lasts. */
  sessionSeconds?: number;
  now?: () => number;
  /** Told when someone signs in, fails to, or shows a wallet. */
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

const COOKIE = "dno_admin";

export class AdminSessions {
  private readonly key: Buffer;
  private readonly digest: Buffer;

  constructor(password: string) {
    if (password.length < 16) throw new Error("ADMIN_PASSWORD must be at least 16 characters");
    this.digest = createHash("sha256").update(password).digest();
    // The key hangs on the password: a new password and every session ends.
    this.key = createHmac("sha256", password).update("dno-admin-session").digest();
  }

  passwordMatches(given: string): boolean {
    return timingSafeEqual(createHash("sha256").update(given).digest(), this.digest);
  }

  issue(expiresAt: number): string {
    return `${expiresAt}.${this.mac(String(expiresAt))}`;
  }

  valid(token: string | undefined, now: number): boolean {
    if (!token) return false;
    const [exp, mac] = token.split(".");
    if (!exp || !mac || !/^\d+$/.test(exp)) return false;
    const expected = Buffer.from(this.mac(exp));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given) && Number(exp) > now;
  }

  private mac(payload: string) {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }
}

function cookieOf(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** Every file of the built app, read once: only these paths are ever served. */
function readTree(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(`/${relative(dir, path).split("\\").join("/")}`, readFileSync(path));
    }
  };
  walk(dir);
  return files;
}

// Nothing from elsewhere: the app's own scripts, styles and fonts only.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export async function registerAdmin(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const sessions = new AdminSessions(deps.password);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const ttl = deps.sessionSeconds ?? 7 * 86_400;

  const signedIn = (req: FastifyRequest) => sessions.valid(cookieOf(req, COOKIE), now());
  const setCookie = (req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) => {
    // Secure behind the proxy's HTTPS; a local run over plain HTTP keeps the cookie too.
    const secure = req.protocol === "https" ? "; Secure" : "";
    reply.header("set-cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
  };

  await app.register(async (admin) => {
    admin.addHook("onSend", async (_req, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-robots-tag", "noindex, nofollow");
    });
    // Everything but the session's own routes needs the cookie.
    admin.addHook("onRequest", async (req, reply) => {
      const path = req.url.split("?")[0]!;
      if (path === "/admin/api/session" || path === "/admin/api/login") return;
      if (signedIn(req)) return;
      return reply.status(401).send({ error: "unauthorized" });
    });

    admin.get("/session", async (req) => ({ signedIn: signedIn(req) }));

    admin.post("/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { password } = z.object({ password: z.string().max(512) }).parse(req.body);
      if (!sessions.passwordMatches(password)) {
        deps.log.warn({ ip: req.ip }, "admin: wrong password");
        return reply.status(401).send({ error: "unauthorized", message: "wrong password" });
      }
      setCookie(req, reply, sessions.issue(now() + ttl), ttl);
      deps.log.info({ ip: req.ip }, "admin: signed in");
      return { signedIn: true };
    });

    admin.post("/logout", async (req, reply) => {
      setCookie(req, reply, "", 0);
      return { signedIn: false };
    });

    admin.get("/dashboard", async (req) => {
      const { days } = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }).parse(req.query);
      return deps.insights.dashboard(days);
    });

    admin.get("/players", async () => deps.insights.players());

    admin.get("/players/:code/wallet", async (req) => {
      const { code } = z.object({ code: z.string().regex(/^DNO-[A-Z0-9]{6}$/) }).parse(req.params);
      const address = await deps.insights.walletOf(code);
      deps.log.info({ ip: req.ip, code }, "admin: wallet shown");
      return { address };
    });

    admin.get("/ideas", async () => deps.insights.ideas());
  }, { prefix: "/admin/api" });

  if (deps.staticDir && existsSync(deps.staticDir)) {
    const files = readTree(deps.staticDir);
    const index = files.get("/index.html");
    // The app itself, sign-in page included: what it shows comes from the routes above.
    app.get("/admin", async (_req, reply) => reply.redirect("/admin/"));
    app.get("/admin/*", { config: { rateLimit: false } }, async (req, reply) => {
      const path = `/${(req.params as { "*": string })["*"]}`;
      if (path.startsWith("/api/")) return reply.status(404).send({ error: "not-found" });
      const file = files.get(path);
      const body = file ?? (extname(path) ? null : index);
      if (!body) return reply.status(404).send({ error: "not-found" });
      const type = TYPES[extname(file ? path : "/index.html")] ?? "application/octet-stream";
      // Vite names each asset by its content: cached for good. The page itself never is.
      reply
        .header("content-type", type)
        .header("cache-control", path.startsWith("/assets/") && file ? "public, max-age=31536000, immutable" : "no-store")
        .header("content-security-policy", CSP)
        .header("x-frame-options", "DENY")
        .header("x-robots-tag", "noindex, nofollow");
      return reply.send(body);
    });
  }
}
