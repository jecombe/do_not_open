import type { Pool } from "pg";
import type { Logger } from "../../application/ports/logger";
import { MIGRATIONS } from "./migrations";

/** Any number: the lock that keeps two starting instances from migrating at once. */
const MIGRATION_LOCK = 724_001;

/** Applies the migrations this database has not seen yet, each in its own transaction. */
export async function migrate(pool: Pool, log: Logger): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("create table if not exists schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())");
    const done = new Set((await client.query<{ version: number }>("select version from schema_migrations")).rows.map((r) => r.version));
    let applied = 0;
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into schema_migrations (version, name) values ($1, $2)", [m.version, m.name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      log.info({ version: m.version, name: m.name }, "migrated");
      applied++;
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
