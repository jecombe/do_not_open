import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { AskManual } from "../../application/askManual";
import type { ArchiveStore } from "../../application/ports/archive";
import type { PostStore } from "../../application/ports/herald";
import type { ReadStore } from "../../application/ports/store";
import type { StudioStore } from "../../application/ports/studio";
import type { RatStore } from "../../application/ports/rats";
import type { EndpointStatus } from "../chain/RpcPool";
import type { IndexerStatus } from "../Indexer";
import type { SeatsView } from "../../application/seats";
import type { XPass } from "../../application/xPass";
import type { AllowListClaim } from "../../application/allowList";
import type { VaultRelay } from "../../application/vaultRelay";
import { summarizeVault, VAULT_ACTIONS, VAULT_BOX_STATES, type VaultSummary } from "../../domain/vault";

export interface MetricsSources {
  /**
   * The index's counts. Left out on API replicas (ROLE=api): they would all report the same
   * table, and a sum over them would count it once per replica. The indexer reports it.
   */
  store?: Pick<ReadStore, "stats" | "cursor" | "finalizedCursor" | "milestonesReached" | "allPendingRequests">;
  archive?: Pick<ArchiveStore, "archivedCount">;
  posts?: Pick<PostStore, "postCounts">;
  indexer?: { status(): IndexerStatus };
  rpcStatus?: () => EndpointStatus[];
  chat?: Pick<AskManual, "usage">;
  /** The studio's jobs, and what the services cost today against the budget. */
  studio?: { store: Pick<StudioStore, "studioJobCounts" | "studioSales">; spentToday(): Promise<number>; spentTotal(): Promise<number>; dailyBudgetUsd: number; open: boolean };
  /** The rats adopted, by kind. */
  rats?: Pick<RatStore, "ratCounts">;
  /** The mainnet whitelist: its seats, the X boarding passes, the wallet claims, the suggestion box. */
  whitelist?: {
    seats: { view(): Promise<SeatsView>; passSeated(p: XPass): boolean };
    store: { xPasses(): Promise<XPass[]>; allowListClaims(): Promise<AllowListClaim[]>; ideaCount(): Promise<number> };
    signInEnabled: boolean;
  };
  /** The sealed vault's index (its public events): reported by the indexer, like the other counts. */
  vault?: Pick<ReadStore, "vaultEvents">;
  /** The vault's relayer, on the API replicas that send for holders: its wallet, its day, its outcomes. */
  vaultRelay?: Pick<VaultRelay, "today" | "balance" | "outcomes">;
  /** Shown on `dno_info`; Prometheus adds the `network` and `role` labels to every series from its target. */
  info: { chain: string; collection: string; version: string; role: string };
}

/**
 * The protocol in Prometheus' text format, for the monitoring stack (deploy/monitoring). Only
 * public facts, like the index itself: counts, the indexer's progress, the RPC pool, HTTP
 * traffic. Read at each scrape; nothing is computed in between.
 */
export class Metrics {
  readonly registry = new Registry();
  readonly contentType = this.registry.contentType;
  private readonly http: Histogram<"method" | "route" | "status">;
  private readonly signIns: Counter<"outcome">;

