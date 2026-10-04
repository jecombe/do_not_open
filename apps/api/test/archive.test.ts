import { describe, expect, it } from "vitest";
import { ArchiveImages, ImageArchive, sha256Hex } from "../src/application/archive";
import { imageOf, sealedImageOf } from "../src/application/metadata";
import type { PermanentStorage } from "../src/application/ports/archive";
import { silentLogger } from "../src/application/ports/logger";
import type { Box } from "../src/domain/box";
import { deepHash, serializeTags, signDataItem } from "../src/infrastructure/archive/ans104";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";

describe("ANS-104 data items", () => {
  it("signs exactly what @dha-team/arbundles signs for the same key, data and tags", async () => {
    // Vector produced by arbundles 1.0.4 (EthereumSigner, createData, sign) on 2026-10-04.
    const item = await signDataItem("0x" + "11".repeat(32), new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), [
      { name: "Content-Type", value: "image/svg+xml" },
      { name: "App-Name", value: "DoNotOpen" },
    ]);
    expect(item.id).toBe("hjbExl-WnzERa6sptfaAFs5fMUZnBjreUWJVnKjGjCc");
    expect(item.bytes[0]).toBe(3); // Ethereum signature type, little-endian
    expect(item.bytes.length).toBe(2 + 65 + 65 + 1 + 1 + 8 + 8 + serializeTags([{ name: "Content-Type", value: "image/svg+xml" }, { name: "App-Name", value: "DoNotOpen" }]).length + 41);
  });

  it("encodes no tags as nothing, and deep-hashes to 48 bytes", () => {
    expect(serializeTags([])).toHaveLength(0);
    expect(deepHash([new Uint8Array([1]), new Uint8Array(0)])).toHaveLength(48);
  });
});

class FakeStorage implements PermanentStorage {
  maxBytes = 100_000;
  puts: string[] = [];
  async put(data: Uint8Array) {
    this.puts.push(new TextDecoder().decode(data));
    return `ar${this.puts.length}`;
  }
}

const sealed = (tokenId: number): Box => ({ tokenId, revealed: null, weighIn: null }) as unknown as Box;
const opened = (tokenId: number, weighIn: Box["weighIn"] = null): Box =>
  ({ tokenId, revealed: { seed: "8177263914793887761", affection: 3 }, weighIn }) as unknown as Box;

const WEIGH_IN = { weight: "9000", build: "chonk", sick: true, disease: null, tolerance: "0" } as unknown as NonNullable<Box["weighIn"]>;

function setup(boxes: { opened: Box[]; minted: number }, perPass = 10) {
  const store = new MemoryStore();
  const storage = new FakeStorage();
  const reads = { openedBoxes: async () => boxes.opened, tokenCount: async () => boxes.minted };
  return { store, storage, task: new ArchiveImages(reads, store, storage, perPass, silentLogger, () => 1) };
}

describe("ArchiveImages", () => {
  it("stores the opened cats first, then the sealed boxes in token order, a few per pass", async () => {
    const { store, storage, task } = setup({ opened: [opened(2)], minted: 4 }, 3);
    expect(await task.run()).toEqual({ archived: 3, tooLarge: 0 });
    expect(storage.puts).toEqual([imageOf(opened(2)), sealedImageOf(0), sealedImageOf(1)]);
    expect(await task.run()).toEqual({ archived: 2, tooLarge: 0 });
    expect(storage.puts.slice(3)).toEqual([sealedImageOf(2), sealedImageOf(3)]);
    expect(await task.run()).toEqual({ archived: 0, tooLarge: 0 });
    const url = await new ImageArchive(store, "https://arweave.net").urlOf(sealedImageOf(1));
    expect(url).toBe("https://arweave.net/ar3");
  });

  it("never uploads the same picture twice, even from a new process", async () => {
    const { store, storage } = setup({ opened: [], minted: 0 });
    await store.saveArchivedImage(sha256Hex(sealedImageOf(0)), "old", 1);
    const again = new ArchiveImages({ openedBoxes: async () => [], tokenCount: async () => 1 }, store, storage, 10, silentLogger);
    expect(await again.run()).toEqual({ archived: 0, tooLarge: 0 });
    expect(storage.puts).toEqual([]);
  });

  it("stores a cat again when its picture changes", async () => {
    const boxes = { opened: [opened(0)], minted: 0 };
    const { storage, task } = setup(boxes);
    await task.run();
    await task.run();
    const weighed = opened(0, WEIGH_IN);
    expect(imageOf(weighed)).not.toBe(imageOf(opened(0)));
    boxes.opened = [weighed];
    await task.run();
    expect(storage.puts).toEqual([imageOf(opened(0)), imageOf(weighed)]);
  });

  it("leaves an image over the free size on the API", async () => {
    const { storage, task } = setup({ opened: [], minted: 1 });
    storage.maxBytes = 10;
    expect(await task.run()).toEqual({ archived: 0, tooLarge: 1 });
    expect(storage.puts).toEqual([]);
  });
});
