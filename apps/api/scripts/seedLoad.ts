/**
 * Fills a Postgres with a synthetic but consistent index, for the load test (loadtest/): a
 * collection a few weeks into its sale, with mints, openings, pairs, duels, requests, the pantry
 * and rats. Nothing touches the chain: the events come from a made-up source and go through the
 * real migrations, `SyncChain` and projector, so every read model agrees with the events table.
 *
 *   DATABASE_URL=postgres://dno:dno@localhost:5432/dno pnpm --filter @dno/api seed:load
 *
 * Deterministic: the same SEED_* values give the same index. Refuses a database that already
 * holds events, so it never mixes with a real index.
 */
import pg from "pg";
import pino from "pino";
import { spec } from "@dno/game-spec";
import type { ChainBatch, ChainSource } from "../src/application/ports/chain";
import { SyncChain } from "../src/application/syncChain";
import { emptySnapshots, type EventName, type EventOf, type ProtocolEvent, type Snapshots } from "../src/domain/events";
import type { Address, RequestKind } from "../src/domain/types";
import { migrate } from "../src/infrastructure/db/migrate";
import { PgStore } from "../src/infrastructure/db/PgStore";

const env = (name: string, fallback: number) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
};

const BOXES = env("SEED_BOXES", 4000);
const PLAYERS = env("SEED_PLAYERS", 600);
const OPENED = env("SEED_OPENED_SHARE", 0.3);
const DUELS = env("SEED_DUELS", 400);
const RATS = env("SEED_RATS", 150);
const PRNG_SEED = env("SEED_PRNG", 42);
/** A plausible Sepolia height, so blocks look like the real index's. */
const FIRST_BLOCK = env("SEED_FIRST_BLOCK", 9_000_000);
/** Blocks one SyncChain pass covers: each pass is one transaction. */
const BLOCKS_PER_PASS = 2_000;

/** mulberry32, as the generator uses: the same seed, the same index. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(PRNG_SEED);
const int = (n: number) => Math.floor(rand() * n);
const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
const hex = (bytes: number) => `0x${Array.from({ length: bytes * 2 }, () => int(16).toString(16)).join("")}`;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
/** Player addresses are fixed by their index, so the load test can name them (loadtest/api.js). */
export const playerAddress = (i: number) => `0x${(0xd0000000 + i).toString(16).padStart(40, "0")}` as Address;
const players = Array.from({ length: PLAYERS }, (_, i) => playerAddress(i));

type Body<N extends EventName> = Omit<EventOf<N>, "name" | "source" | "block" | "blockHash" | "timestamp" | "txHash" | "logIndex">;

const SOURCES: Partial<Record<EventName, ProtocolEvent["source"]>> = {
  MealServed: "pantry", WelcomeBag: "pantry", Purred: "pantry", Claimed: "pantry", WeighInRequested: "pantry", Weighed: "pantry",
  RatMinted: "rats", RatTransfer: "rats",
};

/** The chain being written: a block every few events, twelve seconds apart. */
const events: ProtocolEvent[] = [];
const snapshots: Snapshots = emptySnapshots();
let block = FIRST_BLOCK;
let logIndex = 0;
let tx = 0;

function emit<N extends EventName>(name: N, body: Body<N>) {
  if (rand() < 0.35) {
    block += 1 + int(3);
    logIndex = 0;
  }
  tx++;
  events.push({
    name,
    source: SOURCES[name] ?? "collection",
    block,
    blockHash: `0x${block.toString(16).padStart(64, "0")}`,
    timestamp: 1_790_000_000 + (block - FIRST_BLOCK) * 12,
    txHash: `0x${tx.toString(16).padStart(64, "0")}`,
    logIndex: logIndex++,
    ...body,
  } as EventOf<N>);
}

let requestId = 0;
function request(kind: RequestKind, tokenId: number, requester: Address, other: number | null, status: "done" | "refused" | null) {
  const id = ++requestId;
  snapshots.requests.set(id, { kind, status: status ?? "pending", requester, tokenId, other });
  emit("RequestPlaced", { requestId: id, tokenId, requester, kind });
  if (status) emit("RequestSettled", { requestId: id, status });
  return id;
}

// --- the sale: mints in batches of 1 to 10, each box handed to its buyer ---
const holder: Address[] = [];
const milestones = spec.collection.milestones as number[];
let minted = 0;
let milestone = 0;
while (minted < BOXES) {
  const buyer = pick(players);
  const count = Math.min(1 + int(10), BOXES - minted);
  emit("MintPlaced", { firstTokenId: minted, buyer, count });
  for (let id = minted; id < minted + count; id++) {
    holder[id] = buyer;
    emit("ConfidentialTransfer", { tokenId: id, from: ZERO, to: buyer, moved: hex(32) });
    if (rand() < 0.6) emit("WelcomeBag", { tokenId: id });
  }
  minted += count;
  while (milestone < milestones.length && minted >= milestones[milestone]!) {
    emit("MilestoneReached", { index: milestone, sold: milestones[milestone]! });
    milestone++;
  }
  // Life between the mints: shakes, meals, a few boxes changing hands.
  for (let k = 0; k < 3; k++) {
    const id = int(minted);
    const r = rand();
    if (r < 0.4) emit("Shaken", { tokenId: id, viewer: holder[id]!, paid: rand() < 0.2 });
    else if (r < 0.7) emit("MealServed", { tokenId: id, feeder: holder[id]! });
    else if (r < 0.8) emit("Fed", { tokenId: id, feeder: holder[id]! });
    else if (r < 0.9) {
      const to = pick(players);
      emit("ConfidentialTransfer", { tokenId: id, from: holder[id]!, to, moved: hex(32) });
      holder[id] = to;
    }
  }
}

