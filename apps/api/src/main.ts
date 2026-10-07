import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import pino from "pino";
import { AskManual, type AnswerModel } from "./application/askManual";
import { SignIn } from "./application/auth";
import { AcceptTerms } from "./application/terms";
import { AllowList } from "./application/allowList";
import { Seats } from "./application/seats";
import { GiftProofs } from "./application/whitelistGifts";
import { Ideas } from "./application/ideas";
import { DISCORD_BONUS, X_TASKS, xPassBonuses, XPasses, type DiscordBoarding } from "./application/xPass";
import type { Store } from "./application/ports/store";
import { ArchiveImages, ImageArchive } from "./application/archive";
import type { ArchiveStore } from "./application/ports/archive";
import { Metadata } from "./application/metadata";
import type { StudioStore } from "./application/ports/studio";
import { Studio } from "./application/studio";
import { Queries } from "./application/queries";
import { RelayerGate } from "./application/relayerGate";
import { FinalitySweep } from "./application/finalitySweep";
import { Herald } from "./application/herald";
import { LessonWriter } from "./application/lesson";
import type { PostStore, SocialNetwork } from "./application/ports/herald";
import { Reconciler } from "./application/reconcile";
import { SyncChain } from "./application/syncChain";
import { loadConfig } from "./config";
import { ethersVerifier, HmacSessions, loginSecrets, passSecrets, randomNonce } from "./infrastructure/auth/crypto";
import { OEmbedTweets } from "./infrastructure/x/OEmbedTweets";
import { XOAuth } from "./infrastructure/x/XOAuth";
import { GeminiModel } from "./infrastructure/chat/GeminiModel";
import manual from "./infrastructure/chat/manual.json";
import { AclPublications } from "./infrastructure/chain/AclPublications";
import { deploymentFor } from "./infrastructure/chain/deployment";
import { EvmChainSource } from "./infrastructure/chain/EvmChainSource";
import { EvmChainState } from "./infrastructure/chain/EvmChainState";
import { RpcPool } from "./infrastructure/chain/RpcPool";
import { migrate } from "./infrastructure/db/migrate";
import { PgStore } from "./infrastructure/db/PgStore";
import { listenForNudges, nudgeOver } from "./infrastructure/db/nudges";
import { buildOpsServer, buildServer } from "./infrastructure/http/server";
import { Indexer, type PeriodicTask } from "./infrastructure/Indexer";
import { MemoryStore } from "./infrastructure/memory/MemoryStore";
import { HttpRelayerUpstream } from "./infrastructure/relayer/HttpRelayerUpstream";
import { DiscordClerk } from "./infrastructure/discord/DiscordClerk";
import { DiscordNetwork } from "./infrastructure/social/DiscordNetwork";
import { RehearsalNetwork } from "./infrastructure/social/RehearsalNetwork";
import { eip712PermitVerifier } from "./infrastructure/relayer/permit";
import { TurboStorage } from "./infrastructure/archive/TurboStorage";
import { Metrics } from "./infrastructure/http/metrics";
import { FalStudio } from "./infrastructure/studio/FalStudio";
import { Rats } from "./application/rats";
import type { RatStore } from "./application/ports/rats";
import { JpegShrinker } from "./infrastructure/rats/JpegShrinker";
import { EthersAdoptionSigner } from "./infrastructure/rats/EthersAdoptionSigner";
import { ServiceFileFetcher } from "./infrastructure/rats/ServiceFileFetcher";

