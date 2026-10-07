import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { silentLogger } from "../src/application/ports/logger";
import { listenForNudges, nudgeOver } from "../src/infrastructure/db/nudges";

/** An API replica's nudge reaches the indexer in another process, over Postgres. */
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("nudges over postgres", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());

  it("wakes the listener for each nudge", async () => {
    let woken = 0;
    const stop = listenForNudges(url!, () => woken++, silentLogger);
    const nudge = nudgeOver(pool, silentLogger);
    // The listener connects in the background: nudge until it hears one.
    for (let i = 0; i < 50 && woken === 0; i++) {
      nudge();
      await new Promise((r) => setTimeout(r, 50));
    }
    await stop();
    expect(woken).toBeGreaterThan(0);
  });
});
