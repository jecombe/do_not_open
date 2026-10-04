import { describe, expect, it } from "vitest";
import { studio as spec } from "@dno/game-spec";
import { silentLogger } from "../src/application/ports/logger";
import { StudioRejected, type ImageGenerator, type ModelGenerator } from "../src/application/ports/studio";
import { Studio, StudioRefused, type StudioConfig } from "../src/application/studio";
import { SyncChain } from "../src/application/syncChain";
import { refusedWord } from "../src/domain/studio";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ALICE, BOB, ev, FakeChain } from "./fixtures";

/** A service that answers when told to, or fails. */
class FakeService implements ImageGenerator, ModelGenerator {
  calls: string[] = [];
  fail = false;
  flag = false;
  private gates: (() => void)[] = [];
  hold = false;

  async sketch(styled: string) {
    return this.answer(`sketch:${styled}`, "https://files/sketch.png");
  }

  async model(imageUrl: string) {
    return this.answer(`model:${imageUrl}`, "https://files/cat.glb");
  }

  release() {
    for (const g of this.gates.splice(0)) g();
  }

  private async answer(call: string, url: string) {
    this.calls.push(call);
    if (this.hold) await new Promise<void>((r) => this.gates.push(r));
    if (this.flag) throw new StudioRejected("flagged");
    if (this.fail) throw new Error("service down");
    return { url };
  }
}

let ids = 0;
function setup(over: Partial<StudioConfig> = {}) {
  const store = new MemoryStore();
  const service = new FakeService();
  const clock = { t: 1_790_000_000, now() { return this.t; } };
  const cfg: StudioConfig = {
    enabled: true,
    paused: false,
    dailyBudgetUsd: 20,
    allowlist: null,
    staleAfter: 600,
    refundsPerDay: 3,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    ...over,
  };
  const studio = new Studio(store, service, service, clock, cfg, silentLogger);
  const buy = (account: string, sketches: number, models: number) => store.transaction((tx) => tx.addStudioUnits(account, sketches, models));
  return { store, service, clock, studio, buy };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StudioRefused) return { code: e.code, reason: e.reason };
    throw e;
  }
  throw new Error("not refused");
};

