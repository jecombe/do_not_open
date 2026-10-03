import { randomBytes } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { AskManual, type AnswerModel } from "./application/askManual";
import { SignIn } from "./application/auth";
import { AcceptTerms } from "./application/terms";
import type { Store } from "./application/ports/store";
import { Metadata } from "./application/metadata";
import { Queries } from "./application/queries";
import { RelayerGate } from "./application/relayerGate";
import { FinalitySweep } from "./application/finalitySweep";
import { Herald } from "./application/herald";
import { LessonWriter } from "./application/lesson";
import type { PostStore, SocialNetwork } from "./application/ports/herald";
import { Reconciler } from "./application/reconcile";
import { SyncChain } from "./application/syncChain";
import { loadConfig } from "./config";
import { ethersVerifier, HmacSessions, randomNonce } from "./infrastructure/auth/crypto";
import { GeminiModel } from "./infrastructure/chat/GeminiModel";
import manual from "./infrastructure/chat/manual.json";
import { AclPublications } from "./infrastructure/chain/AclPublications";
import { deploymentFor } from "./infrastructure/chain/deployment";
import { EvmChainSource } from "./infrastructure/chain/EvmChainSource";
import { EvmChainState } from "./infrastructure/chain/EvmChainState";
import { RpcPool } from "./infrastructure/chain/RpcPool";
import { migrate } from "./infrastructure/db/migrate";
import { PgStore } from "./infrastructure/db/PgStore";
import { buildServer } from "./infrastructure/http/server";
import { Indexer, type PeriodicTask } from "./infrastructure/Indexer";
import { MemoryStore } from "./infrastructure/memory/MemoryStore";
import { HttpRelayerUpstream } from "./infrastructure/relayer/HttpRelayerUpstream";
import { RehearsalNetwork } from "./infrastructure/social/RehearsalNetwork";
import { XNetwork } from "./infrastructure/social/XNetwork";
import { eip712PermitVerifier } from "./infrastructure/relayer/permit";