  constructor(s: MetricsSources) {
    const r = this.registry;
    collectDefaultMetrics({ register: r });

    new Gauge({ name: "dno_info", help: "Always 1; labels say what this API indexes", labelNames: ["chain", "collection", "version", "process_role"], registers: [r] })
      .set({ chain: s.info.chain, collection: s.info.collection.toLowerCase(), version: s.info.version, process_role: s.info.role }, 1);

    this.http = new Histogram({
      name: "dno_http_request_duration_seconds",
      help: "HTTP requests by route template and status",
      labelNames: ["method", "route", "status"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [r],
    });

    const gauge = (name: string, help: string, collect: (g: Gauge) => Promise<void> | void, labelNames: string[] = []) =>
      new Gauge({ name, help, labelNames, registers: [r], async collect() { await collect(this); } });

    if (s.store) {
      const store = s.store;
      // --- the protocol ---
      gauge("dno_boxes_minted", "Boxes minted", async (g) => g.set((await store.stats()).minted));
      gauge("dno_boxes_opened", "Boxes opened (cats revealed)", async (g) => g.set((await store.stats()).opened));
      gauge("dno_duels", "Duels ever posted", async (g) => g.set((await store.stats()).duels));
      gauge("dno_duels_open", "Duels waiting on the shelf or for a proof", async (g) => g.set((await store.stats()).openDuels));
      gauge("dno_users", "Addresses seen acting on-chain or signing in", async (g) => g.set((await store.stats()).users));
      gauge("dno_users_registered", "Users who signed in", async (g) => g.set((await store.stats()).registered));
      gauge("dno_events", "Protocol events indexed", async (g) => g.set((await store.stats()).events));
      gauge("dno_milestones_reached", "Sale milestones reached", async (g) => g.set(await store.milestonesReached()));
      gauge(
        "dno_requests_pending",
        "Requests waiting for their KMS proof, by kind",
        async (g) => {
          g.reset();
          for (const req of await store.allPendingRequests()) g.inc({ kind: req.kind });
        },
        ["kind"],
      );
      gauge("dno_request_oldest_pending_blocks", "Blocks since the oldest pending request was placed (0: none)", async (g) => {
        const [pending, cursor] = await Promise.all([store.allPendingRequests(), store.cursor()]);
        const oldest = Math.min(...pending.map((p) => p.placedBlock));
        g.set(pending.length && cursor !== null ? Math.max(0, cursor - oldest) : 0);
      });

      // --- the indexer ---
      gauge("dno_indexer_block", "Last block indexed", async (g) => g.set((await store.cursor()) ?? 0));
      gauge("dno_indexer_finalized_block", "Last block checked again once final", async (g) => g.set((await store.finalizedCursor()) ?? 0));
    }

    if (s.indexer) {
      const status = () => s.indexer!.status();
      gauge("dno_indexer_up", "1 while the indexer loop runs", (g) => g.set(status().running ? 1 : 0));
      gauge("dno_chain_target_block", "Block the last pass aimed at (chain head minus confirmations)", (g) => g.set(status().lastPass?.target ?? 0));
      gauge("dno_indexer_lag_blocks", "Blocks between the target and what is indexed", async (g) => {
        const target = status().lastPass?.target;
        const cursor = (await s.store?.cursor()) ?? null;
        g.set(target !== undefined && cursor !== null ? Math.max(0, target - cursor) : 0);
      });
      gauge("dno_indexer_last_pass_timestamp_seconds", "When the last pass finished", (g) => g.set((status().lastPassAt ?? 0) / 1000));
      gauge("dno_indexer_consecutive_failures", "Passes failed in a row", (g) => g.set(status().failures));
      gauge(
        "dno_task_last_run_timestamp_seconds",
        "When each periodic task last ran",
        (g) => {
          for (const [task, st] of Object.entries(status().tasks)) g.set({ task }, (st.lastRunAt ?? 0) / 1000);
        },
        ["task"],
      );
      gauge(
        "dno_task_failing",
        "1 when a periodic task's last run threw",
        (g) => {
          for (const [task, st] of Object.entries(status().tasks)) g.set({ task }, st.lastError ? 1 : 0);
        },
        ["task"],
      );
    }

    // --- the free RPC endpoints ---
    if (s.rpcStatus) {
      const rpc = s.rpcStatus;
      gauge("dno_rpc_healthy", "1 when the endpoint is not cooling down", (g) => rpc().forEach((e) => g.set({ endpoint: e.name }, e.healthy ? 1 : 0)), ["endpoint"]);
      gauge("dno_rpc_latency_seconds", "Recent latency of each endpoint", (g) => rpc().forEach((e) => g.set({ endpoint: e.name }, e.latencyMs / 1000)), ["endpoint"]);
      new Counter({
        name: "dno_rpc_requests_total",
        help: "Calls each endpoint served or failed",
        labelNames: ["endpoint", "result"],
        registers: [r],
        collect() {
          this.reset();
          for (const e of rpc()) {
            this.inc({ endpoint: e.name, result: "served" }, e.served);
            this.inc({ endpoint: e.name, result: "failed" }, e.failed);
          }
        },
      });
    }

    // --- side services ---
    if (s.archive) {
      const archive = s.archive;
      gauge("dno_images_archived", "Token images stored on Arweave", async (g) => g.set(await archive.archivedCount()));
    }
    if (s.posts) {
      const posts = s.posts;
      gauge(
        "dno_herald_posts",
        "The herald's posts by network and status",
        async (g) => {
          g.reset();
          for (const c of await posts.postCounts()) g.set({ network_account: c.network, status: c.status }, c.count);
        },
        ["network_account", "status"],
      );
    }
    if (s.chat) {
      const chat = s.chat;
      gauge("dno_chat_model_questions_today", "Questions sent to Gemini today (UTC)", async (g) => g.set((await chat.usage()).asked));
      gauge("dno_chat_model_questions_limit", "Questions Gemini may get per UTC day", async (g) => g.set((await chat.usage()).perDay));
    }
    if (s.studio) {
      const studio = s.studio;
      gauge(
        "dno_studio_jobs",
        "Studio generations by kind and status",
        async (g) => {
          g.reset();
          for (const c of await studio.store.studioJobCounts()) g.set({ kind: c.kind, status: c.status }, c.count);
        },
        ["kind", "status"],
      );
      gauge("dno_studio_spent_today_usd", "Estimated dollars the studio's AI services cost today (UTC)", async (g) => g.set(await studio.spentToday()));
      gauge("dno_studio_spent_total_usd", "Estimated dollars the studio's AI services cost since it opened", async (g) => g.set(await studio.spentTotal()));
      gauge("dno_studio_daily_budget_usd", "Dollars the studio may spend on its AI services per UTC day", (g) => g.set(studio.dailyBudgetUsd));
      gauge("dno_studio_open", "1 when the studio can generate (key, contract, not paused), 0 when it is off", (g) => g.set(studio.open ? 1 : 0));
      gauge("dno_studio_packs_sold", "Studio packs sold since the contract was deployed", async (g) => g.set((await studio.store.studioSales()).packs));
      gauge("dno_studio_revenue_usdc", "USDC the studio's packs brought in since the contract was deployed", async (g) => g.set((await studio.store.studioSales()).paidUsdc));
    }
    this.signIns = new Counter({ name: "dno_xpass_sign_ins_total", help: "Sign in with X attempts back from X, by outcome (ok, sign-in-refused, sign-in-expired, x-down, list-full, no-pass)", labelNames: ["outcome"], registers: [r] });
    if (s.whitelist) {
      const w = s.whitelist;
      gauge("dno_whitelist_seats_taken", "Seats taken on the mainnet whitelist: X accounts with every task done, and wallets that claimed and played", async (g) => g.set((await w.seats.view()).taken));
      gauge("dno_whitelist_seats_places", "Seats on the mainnet whitelist (ALLOW_LIST_PLACES); 0 for no cap", async (g) => g.set((await w.seats.view()).places ?? 0));
      gauge("dno_whitelist_claims", "Wallets that claimed a place on the whitelist by signing", async (g) => g.set((await w.store.allowListClaims()).length));
      gauge("dno_xpass_signin_enabled", "1 when Sign in with X is configured (X_CLIENT_ID)", (g) => g.set(w.signInEnabled ? 1 : 0));
      gauge(
        "dno_xpass_passes",
        "X boarding passes, by stage: started (a token handed out), connected (an X account proved), seated (every required task done), wallet (a wallet linked)",
        async (g) => {
          const passes = await w.store.xPasses();
          g.set({ stage: "started" }, passes.length);
          g.set({ stage: "connected" }, passes.filter((p) => p.handle).length);
          g.set({ stage: "seated" }, passes.filter((p) => w.seats.passSeated(p)).length);
          g.set({ stage: "wallet" }, passes.filter((p) => p.handle && p.address).length);
        },
        ["stage"],
      );
      gauge(
        "dno_xpass_tasks",
        "Tasks on X declared done on connected passes, by task",
        async (g) => {
          const connected = (await w.store.xPasses()).filter((p) => p.handle);
          const at = { follow: "followedAt", post: "postedAt", like: "likedAt", reply: "repliedAt", repost: "repostedAt" } as const;
          for (const [task, field] of Object.entries(at)) g.set({ task }, connected.filter((p) => p[field] !== null).length);
        },
        ["task"],
      );
      gauge("dno_ideas_received", "Ideas left in the boarding page's suggestion box", async (g) => g.set(await w.store.ideaCount()));
    }
    if (s.vault) {
      const store = s.vault;
      // One read of the vault's events per scrape, shared by its gauges.
      let cached: { at: number; summary: Promise<VaultSummary> } | null = null;
      const summary = () => {
        if (!cached || Date.now() - cached.at > 5_000) cached = { at: Date.now(), summary: store.vaultEvents().then(summarizeVault) };
        return cached.summary;
      };
      const eth = (wei: string) => Number(BigInt(wei) / 10n ** 12n) / 1e6;
      gauge("dno_vault_boxes", "Sealed vault boxes by state: sealed, listed, sold (proceeds not yet collected), withdrawn, claimed", async (g) => {
        const v = await summary();
        for (const state of VAULT_BOX_STATES) g.set({ state }, v.boxes[state]);
      }, ["state"]);
      gauge("dno_vault_deposits", "NFTs ever deposited in the sealed vault", async (g) => g.set((await summary()).deposits));
      gauge("dno_vault_withdrawals", "NFTs ever taken out of the sealed vault", async (g) => g.set((await summary()).withdrawals));
      gauge("dno_vault_listings", "Seaport listings placed by the vault, and those live now", async (g) => {
        const v = await summary();
        g.set({ kind: "placed" }, v.listings);
        g.set({ kind: "live" }, v.listed);
        g.set({ kind: "unlisted" }, v.unlisted);
        g.set({ kind: "expired" }, v.expired);
      }, ["kind"]);
      gauge("dno_vault_seaport_sales", "Vault boxes sold on Seaport", async (g) => g.set((await summary()).seaportSales));
      gauge("dno_vault_seaport_volume_eth", "ETH Seaport buyers paid for vault boxes", async (g) => g.set(eth((await summary()).seaportVolume)));
      gauge("dno_vault_claimed_eth", "ETH holders collected from Seaport sales, the fee taken", async (g) => g.set(eth((await summary()).claimed)));
      gauge("dno_vault_private_sales", "Private sales by status: offered, settled, cancelled, open (prices and outcomes stay encrypted)", async (g) => {
        const p = (await summary()).privateSales;
        for (const status of ["offered", "settled", "cancelled", "open"] as const) g.set({ status }, p[status]);
      }, ["status"]);
      gauge("dno_vault_requests", "Vault requests placed, by action", async (g) => {
        const r = (await summary()).requests;
        for (const action of VAULT_ACTIONS) g.set({ action }, r.placed[action]);
      }, ["action"]);
      gauge("dno_vault_requests_settled", "Vault requests settled, by outcome (done, refused: a wrong key, stale: the box changed first, expired: no proof within a day)", async (g) => {
        const r = (await summary()).requests;
        for (const status of ["done", "refused", "stale"] as const) g.set({ status }, r.settled[status]);
      }, ["status"]);
      gauge("dno_vault_requests_pending", "Vault requests waiting for their proof", async (g) => g.set((await summary()).requests.pending));
    }
    if (s.vaultRelay) {
      const relay = s.vaultRelay;
      gauge("dno_vault_relayer_balance_eth", "ETH left on the vault relayer's wallet, which pays the gas of what it sends", async (g) => {
        const wei = await relay.balance().catch(() => null);
        if (wei !== null) g.set(Number(wei / 10n ** 12n) / 1e6);
      });
      gauge("dno_vault_relayer_sent_today", "Transactions this replica's vault relayer sent today (UTC)", (g) => g.set(relay.today().sent));
      gauge("dno_vault_relayer_daily_cap", "Transactions a replica's vault relayer may send per UTC day (VAULT_RELAY_PER_DAY)", (g) => g.set(relay.today().perDay));
      new Counter({
        name: "dno_vault_relays_total",
        help: "Vault relays since the replica started, by transaction (request, finalize) and outcome (sent, reverted, daily-cap, failed)",
        labelNames: ["kind", "outcome"],
        registers: [r],
        collect() {
          this.reset();
          for (const [key, n] of relay.outcomes) {
            const [kind, outcome] = key.split(":");
            this.inc({ kind: kind!, outcome: outcome! }, n);
          }
        },
      });
    }
    if (s.rats) {
      const rats = s.rats;
      gauge(
        "dno_rats_minted",
        "Rats adopted from the studio, by kind (seed or AI)",
        async (g) => {
          g.reset();
          for (const c of await rats.ratCounts()) g.set({ kind: c.kind }, c.count);
        },
        ["kind"],
      );
    }
  }

  /** One Sign in with X back from X, and how it went. */
  signIn(outcome: string) {
    this.signIns.inc({ outcome });
  }

  observe(method: string, route: string, status: number, seconds: number) {
    this.http.observe({ method, route, status: String(status) }, seconds);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