describe("studio", () => {
  it("spends a unit when a sketch starts, and keeps it once the service drew the cat", async () => {
    const { studio, service, buy } = setup();
    await buy(ALICE, 10, 1);
    const job = await studio.sketch(ALICE, "  a  round orange cat ");
    expect(job).toMatchObject({ kind: "sketch", status: "running", prompt: "a round orange cat", costUsd: Number(spec.units.sketch.estimatedCostUsd) });
    expect((await studio.credits(ALICE)).sketches).toEqual({ bought: 10, used: 1, left: 9 });
    await studio.idle();
    // The player's words go inside the house style.
    expect(service.calls[0]).toContain("A single funny cartoon rat character, a round orange cat.");
    expect(await studio.job(ALICE, job.id)).toMatchObject({ status: "done", resultUrl: "https://files/sketch.png" });
    expect((await studio.credits(ALICE)).sketches.left).toBe(9);
  });

  it("gives the unit back when the service fails", async () => {
    const { studio, service, buy } = setup();
    await buy(ALICE, 1, 0);
    service.fail = true;
    const job = await studio.sketch(ALICE, "a cat");
    await studio.idle();
    expect(await studio.job(ALICE, job.id)).toMatchObject({ status: "failed", resultUrl: null });
    expect((await studio.credits(ALICE)).sketches).toEqual({ bought: 1, used: 0, left: 1 });
  });

  it("gives units back for a few failures a day, then keeps them: one unit cannot bill the collection without end", async () => {
    const { studio, service, clock, buy } = setup({ refundsPerDay: 2 });
    await buy(ALICE, 1, 0);
    service.fail = true;
    for (let i = 0; i < 2; i++) {
      await studio.sketch(ALICE, "a cat");
      await studio.idle();
    }
    expect((await studio.credits(ALICE)).sketches.left).toBe(1);
    const third = await studio.sketch(ALICE, "a cat");
    await studio.idle();
    expect(await studio.job(ALICE, third.id)).toMatchObject({ status: "rejected" });
    expect((await studio.credits(ALICE)).sketches.left).toBe(0);
    expect(await refusal(studio.sketch(ALICE, "a cat"))).toEqual({ code: "no-credits", reason: null });
    // A new day brings the refunds back.
    await buy(ALICE, 1, 0);
    clock.t += 86_400;
    const next = await studio.sketch(ALICE, "a cat");
    await studio.idle();
    expect(await studio.job(ALICE, next.id)).toMatchObject({ status: "failed" });
  });

  it("keeps the unit of a picture the safety checker refused", async () => {
    const { studio, service, buy } = setup();
    await buy(ALICE, 1, 0);
    service.flag = true;
    const job = await studio.sketch(ALICE, "a cat");
    await studio.idle();
    expect(await studio.job(ALICE, job.id)).toMatchObject({ status: "rejected", resultUrl: null });
    expect((await studio.credits(ALICE)).sketches.left).toBe(0);
  });

  it("counts failed jobs in the day's budget: the service may have billed them", async () => {
    const cost = Number(spec.units.sketch.estimatedCostUsd);
    const { studio, service, buy } = setup({ dailyBudgetUsd: cost * 2, refundsPerDay: 10 });
    await buy(ALICE, 5, 0);
    service.fail = true;
    for (let i = 0; i < 2; i++) {
      await studio.sketch(ALICE, "a cat");
      await studio.idle();
    }
    expect(await refusal(studio.sketch(ALICE, "a cat"))).toEqual({ code: "studio-paused", reason: "budget" });
    expect((await studio.credits(ALICE)).sketches.left).toBe(5);
  });

  it("never spends the last unit twice", async () => {
    const { studio, service, buy } = setup();
    await buy(ALICE, 1, 0);
    service.hold = true;
    const results = await Promise.allSettled([studio.sketch(ALICE, "cat one"), studio.sketch(ALICE, "cat two"), studio.sketch(ALICE, "cat three")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => ((r as PromiseRejectedResult).reason as StudioRefused).code)).toEqual(["no-credits", "no-credits"]);
    service.release();
    await studio.idle();
    expect(service.calls).toHaveLength(1);
  });

  it("refuses without a pack, and checks the prompt before spending anything", async () => {
    const { studio, buy } = setup();
    expect(await refusal(studio.sketch(BOB, "a cat"))).toEqual({ code: "no-credits", reason: null });
    await buy(BOB, 5, 0);
    expect(await refusal(studio.sketch(BOB, "ca"))).toMatchObject({ code: "bad-prompt" });
    expect(await refusal(studio.sketch(BOB, "x".repeat(spec.prompt.maxLength + 1)))).toMatchObject({ code: "bad-prompt" });
    expect(await refusal(studio.sketch(BOB, 42))).toMatchObject({ code: "bad-prompt" });
    expect(await refusal(studio.sketch(BOB, "Pikachu as a cat"))).toMatchObject({ code: "refused-prompt" });
    expect(await refusal(studio.sketch(BOB, "a NSFW cat"))).toMatchObject({ code: "refused-prompt" });
    expect((await studio.credits(BOB)).sketches.used).toBe(0);
  });

  it("matches refused words whole, whatever the case and accents", () => {
    expect(refusedWord("Un chat façon Hello Kitty")).toBe("hello kitty");
    expect(refusedWord("a cat named Mário")).toBe("mario");
    expect(refusedWord("a cat in Marioland")).toBeNull();
    expect(refusedWord("Remy from Ratatouille, cooking")).toBe("remy");
    expect(refusedWord("a ninja rat like Splinter")).toBe("splinter");
    expect(refusedWord("a sexton cat in a bell tower")).toBeNull();
    expect(refusedWord("a fluffy grey cat")).toBeNull();
  });

  it("turns only the account's own finished sketch into a model", async () => {
    const { studio, service, buy } = setup();
    await buy(ALICE, 2, 1);
    await buy(BOB, 0, 1);
    service.hold = true;
    const sketch = await studio.sketch(ALICE, "a cat in a raincoat");
    expect(await refusal(studio.model(ALICE, sketch.id))).toMatchObject({ code: "not-found" });
    service.release();
    await studio.idle();
    expect(await refusal(studio.model(BOB, sketch.id))).toMatchObject({ code: "not-found" });
    expect(await refusal(studio.model(ALICE, "00000000-0000-4000-8000-999999999999"))).toMatchObject({ code: "not-found" });
    service.hold = false;
    const model = await studio.model(ALICE, sketch.id);
    expect(model).toMatchObject({ kind: "model", sketchId: sketch.id, prompt: "a cat in a raincoat" });
    await studio.idle();
    expect(service.calls.at(-1)).toBe("model:https://files/sketch.png");
    expect(await studio.fileOf(model.id, "model")).toBe("https://files/cat.glb");
    // A model's picture is its sketch's.
    expect(await studio.fileOf(model.id, "image")).toBe("https://files/sketch.png");
    expect(await studio.fileOf(sketch.id, "model")).toBeNull();
    expect((await studio.credits(ALICE)).models).toEqual({ bought: 1, used: 1, left: 0 });
    expect(await refusal(studio.model(ALICE, sketch.id))).toMatchObject({ code: "no-credits" });
  });

  it("stops at the day's budget, and starts again the next day", async () => {
    const sketchCost = Number(spec.units.sketch.estimatedCostUsd);
    const { studio, clock, buy } = setup({ dailyBudgetUsd: sketchCost * 2 });
    await buy(ALICE, 10, 0);
    await studio.sketch(ALICE, "cat one");
    await studio.sketch(ALICE, "cat two");
    await studio.idle();
    expect(await refusal(studio.sketch(ALICE, "cat three"))).toEqual({ code: "studio-paused", reason: "budget" });
    expect((await studio.info(ALICE)).paused).toBe("budget");
    expect((await studio.credits(ALICE)).sketches.left).toBe(8);
    clock.t += 86_400;
    expect((await studio.info(ALICE)).paused).toBeNull();
    await studio.sketch(ALICE, "cat three");
  });

  it("opens to the testers' list only, when there is one", async () => {
    const { studio, buy } = setup({ allowlist: new Set([ALICE]) });
    await buy(ALICE, 1, 0);
    await buy(BOB, 1, 0);
    expect(await refusal(studio.sketch(BOB, "a cat"))).toMatchObject({ code: "not-allowlisted" });
    await studio.sketch(ALICE, "a cat");
    expect((await studio.info(BOB)).allowlisted).toBe(false);
    expect((await studio.info(ALICE)).allowlisted).toBe(true);
    expect((await studio.info(null)).allowlisted).toBeNull();
  });

  it("sells nothing while disabled or switched off", async () => {
    const off = setup({ enabled: false });
    await off.buy(ALICE, 1, 0);
    expect(await refusal(off.studio.sketch(ALICE, "a cat"))).toEqual({ code: "studio-paused", reason: "disabled" });
    expect(await off.studio.info(null)).toMatchObject({ enabled: false, paused: null });
    const paused = setup({ paused: true });
    await paused.buy(ALICE, 1, 0);
    expect(await refusal(paused.studio.sketch(ALICE, "a cat"))).toEqual({ code: "studio-paused", reason: "off" });
    expect((await paused.studio.info(null)).paused).toBe("off");
    expect((await paused.studio.info(null)).packs).toEqual(spec.packs.map((p) => ({ id: p.id, key: p.key, name: p.name, priceUsdc: p.priceUsdc, sketches: p.sketches, models: p.models })));
  });

  it("gives back the unit of a job a crash left running", async () => {
    const { studio, service, clock, buy } = setup();
    await buy(ALICE, 1, 0);
    service.hold = true;
    const job = await studio.sketch(ALICE, "a cat");
    clock.t += 601;
    expect((await studio.credits(ALICE)).sketches.left).toBe(1);
    expect(await studio.job(ALICE, job.id)).toMatchObject({ status: "failed" });
    // The service answering late changes nothing.
    service.release();
    await studio.idle();
    expect(await studio.job(ALICE, job.id)).toMatchObject({ status: "failed" });
  });

  it("only shows an account its own jobs", async () => {
    const { studio, buy } = setup();
    await buy(ALICE, 1, 0);
    const job = await studio.sketch(ALICE, "a cat");
    await studio.idle();
    expect(await refusal(studio.job(BOB, job.id))).toMatchObject({ code: "not-found" });
    expect((await studio.jobs(BOB)).length).toBe(0);
    expect((await studio.jobs(ALICE)).map((j) => j.id)).toEqual([job.id]);
  });

  it("credits a pack from its PackBought event, and rebuilds it on a replay", async () => {
    const { store, studio } = setup();
    const chain = new FakeChain().add(ev("PackBought", 100, { payer: BOB, account: ALICE, packId: 1, sketches: 50, models: 5, paid: "8000000" }));
    const sync = new SyncChain(chain, store, { startBlock: 100, confirmations: 0, rescan: 0, maxBlocksPerPass: 1000 }, silentLogger);
    await sync.pass();
    expect(await studio.credits(ALICE)).toMatchObject({ sketches: { bought: 50, left: 50 }, models: { bought: 5, left: 5 } });
    // The payer is the one who acted.
    expect((await store.user(BOB))?.actions).toBe(1);
    await studio.sketch(ALICE, "a cat");
    await store.transaction((tx) => tx.resetReadModels());
    expect((await studio.credits(ALICE)).sketches).toEqual({ bought: 0, used: 1, left: 0 });
  });
});
