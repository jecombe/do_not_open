import { describe, expect, it } from "vitest";
import { Ideas } from "../src/application/ideas";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";

describe("the suggestion box", () => {
  it("keeps an idea once, tidied, with the handle of the player's own pass", async () => {
    const store = new MemoryStore();
    const box = new Ideas(store, { now: () => 1_000 }, async (token) => (token === "good" ? "cat" : null));
    expect(await box.submit("  A duel   league \n with seasons ", "fr", "good")).toEqual({ received: 1 });
    await box.submit("A duel league with seasons", "en", "");
    await box.submit("Rats that sniff for the clerk", "en", "unknown");
    expect(await box.all()).toEqual([
      { id: 2, text: "Rats that sniff for the clerk", handle: null, locale: "en", createdAt: 1_000 },
      { id: 1, text: "A duel league with seasons", handle: "cat", locale: "fr", createdAt: 1_000 },
    ]);
  });

  it("refuses a word or an essay", async () => {
    const box = new Ideas(new MemoryStore(), { now: () => 1_000 });
    await expect(box.submit("meh", "en", "")).rejects.toThrow("at least");
    await expect(box.submit("x".repeat(601), "en", "")).rejects.toThrow("fits in");
  });
});
