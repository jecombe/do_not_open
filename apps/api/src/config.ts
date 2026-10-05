import { z } from "zod";

/**
 * Free Sepolia endpoints that answer `eth_getLogs` without a key, checked on 2026-10-01. Their
 * limits differ (50 to 10,000+ blocks a call); the pool learns each one's. dRPC's free plan no
 * longer serves Sepolia; blockpi, omniatech and rpc.sepolia.org were down. A keyed endpoint
 * (Alchemy, Infura...) can be added to RPC_URLS: the pool spreads load and favours the fastest.
 */
export const FREE_SEPOLIA_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.gateway.tenderly.co",
  "https://sepolia.rpc.thirdweb.com",
  "https://1rpc.io/sepolia",
];

const list = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  /** "all" serves the API and runs the indexer; split them to scale the API alone. */
  ROLE: z.enum(["all", "api", "indexer"]).default("all"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Without it the index lives in memory and is rebuilt from the chain at each start. */
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).default(10),

  NETWORK: z.literal("sepolia").default("sepolia"),
  RPC_URLS: list.default(FREE_SEPOLIA_RPCS),
  RPC_RPS: z.coerce.number().positive().default(4),
  RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  RPC_MAX_LOG_RANGE: z.coerce.number().int().positive().default(10_000),
  /** Overrides the committed DoNotOpen address (and drops the economy, which belongs to it). */
  COLLECTION_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  START_BLOCK: z.coerce.number().int().min(0).optional(),
  CONFIRMATIONS: z.coerce.number().int().min(0).default(2),
  RESCAN_BLOCKS: z.coerce.number().int().min(0).default(8),
  MAX_BLOCKS_PER_PASS: z.coerce.number().int().positive().default(20_000),
  /** About one Sepolia block. */
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(12_000),
  MIN_PASS_GAP_MS: z.coerce.number().int().min(0).default(3_000),
  /** Re-reads final blocks from other endpoints than the first time, adds what was missed, drops what a reorg removed. */
  SWEEP_EVERY_MS: z.coerce.number().int().positive().default(5 * 60_000),
  SWEEP_MAX_BLOCKS: z.coerce.number().int().positive().default(5_000),
  /** Compares counters, open duels, pending requests and a slice of boxes with the contract. */
  RECONCILE_EVERY_MS: z.coerce.number().int().positive().default(10 * 60_000),
  RECONCILE_BOXES: z.coerce.number().int().min(0).default(200),
  ECONOMY_TTL_MS: z.coerce.number().int().positive().default(30_000),
  CLAIM_TTL_MS: z.coerce.number().int().positive().default(30_000),

  /** Browser origins allowed, comma-separated: the Vercel domains. `*` allows any. */
  CORS_ORIGINS: list.default(["*"]),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** The image this container runs (set by deploy/deploy.sh): its tag names the commit on `dno_info`. */
  API_IMAGE: z.string().optional(),
  /** Where this API is reached from outside, for metadata image links. */
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  /** Signs sign-in sessions. Required in production. */
  SESSION_SECRET: z.string().optional(),
  /** Shown in the sign-in message the wallet displays. */
  SIGN_IN_DOMAIN: z.string().default("donotopen"),
  TRUST_PROXY: z.stringbool().default(false),

  /** Zama's relayer, versioned. Defaults to the network's. */
  RELAYER_URL: z.string().url().optional(),
  /** The collection's key for Zama's hosted relayer: required on mainnet, unused on Sepolia. Never sent to browsers. */
  RELAYER_API_KEY: z.string().optional(),
  /** Free units a player gets each UTC day (a decrypted value is one, an input RELAYER_INPUT_UNITS), before its credits are used. */
  RELAYER_FREE_PER_DAY: z.coerce.number().int().min(0).default(25),
  /** Free values a day for a wallet the index has never seen act: one 10-id mint (5 + 10 + 1). */
  RELAYER_NEWCOMER_PER_DAY: z.coerce.number().int().min(0).default(16),
  /** Units an encrypted input costs: Zama's price for one over its price for a decryption. */
  RELAYER_INPUT_UNITS: z.coerce.number().int().min(0).default(5),
  /** Most values one decryption may ask for. */
  RELAYER_MAX_HANDLES: z.coerce.number().int().positive().default(64),
  /** Public decryptions sent to Zama that may name one handle. The same request is served from the cache. */
  RELAYER_PUBLIC_PER_HANDLE: z.coerce.number().int().positive().default(4),
  RELAYER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** How far back the ACL is read for a handle the index has not caught up with. */
  RELAYER_RECENT_BLOCKS: z.coerce.number().int().positive().default(64),
  /** Submissions per minute and IP (polling is not counted). */
  RELAYER_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),

  /** Google's Gemini API key, for the manual's chatbot. Without it the chat quotes the manual's paragraphs. Never sent to browsers. */
  GEMINI_API_KEY: z.string().optional(),
  /** Tried in order; one that is busy or over its quota hands over to the next. */
  GEMINI_MODELS: list.default(["gemini-flash-lite-latest", "gemini-flash-latest"]),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** Questions one IP may put to the model per UTC day; past it, the chat quotes the manual. */
  CHAT_PER_IP_PER_DAY: z.coerce.number().int().min(0).default(40),
  /** Questions the model may get per UTC day in all: keeps the free quota for the whole day. */
  CHAT_PER_DAY: z.coerce.number().int().min(0).default(1000),
  CHAT_RATE_PER_MINUTE: z.coerce.number().int().positive().default(10),

  /** The collection's Discord channel (the herald): how often it reads the new events. */
  HERALD_EVERY_MS: z.coerce.number().int().positive().default(60_000),
  /** UTC hour of the daily digest; -1 for none. */
  HERALD_DIGEST_HOUR_UTC: z.coerce.number().int().min(-1).max(23).default(18),
  /** UTC hour of the daily lesson on how the game works; -1 for none. */
  HERALD_LESSON_HOUR_UTC: z.coerce.number().int().min(-1).max(23).default(14),
  /** The manual page, e.g. https://<site>/docs: each lesson links to its section. Without it, no link. */
  HERALD_MANUAL_URL: z.string().url().optional(),
  /** A post still waiting after this long is dropped as old news. */
  HERALD_STALE_HOURS: z.coerce.number().positive().default(12),
  /** The app's page for a box, the id appended: linked from opening posts. Without it, no link. */
  HERALD_BOX_URL: z.string().url().optional(),
  /** How many claimants of the mainnet allow list get a place. */
  ALLOW_LIST_PLACES: z.coerce.number().int().min(0).default(500),
  /** Reads the whole allow list (GET /v1/allowlist?token=). Without it, nobody can. */
  ALLOW_LIST_ADMIN_TOKEN: z.string().min(16).optional(),
  /** Required to read GET /v1/herald when set. */
  HERALD_ADMIN_TOKEN: z.string().optional(),
  /** "off": nothing; "rehearse": posts are written and kept, never sent; "live": sent. */
  HERALD_DISCORD: z.enum(["off", "rehearse", "live"]).default("off"),
  /** The channel's webhook (channel settings → Integrations → Webhooks). A secret: whoever has it can post there. */
  DISCORD_WEBHOOK_URL: z.string().url().optional(),
  /** Discord has no small quota: every post goes out, a few minutes apart at most. */
  HERALD_DISCORD_MAX_PER_DAY: z.coerce.number().int().min(0).default(200),
  HERALD_DISCORD_MIN_GAP_MINUTES: z.coerce.number().int().min(0).default(0),
  /** Also post what happens under encryption (🔒 mints, shakes, pets, meals), beside the reveals (🔓). */
  HERALD_DISCORD_SEALED: z.stringbool().default(true),
  /**
   * Signs the token images stored on Arweave through Turbo. Any fresh Ethereum key: it needs no
   * funds (small files are free) and only shows who uploaded. Without it, images stay on the API.
   */
  ARWEAVE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "0x and 64 hex characters").optional(),
  ARWEAVE_UPLOAD_URL: z.string().url().default("https://upload.ardrive.io"),
  /**
   * Where the metadata links the stored images, the id appended. Turbo's own gateway serves an
   * upload at once; arweave.net only once it is bundled, and a marketplace would cache the miss.
   */
  ARWEAVE_GATEWAY: z.string().url().default("https://turbo-gateway.com"),
  /** Turbo's free size for one data item (100 KiB); a bigger image stays on the API. */
  ARWEAVE_FREE_BYTES: z.coerce.number().int().positive().default(100 * 1024),
  ARWEAVE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ARCHIVE_EVERY_MS: z.coerce.number().int().positive().default(60_000),
  /** Uploads a pass may make: new cats first, then the sealed boxes in token order. */
  ARCHIVE_PER_PASS: z.coerce.number().int().positive().default(30),

  /** fal.ai's key: pays the studio's picture and 3D services. Without it the studio draws nothing. Never sent to browsers. */
  FAL_KEY: z.string().optional(),
  /** fal model that draws a sketch from the styled prompt. */
  STUDIO_IMAGE_MODEL: z.string().default("fal-ai/flux/schnell"),
  /** fal model that turns a sketch into a GLB mesh. */
  STUDIO_3D_MODEL: z.string().default("tripo3d/h3.1/image-to-3d"),
  /** Background remover run on a sketch before it is turned into 3D; "none" skips it. */
  STUDIO_CUTOUT_MODEL: z.string().default("fal-ai/birefnet"),
  /** Estimated dollars the studio may spend on the services per UTC day, every account together; past it, generation waits for the next day. */
  STUDIO_DAILY_BUDGET_USD: z.coerce.number().min(0).default(20),
  /** Comma-separated addresses: when set, only they may generate (a test network, where packs are paid in test USDC). */
  STUDIO_ALLOWLIST: list.optional(),
  /** "true" closes the studio without redeploying: packs bought wait. */
  STUDIO_PAUSED: z.stringbool().default(false),
  /** Failed generations an account gets its unit back for per UTC day; past it a failure keeps its unit. */
  STUDIO_REFUNDS_PER_DAY: z.coerce.number().int().min(0).default(3),
  /** One generation may take this long, queue included. */
  STUDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60_000),

  /**
   * The Rats contract's attester: signs the adoption of AI rats once their files are on Arweave.
   * Its address is RATS_ATTESTER at deployment. Without it, only seed rats can be adopted.
   */
  RATS_ATTESTER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "0x and 64 hex characters").optional(),
  /** The site, e.g. https://do-not-open.app: rats' metadata links its studio. */
  SITE_URL: z.string().url().optional(),

  /** The Discord application behind `/ask` (Developer Portal → General Information): its id and public key. Both set: the command is served. */
  DISCORD_APPLICATION_ID: z.string().optional(),
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "64 hex characters").optional(),
  /** The manual page `/ask` links its sections to, e.g. https://<site>/docs. Defaults to HERALD_MANUAL_URL. */
  DISCORD_MANUAL_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  if (config.NODE_ENV === "production" && !config.SESSION_SECRET) throw new Error("SESSION_SECRET is required in production");
  if (config.NODE_ENV === "production" && !config.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
  return config;
}
