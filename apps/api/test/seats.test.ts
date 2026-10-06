import { allowListMessage } from "@dno/chain-adapter/standings";
import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { AllowList } from "../src/application/allowList";
import { Seats } from "../src/application/seats";
import { SyncChain } from "../src/application/syncChain";
import { silentLogger } from "../src/application/ports/logger";
import { XPasses, xPassWalletMessage, type Tweet, type XTask } from "../src/application/xPass";
import { ethersVerifier, passSecrets } from "../src/infrastructure/auth/crypto";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ev, FakeChain } from "./fixtures";

type Signer = { address: string; signMessage(m: string): Promise<string> };

/** A list with `places` seats, an X boarding desk and a wallet claim desk around one store. */
async function gate(places: number, required: XTask[] = ["follow", "post"]) {
  const store = new MemoryStore();
  const chain = new FakeChain();
  const posts = new Map<string, Tweet>();
  const clock = { now: () => 1_000 };
  let list: AllowList | null = null;
  const seats = new Seats(store, places, () => list!.players(true), required);
  list = new AllowList(store, ethersVerifier, clock, places, async () => new Map(), seats);
  const passes = new XPasses(store, { tweet: async (_h, id) => posts.get(id) ?? null }, passSecrets, ethersVerifier, clock, null, seats);
  let n = 0;
  let block = 100;
  /** An X account connected on a new pass, and the tasks it did. */
  const board = async (handle: string, tasks: XTask[] = required) => {
    const { token, pass } = await passes.start();
    for (const t of tasks) await passes.declare(token, t);
    const id = String(++n);
    posts.set(id, { id, handle, text: pass.code });
    return { token, code: pass.code, view: await passes.verifyTweet(token, `https://x.com/${handle}/status/${id}`) };
  };
  const claim = async (wallet: Signer) => {
    const message = allowListMessage(wallet.address, new Date());
    return list!.claim(wallet.address, message, await wallet.signMessage(message));
  };
  /** The wallet mints a box on the testnet. */
  const mint = async (wallet: Signer) => {
    chain.add(ev("MintPlaced", ++block, { firstTokenId: block, buyer: wallet.address.toLowerCase(), count: 1 }));
    await new SyncChain(chain, store, { startBlock: 100, confirmations: 0, rescan: 0, maxBlocksPerPass: 1000 }, silentLogger).pass();
  };
  return { store, seats, passes, list: list!, board, claim, mint };
}

describe("seats on the mainnet list", () => {
  it("seats an X account once every task is done, not before", async () => {
    const g = await gate(10, ["follow", "post", "repost"]);
    // The post carrying the code counts as the boarding tweet; the repost is still missing.
    const half = await g.board("cat", ["follow"]);
    expect(half.view).toMatchObject({ seated: false, tasks: { follow: true, post: true, repost: false } });
    expect(await g.seats.taken()).toBe(0);
    expect((await g.passes.declare(half.token, "repost")).seated).toBe(true);
    expect(await g.seats.view()).toEqual({ taken: 1, places: 10, required: ["follow", "post", "repost"] });
  });

  it("seats a wallet that claimed and tried the testnet, not one that only claimed", async () => {
    const g = await gate(10);
    const idle = Wallet.createRandom();
    expect((await g.claim(idle)).seated).toBe(false);
    const player = Wallet.createRandom();
    await g.mint(player);
    expect((await g.claim(player)).seated).toBe(true);
    expect(await g.seats.taken()).toBe(1);
    // The idle one plays later and sits down then.
    await g.mint(idle);
    expect(await g.seats.taken()).toBe(2);
  });

  it("counts an X account and its linked wallet as one person", async () => {
    const g = await gate(10);
    const w = Wallet.createRandom();
    await g.mint(w);
    await g.claim(w);
    const a = await g.board("cat");
    expect(await g.seats.taken()).toBe(2);
    const message = xPassWalletMessage(w.address, a.code, new Date());
    await g.passes.linkWallet(a.token, w.address, message, await w.signMessage(message));
    expect(await g.seats.taken()).toBe(1);
  });

  it("lets nobody new sit down once the seats are taken, and keeps those seated", async () => {
    const g = await gate(2);
    const inside = await g.board("cat");
    const player = Wallet.createRandom();
    await g.mint(player);
    await g.claim(player);
    // A new X account doing its last task, a new wallet that played: both too late.
    await expect(g.board("dog")).rejects.toMatchObject({ code: "list-full" });
    const late = Wallet.createRandom();
    await g.mint(late);
    await expect(g.claim(late)).rejects.toThrow("every seat");
    // Someone who has not played may still claim, without a seat.
    expect((await g.claim(Wallet.createRandom())).seated).toBe(false);
    // Those seated keep doing things, and an account moving to a new pass keeps its seat.
    expect((await g.passes.declare(inside.token, "like")).tasks.like).toBe(true);
    expect((await g.board("cat")).view).toMatchObject({ handle: "cat", seated: true });
  });
});
