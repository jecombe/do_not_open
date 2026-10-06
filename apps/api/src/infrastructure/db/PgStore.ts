import pg, { type Pool, type PoolClient } from "pg";
import type { ActivityQuery, DuelQuery, EntangleProposal, ProjectionTx, Stats, Store, StoredEvent, Transfer } from "../../application/ports/store";
import type { Box } from "../../domain/box";
import type { Duel } from "../../domain/duel";
import { actorsOf, QUIET_EVENTS, tokensOf, type ProtocolEvent } from "../../domain/events";
import type { Charge, Meter, PublicDecryption } from "../../domain/relayer";
import type { Request } from "../../domain/request";
import type { Address } from "../../domain/types";
import type { User } from "../../domain/user";
import type { AllowListClaim } from "../../application/allowList";
import type { XPass } from "../../application/xPass";
import type { TermsAcceptance } from "../../application/terms";
import type { EventPosition, Post, PostStore, QueuedDraft } from "../../application/ports/herald";
import type { ArchiveStore } from "../../application/ports/archive";
import type { StudioStore } from "../../application/ports/studio";
import { NO_UNITS, type StudioJob, type StudioLedger, type StudioUnits } from "../../domain/studio";
import type { RatStore } from "../../application/ports/rats";
import type { Adoption, Rat, RatKind } from "../../domain/rats";

// Block numbers and unix times are int8 columns; they all fit a JS number.
pg.types.setTypeParser(20, (v) => Number(v));

type Q = Pick<Pool | PoolClient, "query">;
type Row = Record<string, any>;

/** Any number: one sync batch at a time, whichever instance runs it. */
const SYNC_LOCK = 724_002;
/** Any number: one studio job started at a time, so the last unit and the day's budget are spent once. */
const STUDIO_LOCK = 724_003;
const CURSOR_ID = "chain";
const FINALIZED_ID = "finalized";

const eventFrom = (r: Row): ProtocolEvent =>
  ({ ...r.data, block: r.block, blockHash: r.block_hash, timestamp: r.timestamp, txHash: r.tx_hash, logIndex: r.log_index, source: r.source, name: r.name }) as ProtocolEvent;

const boxFrom = (r: Row): Box => ({
  tokenId: r.token_id,
  status: r.status,
  aliveCheck: r.alive_check,
  partner: r.partner,
  wins: r.wins,
  publicTraits: r.public_traits,
  revealed: r.revealed,
  openedBy: r.opened_by,
  openedBlock: r.opened_block,
  mintedBlock: r.minted_block,
  welcomed: r.welcomed,
  weighing: r.weighing,
  weighIn: r.weigh_in,
});

