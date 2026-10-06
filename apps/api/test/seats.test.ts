import { allowListMessage } from "@dno/chain-adapter/standings";
import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { AllowList } from "../src/application/allowList";
import { Seats } from "../src/application/seats";
import { XPasses, xPassWalletMessage, type Tweet } from "../src/application/xPass";
import { ethersVerifier, passSecrets } from "../src/infrastructure/auth/crypto";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";

/** Two seats, an X pass maker and a wallet claimer around one store. */
function gate(places: number) {
  const store = new MemoryStore();
  const posts = new Map<string, Tweet>();
  const clock = { now: () => 1_000 };
  const seats = new Seats(store, places);
  const passes = new XPasses(store, { tweet: async (_h, id) => posts.get(id) ?? null }, passSecrets, ethersVerifier, clock, null, seats);
  const list = new AllowList(store, ethersVerifier, clock, places, async () => new Map(), seats);
  let n = 0;
  const board = async (handle: string) => {
    const { token, pass } = await passes.start();
    const id = String(++n);
    posts.set(id, { id, handle, text: pass.code });
    return { token, code: pass.code, view: await passes.verifyTweet(token, `https://x.com/${handle}/status/${id}`) };
  };
  const claim = async (wallet: { address: string; signMessage(m: string): Promise<string> }) => {
    const message = allowListMessage(wallet.address, new Date());
    return list.claim(wallet.address, message, await wallet.signMessage(message));
  };
  return { store, seats, passes, board, claim };
}

describe("seats on the mainnet list", () => {
  it("counts one seat per person: a boarded X account, or a wallet that claimed without one", async () => {
    const g = gate(10);
    const a = await g.board("cat");
    await g.board("dog");
    const w = Wallet.createRandom();
    await g.claim(w);
    expect(await g.seats.view()).toEqual({ taken: 3, places: 10 });
    // The wallet links to an X account: one person, one seat.
    const message = xPassWalletMessage(w.address, a.code, new Date());
    await g.passes.linkWallet(a.token, w.address, message, await w.signMessage(message));
    expect(await g.seats.taken()).toBe(2);
  });

  it("lets nobody new in once the seats are taken, and keeps those inside", async () => {
    const g = gate(2);
    const inside = await g.board("cat");
    await g.claim(Wallet.createRandom());
    await expect(g.board("dog")).rejects.toMatchObject({ code: "list-full" });
    await expect(g.claim(Wallet.createRandom())).rejects.toThrow("every seat");
    // Those inside still do their tasks, and an account moving to a new pass keeps its seat.
    expect((await g.passes.declare(inside.token, "like")).tasks.like).toBe(true);
    expect((await g.board("cat")).view.handle).toBe("cat");
  });
});
