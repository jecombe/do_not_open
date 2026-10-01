import { randomBytes } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { SignIn } from "./application/auth";
import type { Store } from "./application/ports/store";
import { Metadata } from "./application/metadata";
import { Queries } from "./application/queries";
import { SyncChain } from "./application/syncChain";
import { loadConfig } from "./config";
import { ethersVerifier, HmacSessions, randomNonce } from "./infrastructure/auth/crypto";
import { deploymentFor } from "./infrastructure/chain/deployment";
import { EvmChainSource } from "./infrastructure/chain/EvmChainSource";
import { EvmChainState } from "./infrastructure/chain/EvmChainState";
import { RpcPool } from "./infrastructure/chain/RpcPool";
import { migrate } from "./infrastructure/db/migrate";
import { PgStore } from "./infrastructure/db/PgStore";
import { buildServer } from "./infrastructure/http/server";
import { Indexer } from "./infrastructure/Indexer";
import { MemoryStore } from "./infrastructure/memory/MemoryStore";

/** The composition root: the one place that knows every concrete class. */
async function main() {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });

  let pool: pg.Pool | null = null;
  let store: Store;
  if (config.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_SIZE });
    await migrate(pool, log);
    store = new PgStore(pool);
  } else {
    log.warn("DATABASE_URL is not set: the index lives in memory and is rebuilt at each start");
    store = new MemoryStore();
  }

  const deployment = deploymentFor(config.NETWORK, { address: config.COLLECTION_ADDRESS, startBlock: config.START_BLOCK });
  const rpc = new RpcPool({ urls: config.RPC_URLS, rps: config.RPC_RPS, timeoutMs: config.RPC_TIMEOUT_MS, maxLogRange: config.RPC_MAX_LOG_RANGE, log });
  const chainState = new EvmChainState(rpc, deployment, { economyTtlMs: config.ECONOMY_TTL_MS, claimTtlMs: config.CLAIM_TTL_MS });
  const queries = new Queries(store, chainState);

  let indexer: Indexer | undefined;
  if (config.ROLE !== "api") {
    const sync = new SyncChain(new EvmChainSource(rpc, deployment, log), store, {
      startBlock: deployment.collection.deployBlock,
      confirmations: config.CONFIRMATIONS,
      rescan: config.RESCAN_BLOCKS,
      maxBlocksPerPass: config.MAX_BLOCKS_PER_PASS,
    }, log);
    indexer = new Indexer(sync, { pollMs: config.POLL_INTERVAL_MS, minGapMs: config.MIN_PASS_GAP_MS, maxBackoffMs: 5 * 60_000 }, log);
    indexer.start();
    log.info({ network: config.NETWORK, from: deployment.collection.deployBlock, endpoints: rpc.status().map((e) => e.name) }, "indexer started");
  }

  const secret = config.SESSION_SECRET ?? randomBytes(32).toString("hex");
  if (!config.SESSION_SECRET) log.warn("SESSION_SECRET is not set: sessions end when the process restarts");
  const signIn = new SignIn(store, ethersVerifier, new HmacSessions(secret), { now: () => Math.floor(Date.now() / 1000) }, config.SIGN_IN_DOMAIN, randomNonce);

  const server =
    config.ROLE === "indexer"
      ? null
      : await buildServer({
          queries,
          metadata: new Metadata(queries, config.PUBLIC_URL.replace(/\/$/, "")),
          signIn,
          indexer,
          rpcStatus: () => rpc.status(),
          corsOrigins: config.CORS_ORIGINS,
          rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
          logger: { level: config.LOG_LEVEL },
          trustProxy: config.TRUST_PROXY,
        });
  if (server) await server.listen({ host: config.HOST, port: config.PORT });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await server?.close();
    await indexer?.stop();
    await pool?.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