/** The composition root: the one place that knows every concrete class. */
async function main() {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });

  let pool: pg.Pool | null = null;
  let store: Store & PostStore & ArchiveStore & StudioStore & RatStore;
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
  let stopListening: (() => Promise<void>) | undefined;
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
    for (const herald of heraldsOf(config, store, model, log)) tasks.push({ name: `herald:${herald.channel}`, everyMs: config.HERALD_EVERY_MS, run: () => herald.run() });
    // The token images, stored for good on Arweave (free under Turbo's size limit).
    if (config.ARWEAVE_KEY) {
      const storage = new TurboStorage({ privateKey: config.ARWEAVE_KEY, uploadUrl: config.ARWEAVE_UPLOAD_URL, maxBytes: config.ARWEAVE_FREE_BYTES, timeoutMs: config.ARWEAVE_TIMEOUT_MS, appName: "DoNotOpen" });
      const archiver = new ArchiveImages(store, store, storage, config.ARCHIVE_PER_PASS, log);
      tasks.push({ name: "archiveImages", everyMs: config.ARCHIVE_EVERY_MS, run: () => archiver.run() });
    } else log.info("ARWEAVE_KEY is not set: token images are served by the API only");
    indexer = new Indexer(sync, { pollMs: config.POLL_INTERVAL_MS, minGapMs: config.MIN_PASS_GAP_MS, maxBackoffMs: 5 * 60_000 }, log, undefined, undefined, tasks);
    indexer.start();
    // API replicas (ROLE=api) nudge it over Postgres after a transaction is mined.
    if (config.DATABASE_URL) {
      const running = indexer;
      stopListening = listenForNudges(config.DATABASE_URL, () => running.nudge(), log);
    }
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
    Date.now,
    // The day's total is counted in the store, for every replica together.
    {
      take: (day, limit) => store.takeQuota("chat-model", day, limit),
      giveBack: (day) => store.giveBackQuota("chat-model", day),
      used: (day) => store.quotaUsed("chat-model", day),
    },
  );
  if (!config.GEMINI_API_KEY) log.info("GEMINI_API_KEY is not set: the chat quotes the manual instead of answering");

  // The same clerk on Discord, as `/ask`.
  const discord =
    config.DISCORD_APPLICATION_ID && config.DISCORD_PUBLIC_KEY
      ? {
          clerk: new DiscordClerk(
            chat,
            {
              applicationId: config.DISCORD_APPLICATION_ID,
              manualUrl: config.DISCORD_MANUAL_URL ?? config.HERALD_MANUAL_URL ?? null,
              // `/board`: the passes are made further down, before any request comes in.
              boarding: config.DISCORD_GUILD_ID ? { joinDiscord: (code: string, member: { userId: string; guildId: string | null }): Promise<DiscordBoarding> => xPasses.joinDiscord(code, member), bonus: DISCORD_BONUS } : undefined,
            },
            log,
          ),
          publicKey: config.DISCORD_PUBLIC_KEY,
        }
      : undefined;

  // The studio: cats drawn by fal.ai out of packs bought on-chain. It needs the key and the
  // StudioPacks contract; without either it reports itself disabled.
  const fal = new FalStudio({ apiKey: config.FAL_KEY ?? "", imageModel: config.STUDIO_IMAGE_MODEL, modelModel: config.STUDIO_3D_MODEL, cutoutModel: config.STUDIO_CUTOUT_MODEL === "none" ? null : config.STUDIO_CUTOUT_MODEL, timeoutMs: config.STUDIO_TIMEOUT_MS });
  const studio = new Studio(
    store,
    fal,
    fal,
    clock,
    {
      enabled: !!config.FAL_KEY && !!deployment.studio,
      paused: config.STUDIO_PAUSED,
      dailyBudgetUsd: config.STUDIO_DAILY_BUDGET_USD,
      allowlist: config.STUDIO_ALLOWLIST?.length ? new Set(config.STUDIO_ALLOWLIST.map((a) => a.toLowerCase())) : null,
      staleAfter: Math.ceil(config.STUDIO_TIMEOUT_MS / 1000) * 2,
      refundsPerDay: config.STUDIO_REFUNDS_PER_DAY,
      newId: randomUUID,
    },
    log,
  );
  await studio.recover();
  if (!deployment.studio) log.info("no StudioPacks contract on this network: the studio is off");
  else if (!config.FAL_KEY) log.info("FAL_KEY is not set: the studio is off");

  // The depot's rats: read back from the index; an AI rat adopted once its picture is on Arweave
  // (a free upload, like the cats') and its model kept here, with the attester's signature.
  const publicUrl = config.PUBLIC_URL.replace(/\/$/, "");
  const rats = new Rats(
    store,
    store,
    config.ARWEAVE_KEY
      ? new TurboStorage({ privateKey: config.ARWEAVE_KEY, uploadUrl: config.ARWEAVE_UPLOAD_URL, maxBytes: config.ARWEAVE_FREE_BYTES, timeoutMs: config.ARWEAVE_TIMEOUT_MS, appName: "DoNotOpen" })
      : null,
    new ServiceFileFetcher(),
    new JpegShrinker(),
    config.RATS_ATTESTER_KEY && deployment.rats ? new EthersAdoptionSigner(config.RATS_ATTESTER_KEY, { chainId: deployment.chainId, verifyingContract: deployment.rats.address }) : null,
    clock,
    {
      publicUrl,
      gateway: config.ARWEAVE_GATEWAY.replace(/\/$/, ""),
      studioUrl: config.SITE_URL ? `${config.SITE_URL.replace(/\/$/, "")}/studio` : null,
      ticketTtl: 30 * 60,
      maxImageBytes: 10 * 1024 * 1024,
      // Tripo's first meshes, before its face limit, weighed just over 40 MB: they stay adoptable.
      maxModelBytes: 50 * 1024 * 1024,
    },
    log,
  );
  if (!deployment.rats) log.info("no Rats contract on this network: no rat to show, none to adopt");
  else if (!config.RATS_ATTESTER_KEY) log.info("RATS_ATTESTER_KEY is not set: only seed rats can be adopted");

  // The list and its seats read each other: the seats count who tried the testnet, the list
  // admits a new claimant to a seat.
  let allowList: AllowList | null = null;
  const seats = new Seats(store, config.ALLOW_LIST_PLACES, () => allowList!.players(), config.X_ANNOUNCEMENT_ID ? X_TASKS : ["follow", "post"]);
  allowList = new AllowList(store, ethersVerifier, clock, config.ALLOW_LIST_PLACES, () => xPassBonuses(store), seats);
  // The frozen list, once it closed: each wallet's proof for WhitelistGifts.
  const gifts = new GiftProofs(config.WHITELIST_GIFTS_TREE ? JSON.parse(readFileSync(config.WHITELIST_GIFTS_TREE, "utf8")) : null);
  if (gifts.frozen) log.info({ root: gifts.root, wallets: gifts.count }, "whitelist gifts: tree loaded");

  const xPasses = new XPasses(
    store,
    new OEmbedTweets(),
    passSecrets,
    ethersVerifier,
    clock,
    config.X_CLIENT_ID
      ? {
          x: new XOAuth({ clientId: config.X_CLIENT_ID, clientSecret: config.X_CLIENT_SECRET, redirectUri: `${config.PUBLIC_URL.replace(/\/$/, "")}/v1/xpass/x/callback` }),
          secrets: loginSecrets,
        }
      : null,
    seats,
    config.DISCORD_APPLICATION_ID && config.DISCORD_PUBLIC_KEY && config.DISCORD_GUILD_ID ? { guildId: config.DISCORD_GUILD_ID } : null,
  );

  // What the index holds is reported by one process only, the one that indexes: API replicas
  // report their own traffic, memory and RPC calls.
  const reports = config.ROLE !== "api";
  const metrics = new Metrics({
    ...(reports && {
      store,
      whitelist: { seats, store, signInEnabled: xPasses.signInEnabled },
      archive: store,
      posts: store,
      chat,
      studio: {
        store,
        spentToday: () => studio.spentToday(),
        spentTotal: () => studio.spentTotal(),
        dailyBudgetUsd: config.STUDIO_DAILY_BUDGET_USD,
        open: !!config.FAL_KEY && !!deployment.studio && !config.STUDIO_PAUSED,
      },
      rats: store,
    }),
    indexer,
    rpcStatus: () => rpc.status(),
    info: { chain: config.NETWORK, collection: deployment.collection.address, version: config.API_IMAGE?.split(":").pop() ?? "dev", role: config.ROLE },
  });


  const server =
    config.ROLE === "indexer"
      ? await buildOpsServer({ queries, indexer, rpcStatus: () => rpc.status(), metrics, logger: { level: config.LOG_LEVEL } })
      : await buildServer({
          queries,
          metadata: new Metadata(queries, config.PUBLIC_URL.replace(/\/$/, ""), new ImageArchive(store, config.ARWEAVE_GATEWAY.replace(/\/$/, ""))),
          signIn,
          terms: new AcceptTerms(store, ethersVerifier, clock),
          allowList: { list: allowList, adminToken: config.ALLOW_LIST_ADMIN_TOKEN ?? null, seats, gifts },
          xPasses: { passes: xPasses, adminToken: config.ALLOW_LIST_ADMIN_TOKEN ?? null, returnOrigins: config.X_RETURN_ORIGINS, announcement: config.X_ANNOUNCEMENT_ID ?? null },
          ideas: { box: new Ideas(store, clock, (token) => xPasses.handleOf(token)), adminToken: config.ALLOW_LIST_ADMIN_TOKEN ?? null },
          relayer,
          relayerRatePerMinute: config.RELAYER_RATE_PER_MINUTE,
          studio: { studio, publicUrl: config.PUBLIC_URL },
          rats,
          chat,
          chatRatePerMinute: config.CHAT_RATE_PER_MINUTE,
          discord,
          herald: config.HERALD_DISCORD === "off" ? undefined : { posts: store, adminToken: config.HERALD_ADMIN_TOKEN ?? null },
          indexer,
          nudge: config.ROLE === "api" && pool ? nudgeOver(pool, log) : undefined,
          rpcStatus: () => rpc.status(),
          metrics,
          corsOrigins: config.CORS_ORIGINS,
          rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
          logger: { level: config.LOG_LEVEL },
          trustProxy: config.TRUST_PROXY,
        });
  await server.listen({ host: config.HOST, port: config.PORT });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    // In-flight requests finish first: a replica taken out by a deploy drops nothing it accepted.
    await server.close();
    await stopListening?.();
    await indexer?.stop();
    await pool?.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * The collection's accounts, one herald each: the Discord channel, sent through its webhook and
 * rehearsed without it. Each keeps its own queue and quota.
 */
