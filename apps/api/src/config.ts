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
  /** Values a wallet may decrypt for free each UTC day, before its credits are used. */
  RELAYER_FREE_PER_DAY: z.coerce.number().int().min(0).default(50),
  /** Most values one decryption may ask for. */
  RELAYER_MAX_HANDLES: z.coerce.number().int().positive().default(64),
  RELAYER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** How far back the ACL is read for a handle the index has not caught up with. */
  RELAYER_RECENT_BLOCKS: z.coerce.number().int().positive().default(64),
  /** Submissions per minute and IP (polling is not counted). */
  RELAYER_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  if (config.NODE_ENV === "production" && !config.SESSION_SECRET) throw new Error("SESSION_SECRET is required in production");
  if (config.NODE_ENV === "production" && !config.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
  return config;
}