/** The composition root: the one place that knows every concrete class. */
async function main() {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });

  let pool: pg.Pool | null = null;
  let store: Store & PostStore;
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

  // Gemini, on its free tier: answers the manual's chat and words the herald's daily lesson.
  const model = config.GEMINI_API_KEY ? new GeminiModel({ apiKey: config.GEMINI_API_KEY, models: config.GEMINI_MODELS, timeoutMs: config.GEMINI_TIMEOUT_MS, log }) : null;

  let indexer: Indexer | undefined;
  if (config.ROLE !== "api") {
    const source = new EvmChainSource(rpc, deployment, log);
    const startBlock = deployment.indexFrom;
    const sync = new SyncChain(source, store, {
      startBlock,
      confirmations: config.CONFIRMATIONS,
      rescan: config.RESCAN_BLOCKS,
      maxBlocksPerPass: config.MAX_BLOCKS_PER_PASS,
    }, log);
    const sweep = new FinalitySweep(source, store, { startBlock, maxBlocks: config.SWEEP_MAX_BLOCKS }, log);
    const reconciler = new Reconciler(source, chainState, store, { startBlock, boxesPerRun: config.RECONCILE_BOXES }, log);
    const tasks: PeriodicTask[] = [
      { name: "finalitySweep", everyMs: config.SWEEP_EVERY_MS, run: () => sweep.run() },
      { name: "reconcile", everyMs: config.RECONCILE_EVERY_MS, run: () => reconciler.run() },
    ];
    const herald = heraldOf(config, store, model, log);
    if (herald) tasks.push({ name: "herald", everyMs: config.HERALD_EVERY_MS, run: () => herald.run() });
    indexer = new Indexer(sync, { pollMs: config.POLL_INTERVAL_MS, minGapMs: config.MIN_PASS_GAP_MS, maxBackoffMs: 5 * 60_000 }, log, undefined, undefined, tasks);
    indexer.start();
    log.info({ network: config.NETWORK, from: deployment.indexFrom, endpoints: rpc.status().map((e) => e.name) }, "indexer started");
  }

  const secret = config.SESSION_SECRET ?? randomBytes(32).toString("hex");
  if (!config.SESSION_SECRET) log.warn("SESSION_SECRET is not set: sessions end when the process restarts");
  const signIn = new SignIn(store, ethersVerifier, new HmacSessions(secret), { now: () => Math.floor(Date.now() / 1000) }, config.SIGN_IN_DOMAIN, randomNonce);

  const clock = { now: () => Math.floor(Date.now() / 1000) };
  const relayer = new RelayerGate(
    store,
    new HttpRelayerUpstream(config.RELAYER_URL ?? deployment.fhevm.relayerUrl, config.RELAYER_API_KEY, config.RELAYER_TIMEOUT_MS),
    eip712PermitVerifier({ chainId: deployment.chainId, verifyingContract: deployment.fhevm.verifyingContractDecryption }),
    new AclPublications(rpc, deployment, config.RELAYER_RECENT_BLOCKS),
    clock,
    { chainId: deployment.chainId, contracts: () => chainState.decryptable(), freePerDay: config.RELAYER_FREE_PER_DAY,
      newcomerPerDay: config.RELAYER_NEWCOMER_PER_DAY,
      inputUnits: config.RELAYER_INPUT_UNITS,
      maxHandles: config.RELAYER_MAX_HANDLES, clockSkew: 600, publicPerHandle: config.RELAYER_PUBLIC_PER_HANDLE },
  );
  if (!config.RELAYER_API_KEY) log.info("RELAYER_API_KEY is not set: the relayer proxy forwards without a key (fine on Sepolia, refused on mainnet)");

  // The manual's chatbot: Gemini answers from the whole manual; without a key, or past the
  // day's quota, the chat quotes the manual's best paragraphs.
  const chat = new AskManual(
    manual.locales,
    model,
    { perIpPerDay: config.CHAT_PER_IP_PER_DAY, perDay: config.CHAT_PER_DAY, cacheSize: 500 },
  );
  if (!config.GEMINI_API_KEY) log.info("GEMINI_API_KEY is not set: the chat quotes the manual instead of answering");

  const server =
    config.ROLE === "indexer"
      ? null
      : await buildServer({
          queries,
          metadata: new Metadata(queries, config.PUBLIC_URL.replace(/\/$/, "")),
          signIn,
          terms: new AcceptTerms(store, ethersVerifier, clock),
          relayer,
          relayerRatePerMinute: config.RELAYER_RATE_PER_MINUTE,
          chat,
          chatRatePerMinute: config.CHAT_RATE_PER_MINUTE,
          herald: config.HERALD === "off" ? undefined : { posts: store, adminToken: config.HERALD_ADMIN_TOKEN ?? null },
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

/** The collection's account: sent to X with its keys, rehearsed without them. */
function heraldOf(config: ReturnType<typeof loadConfig>, store: Store & PostStore, model: AnswerModel | null, log: pino.Logger): Herald | null {
  if (config.HERALD === "off") return null;
  let network: SocialNetwork = new RehearsalNetwork(log);
  if (config.HERALD === "x") {
    const { X_API_KEY: apiKey, X_API_SECRET: apiSecret, X_ACCESS_TOKEN: accessToken, X_ACCESS_SECRET: accessSecret } = config;
    if (apiKey && apiSecret && accessToken && accessSecret) network = new XNetwork({ apiKey, apiSecret, accessToken, accessSecret }, config.X_HANDLE ?? null);
    else log.warn("HERALD=x but the X keys are not all set: rehearsing instead");
  }
  log.info({ network: network.name }, "herald on");
  return new Herald(store, network, {
    maxPerDay: config.HERALD_MAX_PER_DAY,
    minGapSeconds: config.HERALD_MIN_GAP_MINUTES * 60,
    digestHourUtc: config.HERALD_DIGEST_HOUR_UTC < 0 ? null : config.HERALD_DIGEST_HOUR_UTC,
    // The lessons teach the players' manual in English, the account's language.
    lesson: config.HERALD_LESSON_HOUR_UTC < 0 ? null : {
      hourUtc: config.HERALD_LESSON_HOUR_UTC,
      writer: new LessonWriter(manual.locales.en, model, { manualUrl: config.HERALD_MANUAL_URL ?? null, tries: 2 }, log),
    },
    staleAfterSeconds: config.HERALD_STALE_HOURS * 3600,
    boxUrl: config.HERALD_BOX_URL ?? null,
    batch: 500,
    maxAttempts: 3,
  }, log);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
