import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { silentLogger } from "../src/application/ports/logger";
import { migrate } from "../src/infrastructure/db/migrate";
import { PgStore } from "../src/infrastructure/db/PgStore";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { storeContract } from "./storeContract";
import { ALICE, ev } from "./fixtures";

storeContract("memory", async () => new MemoryStore());

/**
 * Against a real Postgres when TEST_DATABASE_URL is set (CI gives one). The database is wiped
 * before each test: never point this at one that matters.
 */
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("postgres", () => {
  const pool = new pg.Pool({ connectionString: url });
  let migrated = false;
  afterAll(() => pool.end());

  const makeStore = async () => {
    if (!migrated) {
      await pool.query("drop schema if exists testnet cascade; drop schema public cascade; create schema public");
      await migrate(pool, silentLogger);
      // Applied once only: a second run finds nothing to do.
      if ((await migrate(pool, silentLogger)) !== 0) throw new Error("migrations ran twice");
      migrated = true;
    }
    const tables = (await pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'")).rows;
    await pool.query(`truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")}`);
    await pool.query("truncate testnet.x_passes, testnet.allow_list_claims, testnet.ideas");
    return new PgStore(pool);
  };
  storeContract("postgres", makeStore);

  it("gives the testnet site's API its own lists over the shared index (LISTS_SCHEMA)", async () => {
    const live = await makeStore();
    const testnetPool = new pg.Pool({ connectionString: url, options: "-c search_path=testnet,public" });
    try {
      const testnet = new PgStore(testnetPool);
      const pass = { id: "t1", code: "DNO-TESTNT", handle: "tester", xUserId: null, tweetId: null, tweetUrl: null, followedAt: 1, postedAt: null, likedAt: null, repliedAt: null, repostedAt: null, address: null, discordUserId: null, discordJoinedAt: null, createdAt: 1, verifiedAt: null, updatedAt: 1 };
      await testnet.saveXPass(pass);
      await testnet.saveAllowListClaim({ address: ALICE, points: 1, message: "m", signature: "s", claimedAt: 1, updatedAt: 1 });
      await testnet.saveIdea({ text: "only on the testnet", handle: null, locale: "en", createdAt: 1 });
      // The live lists never see them.
      expect(await live.xPasses()).toEqual([]);
      expect(await live.allowListClaims()).toEqual([]);
      expect(await live.ideaCount()).toBe(0);
      expect((await testnet.xPasses()).map((p) => p.code)).toEqual(["DNO-TESTNT"]);
      expect(await testnet.ideaCount()).toBe(1);
      // The chain's index, written once by the live indexer, is read by both.
      await live.transaction((tx) => tx.insertEvent(ev("MintPlaced", 7, { firstTokenId: 0, buyer: ALICE, count: 2 }), null));
      expect((await testnet.activity({ limit: 5 })).map((e) => e.name)).toEqual(["MintPlaced"]);
    } finally {
      await testnetPool.end();
    }
  });
});