function heraldsOf(config: ReturnType<typeof loadConfig>, store: Store & PostStore, model: AnswerModel | null, log: pino.Logger): Herald[] {
  // The lessons teach the players' manual in English, the accounts' language; each account gets its own wording.
  const lesson = () =>
    config.HERALD_LESSON_HOUR_UTC < 0 ? null : {
      hourUtc: config.HERALD_LESSON_HOUR_UTC,
      writer: new LessonWriter(manual.locales.en, model, { manualUrl: config.HERALD_MANUAL_URL ?? null, tries: 2 }, log),
    };
  const common = {
    digestHourUtc: config.HERALD_DIGEST_HOUR_UTC < 0 ? null : config.HERALD_DIGEST_HOUR_UTC,
    staleAfterSeconds: config.HERALD_STALE_HOURS * 3600,
    boxUrl: config.HERALD_BOX_URL ?? null,
    batch: 500,
    maxAttempts: 3,
  };
  const heralds: Herald[] = [];

  if (config.HERALD_DISCORD !== "off") {
    let network: SocialNetwork = new RehearsalNetwork(log);
    if (config.HERALD_DISCORD === "live") {
      if (config.DISCORD_WEBHOOK_URL) network = new DiscordNetwork(config.DISCORD_WEBHOOK_URL);
      else log.warn("HERALD_DISCORD=live but DISCORD_WEBHOOK_URL is not set: rehearsing instead");
    }
    heralds.push(new Herald(store, network, { ...common, channel: "discord", sealed: config.HERALD_DISCORD_SEALED, maxPerDay: config.HERALD_DISCORD_MAX_PER_DAY, minGapSeconds: config.HERALD_DISCORD_MIN_GAP_MINUTES * 60, lesson: lesson() }, log));
    log.info({ channel: "discord", network: network.name }, "herald on");
  }
  return heralds;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
