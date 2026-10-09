import { describe, expect, it } from "vitest";
import { Insights } from "../src/application/insights";
import { Seats } from "../src/application/seats";
import { VaultRelay, VaultRelayRefused } from "../src/application/vaultRelay";
import type { VaultFinalizeTx, VaultRequestTx, VaultSender } from "../src/application/ports/vault";
import { summarizeVault } from "../src/domain/vault";
import { Metrics } from "../src/infrastructure/http/metrics";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ALICE, ev } from "./fixtures";

const DAY = 86_400;
const NOW = 20_010 * DAY + 12 * 3600;
const NFT = "0x00000000000000000000000000000000000000f7";
const ETH = 10n ** 18n;

/** Three boxes: one sold on Seaport and collected, one withdrawn, one still sealed with a private sale open. */
const history = () => [
  ev("VaultDeposited", 10, { boxId: 0, collection: NFT, nftTokenId: "1" }, { timestamp: NOW - 3 * DAY }),
  ev("VaultDeposited", 11, { boxId: 1, collection: NFT, nftTokenId: "2" }, { timestamp: NOW - 2 * DAY }),
  ev("VaultDeposited", 12, { boxId: 2, collection: ALICE, nftTokenId: "3" }, { timestamp: NOW - 3600 }),
  ev("VaultRequestPlaced", 13, { requestId: 0, boxId: 0, action: "list" }, { timestamp: NOW - 2 * DAY }),
  ev("VaultRequestSettled", 14, { requestId: 0, status: "done" }, { timestamp: NOW - 2 * DAY }),
  ev("VaultListed", 14, { listingId: 0, boxId: 0, price: String(ETH / 2n), endTime: NOW + DAY }, { timestamp: NOW - 2 * DAY, logIndex: 1 }),
  ev("VaultSoldOnSeaport", 15, { listingId: 0, boxId: 0, price: String(ETH / 2n) }, { timestamp: NOW - DAY }),
  ev("VaultClaimed", 16, { boxId: 0, amount: String((ETH / 2n) * 975n / 1000n) }, { timestamp: NOW - 600 }),
  ev("VaultWithdrawn", 17, { boxId: 1 }, { timestamp: NOW - 500 }),
  ev("VaultSaleOffered", 18, { saleId: 0, boxId: 2 }, { timestamp: NOW - 400 }),
  ev("VaultRequestPlaced", 19, { requestId: 1, boxId: 2, action: "withdraw" }, { timestamp: NOW - 300 }),
];

describe("the vault's summary", () => {
  it("folds its public events into states, sales and requests", () => {
    const s = summarizeVault(history());
    expect(s.boxes).toEqual({ sealed: 1, listed: 0, sold: 0, withdrawn: 1, claimed: 1 });
    expect(s).toMatchObject({ deposits: 3, withdrawals: 1, listings: 1, listed: 0, seaportSales: 1, seaportVolume: String(ETH / 2n) });
    expect(s.privateSales).toEqual({ offered: 1, settled: 0, cancelled: 0, open: 1 });
    expect(s.requests).toEqual({ placed: { withdraw: 1, list: 1, unlist: 0, claim: 0 }, settled: { done: 1, refused: 0, stale: 0 }, pending: 1 });
    expect(s.collections).toEqual([
      { collection: NFT, deposits: 2, inVault: 0 },
      { collection: ALICE, deposits: 1, inVault: 1 },
    ]);
  });

  it("is on the admin site by day, and kept out of the game's public feed", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      for (const e of history()) await tx.insertEvent(e, null);
      await tx.insertEvent(ev("MintPlaced", 20, { firstTokenId: 0, buyer: ALICE, count: 1 }, { timestamp: NOW - 60 }), null);
    });
    expect((await store.activity({ limit: 50 })).map((e) => e.name)).toEqual(["MintPlaced"]);
    const insights = new Insights(store, new Seats(store, 10, async () => new Set(), ["follow"]), { now: () => NOW });
    const v = await insights.vault(7);
    expect(v.summary.deposits).toBe(3);
    expect(v.kpis.find((k) => k.key === "deposits")).toMatchObject({ total: 3, today: 1, last7: 3 });
    expect(v.daily.at(-1)).toMatchObject({ deposits: 1, withdrawals: 1, privateSales: 0, requests: 1 });
    expect(v.recent[0]).toMatchObject({ name: "VaultRequestPlaced", boxId: 2, detail: "withdraw" });
  });
});

class Sender implements VaultSender {
  readonly address = ALICE;
  async request(tx: VaultRequestTx) {
    if (tx.boxId === 666) throw new VaultRelayRefused("reverted", "no");
    return "0x01";
  }
  async finalize(_tx: VaultFinalizeTx): Promise<string> {
    throw new Error("node down");
  }
  async balance() {
    return 3n * 10n ** 16n;
  }
}

describe("the vault's metrics", () => {
  it("reports the index's counts and the relayer's wallet, day and outcomes", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      for (const e of history()) await tx.insertEvent(e, null);
    });
    const relay = new VaultRelay(new Sender(), { now: () => NOW }, 2);
    const req = { boxId: 2, action: 0, to: ALICE, price: 0n, endTime: 0, handle: "0x" + "ab".repeat(32), inputProof: "0x" };
    await relay.request(req);
    await expect(relay.request({ ...req, boxId: 666 })).rejects.toBeInstanceOf(VaultRelayRefused);
    await expect(relay.finalize({ requestId: 1, cleartexts: "0x", proof: "0x" })).rejects.toThrow("node down");
    const text = await new Metrics({ vault: store, vaultRelay: relay, info: { chain: "sepolia", collection: ALICE, version: "t", role: "all" } }).render();
    expect(text).toContain('dno_vault_boxes{state="sealed"} 1');
    expect(text).toContain("dno_vault_deposits 3");
    expect(text).toContain("dno_vault_seaport_volume_eth 0.5");
    expect(text).toContain('dno_vault_private_sales{status="open"} 1');
    expect(text).toContain("dno_vault_requests_pending 1");
    expect(text).toContain("dno_vault_relayer_balance_eth 0.03");
    expect(text).toContain("dno_vault_relayer_sent_today 1");
    expect(text).toContain("dno_vault_relayer_daily_cap 2");
    expect(text).toContain('dno_vault_relays_total{kind="request",outcome="sent"} 1');
    expect(text).toContain('dno_vault_relays_total{kind="request",outcome="reverted"} 1');
    expect(text).toContain('dno_vault_relays_total{kind="finalize",outcome="failed"} 1');
  });
});
