import pg from "pg";
import { afterAll, describe } from "vitest";
import { silentLogger } from "../src/application/ports/logger";
import { migrate } from "../src/infrastructure/db/migrate";
import { PgStore } from "../src/infrastructure/db/PgStore";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { storeContract } from "./storeContract";

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

  storeContract("postgres", async () => {
    if (!migrated) {
      await pool.query("drop schema public cascade; create schema public");
      await migrate(pool, silentLogger);
      // Applied once only: a second run finds nothing to do.
      if ((await migrate(pool, silentLogger)) !== 0) throw new Error("migrations ran twice");
      migrated = true;
    }
    const tables = (await pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'")).rows;
    await pool.query(`truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")}`);
    return new PgStore(pool);
  });
});