// --- pairs: proposed, then mostly linked through an entangle request ---
const sealed = new Set(Array.from({ length: BOXES }, (_, i) => i));
const partner = new Map<number, number>();
for (let k = 0; k < Math.floor(BOXES * 0.08); k++) {
  const a = int(BOXES);
  const b = int(BOXES);
  if (a === b || partner.has(a) || partner.has(b)) continue;
  emit("EntangleProposed", { tokenA: a, tokenB: b, proposer: holder[a]! });
  if (rand() < 0.75) {
    request("entangle", a, holder[a]!, b, "done");
    emit("Entangled", { tokenA: a, tokenB: b });
    partner.set(a, b);
    partner.set(b, a);
  }
}

// --- duels: on the shelf, under way, settled, called off ---
const shelfUntil = 1_790_000_000 + 365 * 86_400 * 10;
for (let duelId = 1; duelId <= DUELS; duelId++) {
  const a = int(BOXES);
  const reserved = rand() < 0.25;
  let b = int(BOXES);
  if (b === a) b = (a + 1) % BOXES;
  emit("DuelPosted", { duelId, tokenA: a, tokenB: b, challenger: holder[a]!, reserved });
  const fate = rand();
  if (fate < 0.25) {
    emit("DuelOpened", { duelId, openUntil: shelfUntil });
  } else if (fate < 0.35) {
    emit("DuelCancelled", { duelId });
  } else {
    emit("DuelAccepted", { duelId, tokenB: b, accepter: holder[b]! });
    if (fate < 0.45) continue;
    if (fate < 0.5) {
      emit("DuelVoided", { duelId });
      continue;
    }
    const [winner, loser] = rand() < 0.5 ? [a, b] : [b, a];
    emit("DuelResolved", { duelId, winner, loser, traitIndex: int(8), roll: int(100) });
  }
}

// --- openings: a request, its proof, the cat; some proved alive first ---
for (let id = 0; id < BOXES; id++) {
  if (rand() >= OPENED) continue;
  const who = holder[id]!;
  if (rand() < 0.2) {
    request("aliveCheck", id, who, null, "done");
    emit("AliveProven", { tokenId: id, alive: rand() < 0.7 });
  }
  request("open", id, who, null, "done");
  emit("Observed", { tokenId: id, openedBy: who, seed: BigInt(hex(8)).toString(), state: int(2), score: 100 + int(900), golden: rand() < 0.01 });
  sealed.delete(id);
  if (rand() < 0.1) {
    emit("WeighInRequested", { tokenId: id });
    emit("Weighed", { tokenId: id, weight: String(3000 + int(4000)), build: int(5), sick: rand() < 0.1, disease: int(3) });
  }
}

// --- proofs still waiting, and a few refused (a non-holder asked) ---
for (let k = 0; k < Math.max(5, Math.floor(BOXES / 200)); k++) {
  const id = pick([...sealed].slice(0, 500));
  request(pick(["open", "aliveCheck"] as const), id, holder[id]!, null, rand() < 0.3 ? "refused" : null);
}

// --- rats: adopted from the studio's seeds, a few passed on ---
for (let ratId = 1; ratId <= RATS; ratId++) {
  const minter = pick(players);
  emit("RatMinted", { ratId, minter, kind: "seed", ref: String(int(2 ** 31)), uri: "", paid: "1000000" });
  emit("RatTransfer", { ratId, from: ZERO, to: minter });
  if (rand() < 0.1) emit("RatTransfer", { ratId, from: minter, to: pick(players) });
}
emit("Claimed", { caller: pick(players), boxes: 3 });

/** The made-up chain, read back by blocks like an RPC would be. */
const head = block;
const source: ChainSource = {
  head: async () => head,
  finalized: async () => head,
  read: async (from, to): Promise<ChainBatch> => ({
    to,
    events: events.filter((e) => e.block >= from && e.block <= to),
    snapshots,
    servedBy: ["seed"],
  }),
  eventsOf: async () => ({ events: [], snapshots: emptySnapshots() }),
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("set DATABASE_URL");
  const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    await migrate(pool, log);
    const held = await pool.query<{ n: string }>("select count(*) as n from events");
    if (Number(held.rows[0]!.n) > 0) throw new Error("this database already holds events: seed an empty one");

    const store = new PgStore(pool);
    const sync = new SyncChain(source, store, { startBlock: FIRST_BLOCK, confirmations: 0, rescan: 0, maxBlocksPerPass: BLOCKS_PER_PASS }, log);
    const started = Date.now();
    let applied = 0;
    for (let r = await sync.pass(); r; r = await sync.pass()) applied += r.applied;
    await store.transaction((t) => t.setFinalizedCursor(head));
    console.log(
      JSON.stringify({ boxes: BOXES, players: PLAYERS, events: applied, duels: DUELS, rats: RATS, requests: requestId, blocks: [FIRST_BLOCK, head], seconds: (Date.now() - started) / 1000 }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
