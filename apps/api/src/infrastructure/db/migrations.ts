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
  {
    version: 6,
    name: "public decryption cache",
    sql: /* sql */ `
      -- What the relayer proxy sent Zama for public decryption. Not on the chain: a replay keeps
      -- it. A handle decrypts to the same value forever: the same request is answered from here.
      create table public_decryptions (
        key text primary key,
        job_id text not null,
        queued jsonb not null,
        result jsonb,
        at bigint not null
      );
      create index public_decryptions_job on public_decryptions (job_id);
      -- How many requests sent to Zama named each handle: past a few, the handle is refused.
      create table public_decrypt_uses (
        handle text primary key,
        uses integer not null
      );
    `,
  },
  {
    version: 7,
    name: "terms acceptances",
    sql: /* sql */ `
      -- Release forms signed by players before playing: the exact message and its EIP-191
      -- signature, as evidence. Not on the chain: a replay keeps them.
      create table terms_acceptances (
        address text not null,
        version text not null,
        hash text not null,
        message text not null,
        signature text not null,
        received_at bigint not null,
        primary key (address, version)
      );
    `,
  },
  {
    version: 8,
    name: "herald posts",
    sql: /* sql */ `
      -- What the collection's account says about the protocol: queued, then sent (or rehearsed).
      -- Not on the chain: a replay keeps it, and a post is never queued twice for the same fact.
      create table posts (
        id serial primary key,
        key text not null unique,
        kind text not null,
        text text not null,
        status text not null,
        created_at bigint not null,
        posted_at bigint,
        external_id text,
        url text,
        attempts integer not null default 0,
        error text
      );
      create index posts_queued on posts (id) where status = 'queued';
      -- Where the herald has read the events up to.
      create table herald_state (
        id integer primary key,
        block bigint not null,
        log_index bigint not null
      );
    `,
  },
  {
    version: 9,
    name: "a herald queue per network",
    sql: /* sql */ `
      -- Each account (X, Discord) keeps its own queue, quota and cursor: what was queued so far was X's.
      alter table posts add column network text not null default 'x';
      alter table posts alter column network drop default;
      alter table posts drop constraint posts_key_key;
      alter table posts add constraint posts_network_key unique (network, key);
      drop index posts_queued;
      create index posts_queued on posts (network, id) where status = 'queued';
      alter table herald_state add column network text not null default 'x';
      alter table herald_state alter column network drop default;
      alter table herald_state drop constraint herald_state_pkey;
      alter table herald_state drop column id;
      alter table herald_state add primary key (network);
    `,
  },
  {
    version: 10,
    name: "decoys and closed holes",
    sql: /* sql */ `
      -- A new DoNotOpen (decoy transfers, the security review's fixes), a new croquette economy
      -- and new decryption credits: the old contracts' events mean nothing to them. The index is
      -- emptied and rebuilt from the oldest live contract on. Credits bought from the old
      -- contract stay with it, so what was spent of them is forgotten too. Sign-ins, release
      -- forms, the free daily counts and the decryption cache are kept.
      truncate events, boxes, duels, requests, entangle_proposals, mints, milestones, transfers, sync_state, indexed_ranges,
        published_handles, credit_accounts, relayer_credits_spent;
      delete from users where registered_at is null;
      update users set first_block = null, last_block = null, first_seen_at = null, last_seen_at = null, actions = 0;
      -- Posts are keyed by the fact they tell (opening:0, duel:0...): the new collection's own
      -- would read as already posted. The old ones keep their text under a prefixed key.
      update posts set key = 'v0x5eBa:' || key where kind not in ('digest', 'lesson');
    `,
  },
  {
    version: 11,
    name: "images stored on Arweave",
    sql: /* sql */ `
      -- Token images stored for good, by SHA-256 of their SVG. Not on the chain: a replay keeps
      -- it, and the same picture is never uploaded twice.
      create table archived_images (
        hash text primary key,
        arweave_id text not null,
        archived_at bigint not null
      );
    `,
  },
  {
    version: 12,
    name: "studio packs and jobs",
    sql: /* sql */ `
      -- Studio units bought with StudioPacks: a read model, rebuilt by a replay. The contract is
      -- newer than every block indexed so far, so nothing needs reading again.
      create table studio_accounts (
        account text primary key,
        sketches bigint not null,
        models bigint not null,
        packs bigint not null default 0,
        -- USDC paid, in its smallest unit (6 decimals).
        paid numeric not null default 0
      );
      -- Every generation the studio paid a service for. Not on the chain: a replay keeps it. A
      -- running, finished or rejected job holds one unit of its kind; a failed one gave it back.
      create table studio_jobs (
        id text primary key,
        account text not null,
        kind text not null check (kind in ('sketch', 'model')),
        status text not null check (status in ('running', 'done', 'failed', 'rejected')),
        prompt text not null,
        sketch_id text references studio_jobs (id),
        result_url text,
        error text,
        cost_usd double precision not null,
        created_at bigint not null,
        finished_at bigint
      );
      create index studio_jobs_account on studio_jobs (account, created_at desc);
      create index studio_jobs_day on studio_jobs (created_at);
      create index studio_jobs_running on studio_jobs (created_at) where status = 'running';
    `,
  },
  {
    version: 13,
    name: "rats",
    sql: /* sql */ `
      -- The depot's rats (ERC-721, public owners): a read model, rebuilt by a replay. The Rats
      -- contract is newer than every block indexed so far, so nothing needs reading again.
      create table rats (
        token_id integer primary key,
        kind text not null check (kind in ('seed', 'model')),
        -- The seed in decimal, or the studio job's bytes32.
        ref text not null,
        uri text,
        owner text not null,
        minter text not null,
        minted_block bigint not null,
        minted_at bigint
      );
      create index rats_owner on rats (owner);
      create index rats_ref on rats (ref);
      -- Paid shakes by account: a rat's sniffs are its owner's. A fold of the Shaken events, so it
      -- starts from those already recorded.
      create table rat_sniffers (
        account text primary key,
        sniffs bigint not null
      );
      insert into rat_sniffers (account, sniffs)
        select data->>'viewer', count(*) from events
        where name = 'Shaken' and (data->>'paid')::boolean
        group by data->>'viewer';
      -- AI rats' picture and record once on Arweave, by studio job. Not on the chain: a replay
      -- keeps it, and a second adoption signs again without uploading again.
      create table rat_adoptions (
        job_id text primary key,
        job_ref text not null unique,
        account text not null,
        prompt text not null,
        image_id text not null,
        record_id text not null,
        created_at bigint not null
      );
      -- AI rats' 3D models (GLB): kept here and served by the API, like the cats' meshes are
      -- rebuilt by the app, rather than paid for on Arweave. In the nightly dump.
      create table rat_models (
        job_ref text primary key,
        glb bytea not null,
        created_at bigint not null
      );
    `,
  },
  {
    version: 14,
    name: "capped rats",
    sql: /* sql */ `
      -- Rats and RatPantry were deployed again with the caps (block 11845258). Rats are keyed by
      -- token id, so the first contract's rats would collide with the new one's: forget them, and
      -- read again from the new deployment (events already stored are skipped, not projected twice).
      delete from events where source in ('rats', 'ratPantry');
      delete from rats;
      update sync_state set block = least(block, 11845257);
    `,
  },
  {
    version: 15,
    name: "mainnet allow list claims",
    sql: /* sql */ `
      -- Players who claimed a place on the mainnet allow list, with the best points they had.
      -- Not on the chain's index: a replay or a test network redeployment keeps them.
      create table allow_list_claims (
        address text primary key,
        points integer not null,
        message text not null,
        signature text not null,
        claimed_at bigint not null,
        updated_at bigint not null
      );
    `,
  },
  {
    version: 16,
    name: "x boarding passes",
    sql: /* sql */ `
      -- X boarding passes: an X account proved by a post carrying the pass code, a declared follow,
      -- and the wallet the player chose to link (private). Not on the chain's index: a replay or a
      -- test network redeployment keeps them.
      create table x_passes (
        id text primary key,
        code text not null unique,
        handle text unique,
        tweet_id text unique,
        tweet_url text,
        followed_at bigint,
        address text unique,
        created_at bigint not null,
        verified_at bigint,
        updated_at bigint not null
      );
    `,
  },
  {
    version: 17,
    name: "x boarding pass tasks",
    sql: /* sql */ `
      -- The tasks on X a pass asks for besides the follow: like, reply to and repost the
      -- announcement. Declared by the player, checked by hand before mainnet.
      alter table x_passes add column liked_at bigint, add column replied_at bigint, add column reposted_at bigint;
    `,
  },
  {
    version: 18,
    name: "sign in with x",
    sql: /* sql */ `
      -- Sign in with X gives the account's id, which outlives a change of handle; the boarding
      -- tweet becomes a declared task like the others.
      alter table x_passes add column x_user_id text unique, add column posted_at bigint;
    `,
  },
  {
    version: 19,
    name: "suggestion box",
    sql: /* sql */ `
      -- Ideas left in the boarding page's suggestion box, read by the team only. The handle comes
      -- from the player's own boarding pass. Not on the chain's index: a replay keeps them.
      create table ideas (
        id serial primary key,
        text text not null unique,
        handle text,
        locale text not null,
        created_at bigint not null
      );
    `,
  },
  {
    version: 20,
    name: "gift rats",
    sql: /* sql */ `
      -- A rat the whitelist's gifts handed out (RatMinted with nothing paid): outside the paid
      -- rats' caps and the wallet limit. A fold of RatMinted like the rest of the table.
      alter table rats add column gift boolean not null default false;
    `,
  },
];
