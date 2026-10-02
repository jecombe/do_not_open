import pg, { type Pool, type PoolClient } from "pg";
import type { ActivityQuery, DuelQuery, EntangleProposal, ProjectionTx, Stats, Store, StoredEvent, Transfer } from "../../application/ports/store";
import type { Box } from "../../domain/box";
import type { Duel } from "../../domain/duel";
import { actorsOf, QUIET_EVENTS, tokensOf, type ProtocolEvent } from "../../domain/events";
import type { Charge, Meter } from "../../domain/relayer";
import type { Request } from "../../domain/request";
import type { Address } from "../../domain/types";
import type { User } from "../../domain/user";

// Block numbers and unix times are int8 columns; they all fit a JS number.
pg.types.setTypeParser(20, (v) => Number(v));

type Q = Pick<Pool | PoolClient, "query">;
type Row = Record<string, any>;

/** Any number: one sync batch at a time, whichever instance runs it. */
const SYNC_LOCK = 724_002;
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

const getUser = (q: Q, address: Address) => one(q, "select * from users where address = $1", [address], userFrom);

/** The index in Postgres. */
export class PgStore implements Store {
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
        await c.query("truncate boxes, duels, requests, entangle_proposals, mints, milestones, transfers, published_handles, credit_accounts");
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
      (r): EntangleProposal => ({ tokenA: r.token_a, tokenB: r.token_b, proposer: r.proposer, block: r.block }),
    );
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

  takeNonce(address: Address) {
    return one(this.pool, "delete from auth_nonces where address = $1 returning nonce, expires_at", [address], (r) => ({ nonce: r.nonce as string, expiresAt: r.expires_at as number }));
  }
}