const duelFrom = (r: Row): Duel => ({
  duelId: r.duel_id,
  tokenA: r.token_a,
  tokenB: r.token_b,
  reserved: r.reserved,
  challenger: r.challenger,
  accepter: r.accepter,
  status: r.status,
  openUntil: r.open_until,
  winner: r.winner,
  loser: r.loser,
  shown: r.shown,
  createdBlock: r.created_block,
  updatedBlock: r.updated_block,
  updatedLog: r.updated_log,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const requestFrom = (r: Row): Request => ({
  requestId: r.request_id,
  kind: r.kind,
  tokenId: r.token_id,
  other: r.other,
  requester: r.requester,
  status: r.status,
  placedBlock: r.placed_block,
  settledBlock: r.settled_block,
});

const userFrom = (r: Row): User => ({
  address: r.address,
  firstBlock: r.first_block,
  lastBlock: r.last_block,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  actions: r.actions,
  registeredAt: r.registered_at,
  lastLoginAt: r.last_login_at,
});

const transferFrom = (r: Row): Transfer => ({
  txHash: r.tx_hash,
  logIndex: r.log_index,
  block: r.block,
  blockHash: r.block_hash,
  timestamp: r.timestamp,
  tokenId: r.token_id,
  from: r.from_address,
  to: r.to_address,
  moved: r.moved,
});

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

async function one<T>(q: Q, sql: string, params: unknown[], map: (r: Row) => T): Promise<T | null> {
  const { rows } = await q.query(sql, params);
  return rows[0] ? map(rows[0]) : null;
}

async function saveUser(q: Q, u: User) {
  await q.query(
    `insert into users (address, first_block, last_block, first_seen_at, last_seen_at, actions, registered_at, last_login_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (address) do update set first_block = $2, last_block = $3, first_seen_at = $4, last_seen_at = $5,
       actions = $6, registered_at = $7, last_login_at = $8`,
    [u.address, u.firstBlock, u.lastBlock, u.firstSeenAt, u.lastSeenAt, u.actions, u.registeredAt, u.lastLoginAt],
  );
}

const creditsOf = async (q: Q, account: Address) => (await one(q, "select bought from credit_accounts where account = $1", [account], (r) => r.bought as number)) ?? 0;

/** With `lock`, inside a transaction: the rows stay locked until it ends. */
async function meterOf(q: Q, account: Address, day: string, lock: boolean): Promise<Meter> {
  const forUpdate = lock ? " for update" : "";
  const freeUsed = await one(q, `select units from relayer_free_used where account = $1 and day = $2${forUpdate}`, [account, day], (r) => r.units as number);
  const spent = await one(q, `select spent from relayer_credits_spent where account = $1${forUpdate}`, [account], (r) => r.spent as number);
  return { freeUsed: freeUsed ?? 0, spent: spent ?? 0, bought: await creditsOf(q, account) };
}

const ratFrom = (r: Row): Rat => ({
  id: r.token_id,
  kind: r.kind,
  ref: r.ref,
  uri: r.uri,
  owner: r.owner,
  minter: r.minter,
  mintedBlock: r.minted_block,
  mintedAt: r.minted_at,
});

const adoptionFrom = (r: Row): Adoption => ({
  jobId: r.job_id,
  jobRef: r.job_ref,
  account: r.account,
  prompt: r.prompt,
  imageId: r.image_id,
  recordId: r.record_id,
  createdAt: r.created_at,
});

const studioJobFrom = (r: Row): StudioJob => ({
  id: r.id,
  account: r.account,
  kind: r.kind,
  status: r.status,
  prompt: r.prompt,
  sketchId: r.sketch_id,
  resultUrl: r.result_url,
  error: r.error,
  costUsd: Number(r.cost_usd),
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

const studioBoughtOf = async (q: Q, account: Address): Promise<StudioUnits> =>
  (await one(q, "select sketches, models from studio_accounts where account = $1", [account], (r) => ({ sketches: r.sketches as number, models: r.models as number }))) ?? { ...NO_UNITS };

async function studioUsedOf(q: Q, account: Address): Promise<StudioUnits> {
  const { rows } = await q.query("select kind, count(*)::int as n from studio_jobs where account = $1 and status <> 'failed' group by kind", [account]);
  const used = { ...NO_UNITS };
  for (const r of rows) used[r.kind === "sketch" ? "sketches" : "models"] = r.n;
  return used;
}

const studioSpentOf = async (q: Q, since: number): Promise<number> =>
  (await one(q, "select coalesce(sum(cost_usd), 0) as usd from studio_jobs where created_at >= $1", [since], (r) => Number(r.usd))) ?? 0;

const publicDecryptionFrom = (r: Record<string, unknown>): PublicDecryption => ({
  key: r.key as string,
  jobId: r.job_id as string,
  queued: r.queued,
  result: r.result ?? null,
  at: Number(r.at),
});

const getUser = (q: Q, address: Address) => one(q, "select * from users where address = $1", [address], userFrom);

/** The index in Postgres. */
const proposalFrom = (r: Row): EntangleProposal => ({ tokenA: r.token_a, tokenB: r.token_b, proposer: r.proposer, block: Number(r.block) });

export class PgStore implements Store, PostStore, ArchiveStore, StudioStore, RatStore {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(run: (tx: ProjectionTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [SYNC_LOCK]);
      const result = await run(this.txOn(client));
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private txOn(c: PoolClient): ProjectionTx {
    return {
      insertEvent: async (e, enrichment) => {
        const { block, blockHash, timestamp, txHash, logIndex, source, name, ...data } = e;
        const { rowCount } = await c.query(
          `insert into events (tx_hash, log_index, block, block_hash, timestamp, source, name, data, actors, tokens, enrichment)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing`,
          [txHash, logIndex, block, blockHash, timestamp, source, name, JSON.stringify(data), actorsOf(e), tokensOf(e), json(enrichment)],
        );
        return rowCount === 1;
      },
      deleteEvents: async (keys) => {
        if (!keys.length) return 0;
        const pairs = keys.map((k) => k.split(":"));
        const { rowCount } = await c.query("delete from events where (tx_hash, log_index) in (select * from unnest($1::text[], $2::int[]))", [
          pairs.map((p) => p[0]),
          pairs.map((p) => Number(p[1])),
        ]);
        return rowCount ?? 0;
      },
      eventsBetween: async (from, to) => {
        const { rows } = await c.query("select tx_hash, log_index, block_hash from events where block between $1 and $2", [from, to]);
        return rows.map((r) => ({ key: `${r.tx_hash}:${r.log_index}`, blockHash: r.block_hash }));
      },
      storedEvents: async (after, limit): Promise<StoredEvent[]> => {
        const { rows } = await c.query(
          `select * from events where ($1::bigint is null or (block, log_index) > ($1::bigint, $2::int))
           order by block, log_index limit $3`,
          [after?.block ?? null, after?.logIndex ?? 0, limit],
        );
        return rows.map((r) => ({ event: eventFrom(r), enrichment: r.enrichment }));
      },
      resetReadModels: async () => {
        await c.query("truncate boxes, duels, requests, entangle_proposals, mints, milestones, transfers, published_handles, credit_accounts, studio_accounts, rats, rat_sniffers");
        // Sign-ins stay; on-chain activity is counted again by the replay.
        await c.query("delete from users where registered_at is null");
        await c.query("update users set first_block = null, last_block = null, first_seen_at = null, last_seen_at = null, actions = 0");
      },
      setCursor: async (block) => {
        await c.query("insert into sync_state (id, block) values ($1, $2) on conflict (id) do update set block = $2", [CURSOR_ID, block]);
      },
      setFinalizedCursor: async (block) => {
        await c.query("insert into sync_state (id, block) values ($1, $2) on conflict (id) do update set block = $2", [FINALIZED_ID, block]);
      },
      saveRange: async (from, to, servedBy) => {
        if (to < from || !servedBy.length) return;
        await c.query("insert into indexed_ranges (from_block, to_block, served_by) values ($1, $2, $3)", [from, to, servedBy]);
      },
      pruneRanges: async (upTo) => {
        await c.query("delete from indexed_ranges where to_block <= $1", [upTo]);
      },
      box: (id) => one(c, "select * from boxes where token_id = $1", [id], boxFrom),
      saveBox: async (b) => {
        await c.query(
          `insert into boxes (token_id, status, alive_check, partner, wins, public_traits, revealed, opened_by, opened_block, minted_block, welcomed, weighing, weigh_in)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           on conflict (token_id) do update set status = $2, alive_check = $3, partner = $4, wins = $5, public_traits = $6, revealed = $7,
             opened_by = $8, opened_block = $9, minted_block = $10, welcomed = $11, weighing = $12, weigh_in = $13`,
          [b.tokenId, b.status, b.aliveCheck, b.partner, b.wins, json(b.publicTraits), json(b.revealed), b.openedBy, b.openedBlock, b.mintedBlock, b.welcomed, b.weighing, json(b.weighIn)],
        );
      },
      duel: (id) => one(c, "select * from duels where duel_id = $1", [id], duelFrom),
      saveDuel: async (d) => {
        await c.query(
          `insert into duels (duel_id, token_a, token_b, challenger, accepter, status, winner, loser, shown, created_block, updated_block, created_at, updated_at,
             reserved, open_until, updated_log)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           on conflict (duel_id) do update set token_a = $2, token_b = $3, challenger = $4, accepter = $5, status = $6, winner = $7,
             loser = $8, shown = $9, created_block = $10, updated_block = $11, created_at = $12, updated_at = $13,
             reserved = $14, open_until = $15, updated_log = $16`,
          [d.duelId, d.tokenA, d.tokenB, d.challenger, d.accepter, d.status, d.winner, d.loser, json(d.shown), d.createdBlock, d.updatedBlock, d.createdAt, d.updatedAt,
            d.reserved, d.openUntil, d.updatedLog],
        );
      },
      request: (id) => one(c, "select * from requests where request_id = $1", [id], requestFrom),
      saveRequest: async (r) => {
        await c.query(
          `insert into requests (request_id, kind, token_id, other, requester, status, placed_block, settled_block)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (request_id) do update set kind = $2, token_id = $3, other = $4, requester = $5, status = $6, placed_block = $7, settled_block = $8`,
          [r.requestId, r.kind, r.tokenId, r.other, r.requester, r.status, r.placedBlock, r.settledBlock],
        );
      },
      user: (a) => getUser(c, a),
      saveUser: (u) => saveUser(c, u),
      saveProposal: async (p) => {
        await c.query(
          "insert into entangle_proposals (token_a, token_b, proposer, block) values ($1, $2, $3, $4) on conflict (token_a, token_b) do update set proposer = $3, block = $4",
          [p.tokenA, p.tokenB, p.proposer, p.block],
        );
      },
      deleteProposal: async (a, b) => {
        await c.query("delete from entangle_proposals where token_a = $1 and token_b = $2", [a, b]);
      },
      saveMint: async (m) => {
        await c.query("insert into mints (first_token_id, count, buyer, block, tx_hash) values ($1, $2, $3, $4, $5) on conflict do nothing", [
          m.firstTokenId,
          m.count,
          m.buyer,
          m.block,
          m.txHash,
        ]);
      },
      saveMilestone: async (m) => {
        await c.query("insert into milestones (idx, sold, block) values ($1, $2, $3) on conflict do nothing", [m.index, m.sold, m.block]);
      },
      savePublished: async (handles, caller, block) => {
        await c.query(
          "insert into published_handles (handle, caller, block) select h, $2, $3 from unnest($1::text[]) as h on conflict do nothing",
          [handles.map((h) => h.toLowerCase()), caller, block],
        );
      },
      addStudioUnits: async (account, sketches, models, paid = "0") => {
        await c.query(
          `insert into studio_accounts (account, sketches, models, packs, paid) values ($1, $2, $3, 1, $4)
           on conflict (account) do update set sketches = studio_accounts.sketches + $2, models = studio_accounts.models + $3,
             packs = studio_accounts.packs + 1, paid = studio_accounts.paid + $4`,
          [account, sketches, models, paid],
        );
      },
      rat: (id) => one(c, "select * from rats where token_id = $1", [id], ratFrom),
      saveRat: async (r) => {
        await c.query(
          `insert into rats (token_id, kind, ref, uri, owner, minter, minted_block, minted_at) values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (token_id) do update set kind = $2, ref = $3, uri = $4, owner = $5, minter = $6, minted_block = $7, minted_at = $8`,
          [r.id, r.kind, r.ref, r.uri, r.owner, r.minter, r.mintedBlock, r.mintedAt],
        );
      },
      addSniff: async (account) => {
        await c.query("insert into rat_sniffers (account, sniffs) values ($1, 1) on conflict (account) do update set sniffs = rat_sniffers.sniffs + 1", [account]);
      },
      addCredits: async (account, credits) => {
        await c.query("insert into credit_accounts (account, bought) values ($1, $2) on conflict (account) do update set bought = credit_accounts.bought + $2", [account, credits]);
      },
      saveTransfer: async (t) => {
        await c.query(
          `insert into transfers (tx_hash, log_index, block, block_hash, timestamp, token_id, from_address, to_address, moved)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
          [t.txHash, t.logIndex, t.block, t.blockHash, t.timestamp, t.tokenId, t.from, t.to, t.moved],
        );
      },
    };
  }

  async cursor() {
    return one(this.pool, "select block from sync_state where id = $1", [CURSOR_ID], (r) => r.block as number);
  }

  async finalizedCursor() {
    return one(this.pool, "select block from sync_state where id = $1", [FINALIZED_ID], (r) => r.block as number);
  }

  async servedBy(from: number, to: number) {
    const { rows } = await this.pool.query("select distinct unnest(served_by) as name from indexed_ranges where from_block <= $2 and to_block >= $1", [from, to]);
    return rows.map((r) => r.name as string);
  }

  async knownDuelIds() {
    return (await this.pool.query("select duel_id from duels order by duel_id")).rows.map((r) => r.duel_id as number);
  }

  async knownRequestIds() {
    return (await this.pool.query("select request_id from requests order by request_id")).rows.map((r) => r.request_id as number);
  }

  async allPendingRequests() {
    return (await this.pool.query("select * from requests where status = 'pending' order by request_id")).rows.map(requestFrom);
  }

  box(tokenId: number) {
    return one(this.pool, "select * from boxes where token_id = $1", [tokenId], boxFrom);
  }

  async boxes(from: number, to: number) {
    const { rows } = await this.pool.query("select * from boxes where token_id >= $1 and token_id < $2 order by token_id", [from, to]);
    return rows.map(boxFrom);
  }

  async tokenCount() {
    return (await one(this.pool, "select coalesce(max(first_token_id + count), 0) as n from mints", [], (r) => r.n as number)) ?? 0;
  }

  async milestonesReached() {
    return (await one(this.pool, "select count(*)::int as n from milestones", [], (r) => r.n as number)) ?? 0;
  }

  async openedBoxes() {
    const { rows } = await this.pool.query("select * from boxes where status = 'revealed' order by token_id");
    return rows.map(boxFrom);
  }

  duel(duelId: number) {
    return one(this.pool, "select * from duels where duel_id = $1", [duelId], duelFrom);
  }

  async duels(q: DuelQuery) {
    const { rows } = await this.pool.query(
      `select * from duels
       where (($1::text is null and cardinality($2::int[]) = 0)
              or ($1::text is not null and (challenger = $1 or accepter = $1)) or token_a = any($2::int[]) or token_b = any($2::int[]))
         and ($3::text[] is null or status = any($3::text[]))
         and ($5::bigint is null or status <> 'open' or open_until is null or open_until >= $5)
       order by duel_id desc limit $4`,
      [q.account ?? null, q.tokenIds ?? [], q.statuses ?? null, q.limit, q.inTimeAt ?? null],
    );
    return rows.map(duelFrom);
  }

  proposal(tokenA: number, tokenB: number) {
    return one(
      this.pool,
      "select * from entangle_proposals where token_a = $1 and token_b = $2",
      [tokenA, tokenB],
      proposalFrom,
    );
  }

  async proposals(tokenIds: number[], limit: number) {
    const { rows } = await this.pool.query(
      "select * from entangle_proposals where token_a = any($1::int[]) or token_b = any($1::int[]) order by block desc, token_a, token_b limit $2",
      [tokenIds, limit],
    );
    return rows.map(proposalFrom);
  }

  async pendingRequests(requester: Address) {
    const { rows } = await this.pool.query("select * from requests where requester = $1 and status = 'pending' order by request_id", [requester]);
    return rows.map(requestFrom);
  }

  async transfers(account: Address, afterBlock: number, limit: number) {
    const { rows } = await this.pool.query(
      `select * from transfers where block > $2 and (from_address = $1 or to_address = $1)
       order by block, log_index limit $3`,
      [account, afterBlock, limit],
    );
    return rows.map(transferFrom);
  }

  user(address: Address) {
    return getUser(this.pool, address);
  }

  async activity(q: ActivityQuery): Promise<ProtocolEvent[]> {
    const { rows } = await this.pool.query(
      `select * from events
       where name <> all($5::text[])
         and ($1::bigint is null or block < $1)
         and ($2::int is null or tokens @> array[$2::int])
         and ($3::text is null or actors @> array[$3::text])
       order by block desc, log_index desc limit $4`,
      [q.beforeBlock ?? null, q.tokenId ?? null, q.account ?? null, q.limit, QUIET_EVENTS],
    );
    return rows.map(eventFrom);
  }

  async stats(): Promise<Stats> {
    const { rows } = await this.pool.query(`
      select
        (select count(*)::int from users) as users,
        (select count(*)::int from users where registered_at is not null) as registered,
        (select coalesce(max(first_token_id + count), 0)::int from mints) as minted,
        (select count(*)::int from boxes where status = 'revealed') as opened,
        (select count(*)::int from duels) as duels,
        (select count(*)::int from duels where status in ('posted', 'open', 'pending')) as open_duels,
        (select count(*)::int from events) as events`);
    const r = rows[0]!;
    return { users: r.users, registered: r.registered, minted: r.minted, opened: r.opened, duels: r.duels, openDuels: r.open_duels, events: r.events };
  }

  saveUser(user: User) {
    return saveUser(this.pool, user);
  }

  async saveNonce(address: Address, nonce: string, expiresAt: number) {
    await this.pool.query("insert into auth_nonces (address, nonce, expires_at) values ($1, $2, $3) on conflict (address) do update set nonce = $2, expires_at = $3", [
      address,
      nonce,
      expiresAt,
    ]);
  }

  async publishedAmong(handles: string[]) {
    const { rows } = await this.pool.query("select handle from published_handles where handle = any($1::text[])", [handles.map((h) => h.toLowerCase())]);
    return rows.map((r) => r.handle as string);
  }

  async creditsBought(account: Address) {
    return creditsOf(this.pool, account);
  }

  studioUnitsBought(account: Address) {
    return studioBoughtOf(this.pool, account);
  }

  async startStudioJob(account: Address, since: number, decide: (ledger: StudioLedger) => StudioJob | null): Promise<StudioJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // One start at a time, whatever the account: the budget is shared by every account.
      await client.query("select pg_advisory_xact_lock($1)", [STUDIO_LOCK]);
      const job = decide({ bought: await studioBoughtOf(client, account), used: await studioUsedOf(client, account), spentTodayUsd: await studioSpentOf(client, since) });
      if (job) {
        await client.query(
          `insert into studio_jobs (id, account, kind, status, prompt, sketch_id, result_url, error, cost_usd, created_at, finished_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [job.id, job.account, job.kind, job.status, job.prompt, job.sketchId, job.resultUrl, job.error, job.costUsd, job.createdAt, job.finishedAt],
        );
      }
      await client.query("commit");
      return job;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finishStudioJob(id: string, result: { status: "done" | "failed" | "rejected"; resultUrl: string | null; error: string | null }, at: number) {
    await this.pool.query("update studio_jobs set status = $2, result_url = $3, error = $4, finished_at = $5 where id = $1 and status = 'running'", [
      id,
      result.status,
      result.resultUrl,
      result.error,
      at,
    ]);
  }

  async failStaleStudioJobs(before: number, error: string, at: number) {
    const { rowCount } = await this.pool.query("update studio_jobs set status = 'failed', error = $2, finished_at = $3 where status = 'running' and created_at < $1", [before, error, at]);
    return rowCount ?? 0;
  }

  studioJob(id: string) {
    return one(this.pool, "select * from studio_jobs where id = $1", [id], studioJobFrom);
  }

  async studioJobs(account: Address, limit: number) {
    const { rows } = await this.pool.query("select * from studio_jobs where account = $1 order by created_at desc, id desc limit $2", [account, limit]);
    return rows.map(studioJobFrom);
  }

  studioUnitsUsed(account: Address) {
    return studioUsedOf(this.pool, account);
  }

  studioSpentSince(since: number) {
    return studioSpentOf(this.pool, since);
  }

  async studioRefundsSince(account: Address, since: number) {
    return (await one(this.pool, "select count(*)::int as n from studio_jobs where account = $1 and status = 'failed' and created_at >= $2", [account, since], (r) => r.n as number)) ?? 0;
  }

  async studioSales() {
    return (
      (await one(this.pool, "select coalesce(sum(packs), 0)::bigint as packs, coalesce(sum(paid), 0) as paid from studio_accounts", [], (r) => ({
        packs: Number(r.packs),
        paidUsdc: Number(r.paid) / 1e6,
      }))) ?? { packs: 0, paidUsdc: 0 }
    );
  }

  rat(ratId: number) {
    return one(this.pool, "select * from rats where token_id = $1", [ratId], ratFrom);
  }

  async ratsOf(owner: Address) {
    const { rows } = await this.pool.query("select * from rats where owner = $1 order by token_id", [owner]);
    return rows.map(ratFrom);
  }

  ratOfRef(ref: string) {
    return one(this.pool, "select * from rats where ref = $1 order by token_id limit 1", [ref], ratFrom);
  }

  async sniffsOf(accounts: Address[]) {
    const { rows } = await this.pool.query("select account, sniffs from rat_sniffers where account = any($1::text[])", [accounts]);
    const found = new Map<string, number>(rows.map((r) => [r.account as string, Number(r.sniffs)]));
    return new Map(accounts.map((a) => [a, found.get(a) ?? 0] as const));
  }

  async ratCounts() {
    const { rows } = await this.pool.query("select kind, count(*)::int as count from rats group by kind");
    return rows.map((r) => ({ kind: r.kind as RatKind, count: r.count as number }));
  }

  async ratsMintedBy(minter: Address) {
    const { rows } = await this.pool.query("select count(*)::int as count from rats where minter = $1", [minter]);
    return rows[0].count as number;
  }

  adoption(jobId: string) {
    return one(this.pool, "select * from rat_adoptions where job_id = $1", [jobId], adoptionFrom);
  }

  adoptionOfRef(jobRef: string) {
    return one(this.pool, "select * from rat_adoptions where job_ref = $1", [jobRef], adoptionFrom);
  }

  async saveAdoption(a: Adoption) {
    await this.pool.query(
      `insert into rat_adoptions (job_id, job_ref, account, prompt, image_id, record_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (job_id) do nothing`,
      [a.jobId, a.jobRef, a.account, a.prompt, a.imageId, a.recordId, a.createdAt],
    );
  }

  async saveRatModel(jobRef: string, glb: Uint8Array, at: number) {
    await this.pool.query("insert into rat_models (job_ref, glb, created_at) values ($1, $2, $3) on conflict (job_ref) do nothing", [jobRef, Buffer.from(glb), at]);
  }

  async ratModel(jobRef: string) {
    return one(this.pool, "select glb from rat_models where job_ref = $1", [jobRef], (r) => new Uint8Array(r.glb as Buffer));
  }

  async studioJobCounts() {
    const { rows } = await this.pool.query("select kind, status, count(*)::int as count from studio_jobs group by kind, status");
    return rows.map((r) => ({ kind: r.kind as string, status: r.status as string, count: r.count as number }));
  }

  async meterOf(account: Address, day: string): Promise<Meter> {
    return meterOf(this.pool, account, day, false);
  }

  async meter(account: Address, day: string, apply: (m: Meter) => Charge | null): Promise<Charge | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Rows to lock even on a first call of the day.
      await client.query("insert into relayer_free_used (account, day, units) values ($1, $2, 0) on conflict do nothing", [account, day]);
      await client.query("insert into relayer_credits_spent (account, spent) values ($1, 0) on conflict do nothing", [account]);
      const delta = apply(await meterOf(client, account, day, true));
      if (delta) {
        await client.query("update relayer_free_used set units = units + $3 where account = $1 and day = $2", [account, day, delta.free]);
        await client.query("update relayer_credits_spent set spent = spent + $2 where account = $1", [account, delta.credits]);
      }
      await client.query("commit");
      return delta;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  publicDecryption(key: string) {
    return one(this.pool, "select * from public_decryptions where key = $1", [key], publicDecryptionFrom);
  }

  publicDecryptionOfJob(jobId: string) {
    return one(this.pool, "select * from public_decryptions where job_id = $1", [jobId], publicDecryptionFrom);
  }

  async savePublicDecryption(d: Omit<PublicDecryption, "result">, handles: string[]) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into public_decryptions (key, job_id, queued, result, at) values ($1, $2, $3, null, $4)
         on conflict (key) do update set job_id = $2, queued = $3, result = null, at = $4`,
        [d.key, d.jobId, JSON.stringify(d.queued), d.at],
      );
      await client.query(
        "insert into public_decrypt_uses (handle, uses) select h, 1 from unnest($1::text[]) h on conflict (handle) do update set uses = public_decrypt_uses.uses + 1",
        [handles],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finishPublicDecryption(jobId: string, result: unknown) {
    await this.pool.query("update public_decryptions set result = $2 where job_id = $1", [jobId, JSON.stringify(result)]);
  }

  async dropPublicDecryption(jobId: string) {
    await this.pool.query("delete from public_decryptions where job_id = $1 and result is null", [jobId]);
  }

  async publicDecryptionsOf(handles: string[]) {
    const { rows } = await this.pool.query("select handle, uses from public_decrypt_uses where handle = any($1::text[])", [handles]);
    return new Map(rows.map((r) => [r.handle as string, r.uses as number]));
  }

  async saveTermsAcceptance(a: TermsAcceptance) {
    const { rows } = await this.pool.query(
      "insert into terms_acceptances (address, version, hash, message, signature, received_at) values ($1, $2, $3, $4, $5, $6) on conflict (address, version) do nothing returning address",
      [a.address, a.version, a.hash, a.message, a.signature, a.receivedAt],
    );
    if (rows.length) return null;
    return one(this.pool, "select * from terms_acceptances where address = $1 and version = $2", [a.address, a.version], termsFrom);
  }

  async termsAcceptances(address: Address) {
    const { rows } = await this.pool.query("select * from terms_acceptances where address = $1 order by received_at, version", [address]);
    return rows.map(termsFrom);
  }

  allowListClaim(address: Address) {
    return one(this.pool, "select * from allow_list_claims where address = $1", [address], claimFrom);
  }

  async allowListClaims() {
    const { rows } = await this.pool.query("select * from allow_list_claims order by claimed_at, address");
    return rows.map(claimFrom);
  }

  async saveAllowListClaim(c: AllowListClaim) {
    await this.pool.query(
      `insert into allow_list_claims (address, points, message, signature, claimed_at, updated_at) values ($1, $2, $3, $4, $5, $6)
       on conflict (address) do update set points = excluded.points, message = excluded.message, signature = excluded.signature, updated_at = excluded.updated_at`,
      [c.address, c.points, c.message, c.signature, c.claimedAt, c.updatedAt],
    );
  }

  xPassById(id: string) {
    return one(this.pool, "select * from x_passes where id = $1", [id], xPassFrom);
  }

  xPassByCode(code: string) {
    return one(this.pool, "select * from x_passes where code = $1", [code], xPassFrom);
  }

  xPassByHandle(handle: string) {
    return one(this.pool, "select * from x_passes where handle = $1", [handle], xPassFrom);
  }

  xPassByXUser(xUserId: string) {
    return one(this.pool, "select * from x_passes where x_user_id = $1", [xUserId], xPassFrom);
  }

  xPassByTweet(tweetId: string) {
    return one(this.pool, "select * from x_passes where tweet_id = $1", [tweetId], xPassFrom);
  }

  xPassByAddress(address: Address) {
    return one(this.pool, "select * from x_passes where address = $1", [address], xPassFrom);
  }

  async xPasses() {
    const { rows } = await this.pool.query("select * from x_passes order by created_at, id");
    return rows.map(xPassFrom);
  }

  async saveXPass(p: XPass) {
    await this.pool.query(
      `insert into x_passes (id, code, handle, x_user_id, tweet_id, tweet_url, followed_at, posted_at, liked_at, replied_at, reposted_at, address, created_at, verified_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       on conflict (id) do update set code = excluded.code, handle = excluded.handle, x_user_id = excluded.x_user_id, tweet_id = excluded.tweet_id, tweet_url = excluded.tweet_url,
         followed_at = excluded.followed_at, posted_at = excluded.posted_at, liked_at = excluded.liked_at, replied_at = excluded.replied_at, reposted_at = excluded.reposted_at,
         address = excluded.address, created_at = excluded.created_at, verified_at = excluded.verified_at, updated_at = excluded.updated_at`,
      [p.id, p.code, p.handle, p.xUserId, p.tweetId, p.tweetUrl, p.followedAt, p.postedAt, p.likedAt, p.repliedAt, p.repostedAt, p.address, p.createdAt, p.verifiedAt, p.updatedAt],
    );
  }

  async deleteXPass(id: string) {
    await this.pool.query("delete from x_passes where id = $1", [id]);
  }

  takeNonce(address: Address) {
    return one(this.pool, "delete from auth_nonces where address = $1 returning nonce, expires_at", [address], (r) => ({ nonce: r.nonce as string, expiresAt: r.expires_at as number }));
  }

  // --- the herald's queue

  heraldCursor(network: string) {
    return one(this.pool, "select block, log_index from herald_state where network = $1", [network], (r): EventPosition => ({ block: Number(r.block), logIndex: Number(r.log_index) }));
  }

  async queuePosts(network: string, drafts: QueuedDraft[], cursor: EventPosition, now: number) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      let added = 0;
      for (const d of drafts) {
        const { rowCount } = await client.query(
          "insert into posts (network, key, kind, text, status, created_at, error) values ($1, $2, $3, $4, $5, $6, $7) on conflict (network, key) do nothing",
          [network, d.key, d.kind, d.text, d.skipped ? "skipped" : "queued", now, d.skipped ?? null],
        );
        if (rowCount && !d.skipped) added++;
      }
      await client.query(
        "insert into herald_state (network, block, log_index) values ($1, $2, $3) on conflict (network) do update set block = $2, log_index = $3",
        [network, cursor.block, cursor.logIndex],
      );
      await client.query("commit");
      return added;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  nextQueuedPost(network: string) {
    return one(this.pool, "select * from posts where network = $1 and status = 'queued' order by id limit 1", [network], postFrom);
  }

  async updatePost(id: number, patch: Partial<Post>) {
    const columns: Record<string, string> = { status: "status", postedAt: "posted_at", externalId: "external_id", url: "url", attempts: "attempts", error: "error" };
    const sets = Object.entries(patch).filter(([k]) => k in columns);
    if (!sets.length) return;
    await this.pool.query(`update posts set ${sets.map(([k], i) => `${columns[k]} = $${i + 2}`).join(", ")} where id = $1`, [id, ...sets.map(([, v]) => v)]);
  }

  async hasPost(network: string, key: string) {
    const { rowCount } = await this.pool.query("select 1 from posts where network = $1 and key = $2", [network, key]);
    return !!rowCount;
  }

  async postedSince(network: string, since: number) {
    const { rows } = await this.pool.query("select count(*)::int as n from posts where network = $1 and status = 'posted' and posted_at >= $2", [network, since]);
    return rows[0].n as number;
  }

  async lastPostedAt(network: string) {
    const { rows } = await this.pool.query("select max(posted_at) as at from posts where network = $1 and status = 'posted'", [network]);
    return rows[0].at === null ? null : Number(rows[0].at);
  }

  async posts(limit: number, network?: string) {
    const { rows } = network
      ? await this.pool.query("select * from posts where network = $2 order by id desc limit $1", [limit, network])
      : await this.pool.query("select * from posts order by id desc limit $1", [limit]);
    return rows.map(postFrom);
  }

  async archivedImages(hashes: string[]) {
    if (hashes.length === 0) return new Map<string, string>();
    const { rows } = await this.pool.query("select hash, arweave_id from archived_images where hash = any($1)", [hashes]);
    return new Map(rows.map((r) => [r.hash as string, r.arweave_id as string]));
  }

  async archivedCount() {
    const { rows } = await this.pool.query("select count(*)::int as n from archived_images");
    return rows[0].n as number;
  }

  async postCounts() {
    const { rows } = await this.pool.query("select network, status, count(*)::int as n from posts group by network, status");
    return rows.map((r) => ({ network: r.network as string, status: r.status as Post["status"], count: r.n as number }));
  }

  async saveArchivedImage(hash: string, id: string, archivedAt: number) {
    await this.pool.query("insert into archived_images (hash, arweave_id, archived_at) values ($1, $2, $3) on conflict (hash) do nothing", [hash, id, archivedAt]);
  }
}

const postFrom = (r: Record<string, unknown>): Post => ({
  id: Number(r.id),
  network: r.network as string,
  key: r.key as string,
  kind: r.kind as Post["kind"],
  text: r.text as string,
  status: r.status as Post["status"],
  createdAt: Number(r.created_at),
  postedAt: r.posted_at === null ? null : Number(r.posted_at),
  externalId: (r.external_id as string | null) ?? null,
  url: (r.url as string | null) ?? null,
  attempts: Number(r.attempts),
  error: (r.error as string | null) ?? null,
});

const termsFrom = (r: Record<string, unknown>): TermsAcceptance => ({
  address: r.address as Address,
  version: r.version as string,
  hash: r.hash as string,
  message: r.message as string,
  signature: r.signature as string,
  receivedAt: Number(r.received_at),
});

const claimFrom = (r: Record<string, unknown>): AllowListClaim => ({
  address: r.address as Address,
  points: Number(r.points),
  message: r.message as string,
  signature: r.signature as string,
  claimedAt: Number(r.claimed_at),
  updatedAt: Number(r.updated_at),
});

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const xPassFrom = (r: Record<string, unknown>): XPass => ({
  id: r.id as string,
  code: r.code as string,
  handle: (r.handle as string | null) ?? null,
  xUserId: (r.x_user_id as string | null) ?? null,
  tweetId: (r.tweet_id as string | null) ?? null,
  tweetUrl: (r.tweet_url as string | null) ?? null,
  followedAt: num(r.followed_at),
  postedAt: num(r.posted_at),
  likedAt: num(r.liked_at),
  repliedAt: num(r.replied_at),
  repostedAt: num(r.reposted_at),
  address: (r.address as Address | null) ?? null,
  createdAt: Number(r.created_at),
  verifiedAt: num(r.verified_at),
  updatedAt: Number(r.updated_at),
});
