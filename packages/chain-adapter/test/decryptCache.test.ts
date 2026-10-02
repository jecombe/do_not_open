import { beforeEach, describe, expect, it } from "vitest";
import { decodeClear, encodeClear, LocalStorageDecryptCache, MemoryDecryptCache } from "../src/evm/decryptCache";

/** Just enough of the browser's storage for the cache. */
class FakeStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe("decrypt cache", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new FakeStorage();
  });

  it("round-trips booleans, numbers and strings", () => {
    for (const v of [true, false, 0n, 12345678901234567890n, "0xabc"]) expect(decodeClear(encodeClear(v))).toEqual(v);
  });

  it("keeps values in memory", () => {
    const c = new MemoryDecryptCache();
    expect(c.get("a")).toBeNull();
    c.set("a", "b1");
    expect(c.get("a")).toBe("b1");
  });

  it("keeps values across visits, and drops the oldest past its size", () => {
    const first = new LocalStorageDecryptCache("dno:test", 2);
    first.set("h1", "n1");
    first.set("h2", "n2");
    first.set("h3", "n3");
    const next = new LocalStorageDecryptCache("dno:test", 2);
    expect(next.get("h1")).toBeNull();
    expect(next.get("h2")).toBe("n2");
    expect(next.get("h3")).toBe("n3");
  });

  it("still works for this visit when the storage refuses", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const c = new LocalStorageDecryptCache("dno:test");
    c.set("h", "b0");
    expect(c.get("h")).toBe("b0");
  });
});
