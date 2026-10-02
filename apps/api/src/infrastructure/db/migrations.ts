/**
 * Schema changes, applied in order and once each. Never edit one that has shipped: add the
 * next. Kept in code so the bundle carries them.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "index",
    sql: /* sql */ `
      create table sync_state (
        id text primary key,
        block bigint not null
      );

      -- Every decoded log, as the chain told it. The read models below are folds of this table.
      create table events (
        tx_hash text not null,
        log_index integer not null,
        block bigint not null,
        timestamp bigint,
        source text not null,
        name text not null,
        data jsonb not null,
        actors text[] not null default '{}',
        tokens integer[] not null default '{}',
        primary key (tx_hash, log_index)
      );
      create index events_order on events (block desc, log_index desc);
      create index events_actors on events using gin (actors);
      create index events_tokens on events using gin (tokens);
      create index events_name on events (name);

      create table boxes (
        token_id integer primary key,
        status text not null,
        alive_check text not null,
        partner integer,
        wins integer not null default 0,
        public_traits jsonb not null default '[]',
        revealed jsonb,
        opened_by text,
        opened_block bigint,
        minted_block bigint not null,
        welcomed boolean not null default false,
        weighing text not null default 'none',
        weigh_in jsonb
      );
      create index boxes_opened on boxes (token_id) where status = 'revealed';
      create index boxes_opened_by on boxes (opened_by) where opened_by is not null;

      create table duels (
        duel_id integer primary key,
        token_a integer not null,
        token_b integer not null,
        challenger text,
        accepter text,
        status text not null,
        winner integer,
        loser integer,
        shown jsonb,
        created_block bigint not null,
        updated_block bigint not null,
        created_at bigint,
        updated_at bigint
      );
      create index duels_token_a on duels (token_a);
      create index duels_token_b on duels (token_b);
      create index duels_challenger on duels (challenger);
      create index duels_accepter on duels (accepter);
      create index duels_open on duels (duel_id) where status in ('challenged', 'pending');

      create table requests (
        request_id integer primary key,
        kind text not null,
        token_id integer not null,
        other integer,
        requester text not null,
        status text not null,
        placed_block bigint not null,
        settled_block bigint
      );
      create index requests_pending on requests (requester) where status = 'pending';

      create table entangle_proposals (
        token_a integer not null,
        token_b integer not null,
        proposer text not null,
        block bigint not null,
        primary key (token_a, token_b)
      );

      create table mints (
        first_token_id integer primary key,
        count integer not null,
        buyer text not null,
        block bigint not null,
        tx_hash text not null
      );

      create table milestones (
        idx integer primary key,
        sold integer not null,
        block bigint not null
      );

      -- Public receipts. Whether each one moved the box is encrypted: only its two sides can tell.
      create table transfers (
        tx_hash text not null,
        log_index integer not null,
        block bigint not null,
        timestamp bigint,
        token_id integer not null,
        from_address text not null,
        to_address text not null,
        moved text not null,
        primary key (tx_hash, log_index)
      );
      create index transfers_from on transfers (from_address, block);
      create index transfers_to on transfers (to_address, block);

      create table users (
        address text primary key,
        first_block bigint,
        last_block bigint,
        first_seen_at bigint,
        last_seen_at bigint,
        actions integer not null default 0,
        registered_at bigint,
        last_login_at bigint
      );

      create table auth_nonces (
        address text primary key,
        nonce text not null,
        expires_at bigint not null
      );
    `,
  },
  {
    version: 2,
    name: "reconciliation",
    sql: /* sql */ `
      -- Events now carry their block hash (to detect reorgs) and what the contract added to them
      -- (to rebuild the read models without the RPC). Earlier rows have neither: the index is
      -- emptied once and rebuilt from the chain, in a minute. Sign-ins are kept.
      truncate events, boxes, duels, requests, entangle_proposals, mints, milestones, transfers, sync_state;
      delete from users where registered_at is null;
      update users set first_block = null, last_block = null, first_seen_at = null, last_seen_at = null, actions = 0;

      alter table events add column block_hash text, add column enrichment jsonb;
      alter table transfers add column block_hash text;

      -- Which endpoint served the logs of which blocks: the finality sweep asks the others.
      create table indexed_ranges (
        from_block bigint not null,
        to_block bigint not null,
        served_by text[] not null
      );
      create index indexed_ranges_to on indexed_ranges (to_block);
    `,
  },
  {
    version: 3,
    name: "duel shelf",
    sql: /* sql */ `
      -- A new DoNotOpen contract, where duels go on a shelf: the old contract's events mean
      -- nothing to it. The index is emptied and rebuilt from the new deployment block on.
      -- Sign-ins are kept.
      truncate events, boxes, duels, requests, entangle_proposals, mints, milestones, transfers, sync_state, indexed_ranges;
      delete from users where registered_at is null;
      update users set first_block = null, last_block = null, first_seen_at = null, last_seen_at = null, actions = 0;

      -- An open duel has no second box until someone takes it up.
      alter table duels alter column token_b drop not null;
      alter table duels add column reserved boolean not null default false;
      alter table duels add column open_until bigint;
      -- Events of one block are told apart by their position: a duel can go back on the shelf.
      alter table duels add column updated_log integer not null default 0;
      drop index duels_open;
      create index duels_open on duels (duel_id) where status in ('posted', 'open', 'pending');
    `,
  },
  {
    version: 4,
    name: "relayer meter",
    sql: /* sql */ `
      -- The index now follows Zama's ACL (handles the protocol made public) and the decryption
      -- credits. Older blocks were read without them: the index is rebuilt from the deployment
      -- block on. Sign-ins are kept.
      truncate events, boxes, duels, requests, entangle_proposals, mints, milestones, transfers, sync_state, indexed_ranges;
      delete from users where registered_at is null;
      update users set first_block = null, last_block = null, first_seen_at = null, last_seen_at = null, actions = 0;

      -- Read models, rebuilt by a replay.
      create table published_handles (
        handle text primary key,
        caller text not null,
        block bigint not null
      );
      create table credit_accounts (
        account text primary key,
        bought bigint not null
      );

      -- What the relayer proxy counted. Not on the chain: a replay keeps it.
      create table relayer_free_used (
        account text not null,
        day date not null,
        units integer not null,
        primary key (account, day)
      );
      create table relayer_credits_spent (
        account text primary key,
        spent bigint not null
      );
    `,
  },
  {
    version: 5,
    name: "uniswap v3 economy",
    sql: /* sql */ `
      -- A new DoNotOpen and a new croquette economy, whose CROQ sells from a locked Uniswap V3
      -- position: the old contracts' events mean nothing to them. The index is emptied and
      -- rebuilt from the oldest live contract on (the decryption credits, kept, so purchases
      -- made before the redeploy still count). Sign-ins and the relayer proxy's counts are kept.
      truncate events, boxes, duels, requests, entangle_proposals, mints, milestones, transfers, sync_state, indexed_ranges,
        published_handles, credit_accounts;
      delete from users where registered_at is null;
      update users set first_block = null, last_block = null, first_seen_at = null, last_seen_at = null, actions = 0;
    `,
  },
];
