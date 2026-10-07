import pg, { type Pool } from "pg";
import type { Logger } from "../../application/ports/logger";

/** The channel an API replica nudges the indexer on: a transaction was just mined, read the chain now. */
const CHANNEL = "dno_nudge";

/** Asks the indexer, in whichever process it runs, for a pass. Losing one is harmless: it polls anyway. */
export function nudgeOver(pool: Pool, log: Logger): () => void {
  return () => {
    pool.query(`notify ${CHANNEL}`).catch((error) => log.warn({ err: error }, "nudge not sent"));
  };
}

/**
 * Listens for nudges on a connection of its own, kept open: reconnects after a drop, from one
 * second up to a minute apart. Returns a stop function.
 */
export function listenForNudges(connectionString: string, onNudge: () => void, log: Logger): () => Promise<void> {
  let client: pg.Client | null = null;
  let stopped = false;
  let retryMs = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString });
    c.on("notification", () => onNudge());
    c.on("error", (error) => {
      log.warn({ err: error }, "nudge listener dropped");
      c.end().catch(() => undefined);
      if (client === c) client = null;
      retry();
    });
    try {
      await c.connect();
      await c.query(`listen ${CHANNEL}`);
      client = c;
      retryMs = 1000;
    } catch (error) {
      log.warn({ err: error }, "nudge listener could not connect");
      c.end().catch(() => undefined);
      retry();
    }
  };
  const retry = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  };

  void connect();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await client?.end().catch(() => undefined);
  };
}
