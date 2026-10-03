import { describe, expect, it } from "vitest";
import { minted, reveal } from "../src/domain/box";
import { open, post } from "../src/domain/duel";
import { Queries } from "../src/application/queries";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ALICE, BOB, FakeChainState } from "./fixtures";

const at = { block: 10, logIndex: 0, timestamp: 1000 };
const contents = { seed: "1", state: 1, traits: [0, 0, 0, 0, 0], score: 1000, affection: 0, golden: false };

describe("the duel shelf", () => {
  it("leaves out a listing whose box, or the box it is reserved for, was opened", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      for (const id of [0, 1, 2, 3, 4]) await tx.saveBox(minted(id, 1));
      await tx.saveBox(reveal(minted(1, 1), contents, ALICE, 11));
      await tx.saveBox(reveal(minted(4, 1), contents, BOB, 11));
      const listings = [
        { duelId: 0, tokenA: 0, tokenB: null, reserved: false, challenger: ALICE },
        { duelId: 1, tokenA: 1, tokenB: null, reserved: false, challenger: ALICE },
        { duelId: 2, tokenA: 2, tokenB: 3, reserved: true, challenger: BOB },
        { duelId: 3, tokenA: 3, tokenB: 4, reserved: true, challenger: BOB },
      ];
      for (const l of listings) await tx.saveDuel(open(post(l, at), 5000, { ...at, logIndex: 1 }));
    });

    const shelf = await new Queries(store, new FakeChainState(), () => 2000).duelShelf();
    expect(shelf.map((d) => d.duelId).sort()).toEqual([0, 2]);
  });
});
