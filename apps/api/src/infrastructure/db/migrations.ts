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
];
