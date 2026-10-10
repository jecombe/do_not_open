import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { IDelegateRegistry, ISeaport, PocketDesk, SealedPockets, SealedVault, TestConfidentialUSDC, TestERC721, TestUSDC, VaultOffers } from "../types";
import { confidentialUsdcOf, usd } from "./tokens";
import { installDelegateRegistry, installSeaport } from "./seaport";

const SPEND = { Send: 0, Withdraw: 1 } as const;
const ACTION_WITHDRAW = 0;
const REQUEST_DONE = 2n;
const FEE_BPS = 250n;
const feeOf = (price: bigint) => (price * FEE_BPS) / 10_000n;
/** A pocket key, as the page derives one: any 256-bit secret. */
const randomKey = () => BigInt(ethers.hexlify(ethers.randomBytes(32)));

describe("SealedPockets", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  /** Sends opens and spends for others: holds no pocket. */
  let relay: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let fresh: HardhatEthersSigner;
  /** The addresses the pages derive to read balances: one per pocket, tied to no wallet. */
  let viewers: HardhatEthersSigner[];
  let usdc: TestUSDC;
  let cUsdc: TestConfidentialUSDC;
  let pockets: SealedPockets;
  let addr: string;

  async function giveCusdc(who: HardhatEthersSigner, amount: bigint, operators: string[]) {
    await (await usdc.mint(who.address, amount)).wait();
    await (await usdc.connect(who).approve(await cUsdc.getAddress(), amount)).wait();
    await (await cUsdc.connect(who).wrap(who.address, amount)).wait();
    for (const o of operators) await (await cUsdc.connect(who).setOperator(o, (await time.latest()) + 365 * 86_400)).wait();
  }

  /** Opens a pocket through the relay, read by `viewers[n]`. Returns its number. */
  async function open(n: number, key: bigint) {
    const input = await fhevm.createEncryptedInput(addr, relay.address).add256(key).encrypt();
    const id = await pockets.pocketCount();
    await (await pockets.connect(relay).open(input.handles[0]!, input.inputProof, viewers[n]!.address)).wait();
    return id;
  }

  const balance = async (pocketId: bigint, n: number) =>
    fhevm.userDecryptEuint(FhevmType.euint64, await pockets.balanceOf(pocketId), addr, viewers[n]!);

  async function deposit(who: HardhatEthersSigner, set: bigint[], target: bigint, amount: bigint) {
    const input = await fhevm.createEncryptedInput(addr, who.address).add32(Number(target)).add64(amount).encrypt();
    await (await pockets.connect(who).deposit(set, input.handles[0]!, input.handles[1]!, input.inputProof)).wait();
  }

  /** What a page encrypts for a spend: the amount and target, then the key bound to them. */
  async function spendInput(action: number, from: bigint[], to: bigint[], dest: string, amount: bigint, target: bigint, key: bigint, sender = relay) {
    const values = await fhevm.createEncryptedInput(addr, sender.address).add64(amount).add32(Number(target)).encrypt();
    const [a, t] = [ethers.hexlify(values.handles[0]!), ethers.hexlify(values.handles[1]!)];
    const hash = await pockets.spendHash(action, from, to, dest, a, action === SPEND.Withdraw ? ethers.ZeroHash : t);
    const bound = await fhevm.createEncryptedInput(addr, sender.address).add256(key ^ hash).encrypt();
    return { amount: a, target: t, inputProof: values.inputProof, boundKey: bound.handles[0]!, keyProof: bound.inputProof };
  }

  async function send(from: bigint[], to: bigint[], target: bigint, amount: bigint, key: bigint) {
    const s = await spendInput(SPEND.Send, from, to, ethers.ZeroAddress, amount, target, key);
    await (await pockets.connect(relay).send(from, to, s)).wait();
    return s;
  }

  async function withdraw(from: bigint[], to: string, amount: bigint, key: bigint) {
    const s = await spendInput(SPEND.Withdraw, from, [], to, amount, 0n, key);
    await (await pockets.connect(relay).withdraw(from, to, s)).wait();
    return s;
  }

  beforeEach(async function () {
    const signers = (await ethers.getSigners()) as HardhatEthersSigner[];
    [deployer, alice, bob, relay, treasury, fresh] = signers as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    viewers = signers.slice(10, 16);
    usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    cUsdc = (await (await ethers.getContractFactory("TestConfidentialUSDC")).deploy(await usdc.getAddress())) as unknown as TestConfidentialUSDC;
    pockets = (await (await ethers.getContractFactory("SealedPockets")).deploy(await cUsdc.getAddress(), deployer.address)) as unknown as SealedPockets;
    addr = await pockets.getAddress();
    await giveCusdc(alice, usd("1000"), [addr]);
  });

  describe("open", function () {
    it("opens a pocket with a zero balance only its viewer reads", async function () {
      const id = await open(0, randomKey());
      expect(id).to.eq(0n);
      expect(await pockets.viewerOf(id)).to.eq(viewers[0]!.address);
      expect(await pockets.pocketOf(viewers[0]!.address)).to.eq(1n);
      expect(await balance(id, 0)).to.eq(0n);
      let refused = false;
      await fhevm.userDecryptEuint(FhevmType.euint64, await pockets.balanceOf(id), addr, viewers[1]!).catch(() => (refused = true));
      expect(refused).to.eq(true);
    });

    it("takes one pocket per viewer", async function () {
      await open(0, randomKey());
      const input = await fhevm.createEncryptedInput(addr, relay.address).add256(randomKey()).encrypt();
      await expect(pockets.connect(relay).open(input.handles[0]!, input.inputProof, viewers[0]!.address)).to.be.revertedWithCustomError(pockets, "ViewerTaken");
    });
  });

  describe("deposit", function () {
    it("credits the target among decoys, and nobody else", async function () {
      const [p0, p1, p2] = [await open(0, randomKey()), await open(1, randomKey()), await open(2, randomKey())];
      await deposit(alice, [p0, p1, p2], p1, usd("300"));
      expect(await balance(p0, 0)).to.eq(0n);
      expect(await balance(p1, 1)).to.eq(usd("300"));
      expect(await balance(p2, 2)).to.eq(0n);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(usd("700"));
    });

    it("gives the tokens back when the target is not in the set", async function () {
      const [p0, p1] = [await open(0, randomKey()), await open(1, randomKey())];
      await deposit(alice, [p0], p1, usd("300"));
      expect(await balance(p0, 0)).to.eq(0n);
      expect(await balance(p1, 1)).to.eq(0n);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(usd("1000"));
    });

    it("refuses sets out of order, repeated, too long or naming no pocket", async function () {
      for (let i = 0; i < 6; i++) await open(i, randomKey());
      const input = await fhevm.createEncryptedInput(addr, alice.address).add32(0).add64(1).encrypt();
      const go = (set: number[]) => pockets.connect(alice).deposit(set, input.handles[0]!, input.handles[1]!, input.inputProof);
      await expect(go([1, 0])).to.be.revertedWithCustomError(pockets, "BadSet");
      await expect(go([1, 1])).to.be.revertedWithCustomError(pockets, "BadSet");
      await expect(go([])).to.be.revertedWithCustomError(pockets, "BadSet");
      await expect(go([0, 1, 2, 3, 4, 5])).to.be.revertedWithCustomError(pockets, "BadSet");
      await expect(go([0, 9])).to.be.revertedWithCustomError(pockets, "NotAPocket");
    });
  });

  describe("send", function () {
    let aliceKey: bigint;
    let pa: bigint;
    let pb: bigint;
    let decoy: bigint;
    let decoy2: bigint;

    beforeEach(async function () {
      aliceKey = randomKey();
      pa = await open(0, aliceKey);
      pb = await open(1, randomKey());
      decoy = await open(2, randomKey());
      decoy2 = await open(3, randomKey());
      await deposit(alice, [pa], pa, usd("500"));
    });

    it("moves the amount from the key's pocket to the target, decoys untouched", async function () {
      await send([pa, decoy], [pb, decoy2], pb, usd("120"), aliceKey);
      expect(await balance(pa, 0)).to.eq(usd("380"));
      expect(await balance(pb, 1)).to.eq(usd("120"));
      expect(await balance(decoy, 2)).to.eq(0n);
      expect(await balance(decoy2, 3)).to.eq(0n);
    });

    it("moves nothing with a wrong key", async function () {
      await send([pa, decoy], [pb], pb, usd("120"), randomKey());
      expect(await balance(pa, 0)).to.eq(usd("500"));
      expect(await balance(pb, 1)).to.eq(0n);
    });

    it("moves nothing when the balance is short", async function () {
      await send([pa], [pb], pb, usd("501"), aliceKey);
      expect(await balance(pa, 0)).to.eq(usd("500"));
      expect(await balance(pb, 1)).to.eq(0n);
    });

    it("moves nothing when the target is not in the receiving set", async function () {
      await send([pa], [decoy], pb, usd("100"), aliceKey);
      expect(await balance(pa, 0)).to.eq(usd("500"));
      expect(await balance(decoy, 2)).to.eq(0n);
      expect(await balance(pb, 1)).to.eq(0n);
    });

    it("runs a bound key once: the relay cannot send it again", async function () {
      const s = await send([pa], [pb], pb, usd("100"), aliceKey);
      await expect(pockets.connect(relay).send([pa], [pb], s)).to.be.revertedWithCustomError(pockets, "KeyUsed");
      expect(await balance(pb, 1)).to.eq(usd("100"));
    });

    it("moves nothing when the relay changes the receiving set", async function () {
      const s = await spendInput(SPEND.Send, [pa], [pb], ethers.ZeroAddress, usd("100"), pb, aliceKey);
      // The relay keeps the inputs and points them at a pocket of its own choosing: the key no longer matches.
      await (await pockets.connect(relay).send([pa], [pb, decoy], s)).wait();
      expect(await balance(pa, 0)).to.eq(usd("500"));
      expect(await balance(pb, 1)).to.eq(0n);
    });

    it("lets a pocket send to itself: its balance stays", async function () {
      await send([pa], [pa, pb], pa, usd("50"), aliceKey);
      expect(await balance(pa, 0)).to.eq(usd("500"));
      expect(await balance(pb, 1)).to.eq(0n);
    });
  });

  describe("withdraw", function () {
    let aliceKey: bigint;
    let pa: bigint;
    let decoy: bigint;

    beforeEach(async function () {
      aliceKey = randomKey();
      pa = await open(0, aliceKey);
      decoy = await open(1, randomKey());
      await deposit(alice, [pa, decoy], pa, usd("400"));
    });

    it("pays the amount out to any address, as cUSDC", async function () {
      await withdraw([pa, decoy], fresh.address, usd("150"), aliceKey);
      expect(await balance(pa, 0)).to.eq(usd("250"));
      expect(await balance(decoy, 1)).to.eq(0n);
      expect(await confidentialUsdcOf(cUsdc, fresh)).to.eq(usd("150"));
    });

    it("pays nothing with a wrong key or a short balance", async function () {
      await withdraw([pa], fresh.address, usd("150"), randomKey());
      await withdraw([pa], fresh.address, usd("401"), aliceKey);
      expect(await balance(pa, 0)).to.eq(usd("400"));
      expect(await confidentialUsdcOf(cUsdc, fresh)).to.eq(0n);
    });

    it("pays nothing when the relay changes where it goes", async function () {
      const s = await spendInput(SPEND.Withdraw, [pa], [], fresh.address, usd("150"), 0n, aliceKey);
      await (await pockets.connect(relay).withdraw([pa], relay.address, s)).wait();
      expect(await balance(pa, 0)).to.eq(usd("400"));
      expect(await confidentialUsdcOf(cUsdc, relay)).to.eq(0n);
    });

    it("can be sent from the holder's own wallet when there is no relayer", async function () {
      const s = await spendInput(SPEND.Withdraw, [pa], [], fresh.address, usd("10"), 0n, aliceKey, bob);
      await (await pockets.connect(bob).withdraw([pa], fresh.address, s)).wait();
      expect(await confidentialUsdcOf(cUsdc, fresh)).to.eq(usd("10"));
    });
  });

  describe("limits and costs", function () {
    /** Per transaction on the Zama Protocol: 20M HCU, 5M of them in sequence. */
    const HCU_LIMIT = 20_000_000;
    const HCU_DEPTH_LIMIT = 5_000_000;

    it("sends between two full sets of five within the HCU limits", async function () {
      const keys = Array.from({ length: 6 }, randomKey);
      const ids: bigint[] = [];
      for (let i = 0; i < 6; i++) ids.push(await open(i, keys[i]!));
      await deposit(alice, [ids[0]!], ids[0]!, usd("100"));
      const from = ids.slice(0, 5);
      const to = ids.slice(1, 6);
      const s = await spendInput(SPEND.Send, from, to, ethers.ZeroAddress, usd("40"), ids[5]!, keys[0]!);
      const receipt = (await (await pockets.connect(relay).send(from, to, s)).wait())!;
      const hcu = fhevm.computeTransactionHCU(receipt);
      expect(hcu.globalHCU).to.be.below(HCU_LIMIT);
      expect(hcu.maxHCUDepth).to.be.below(HCU_DEPTH_LIMIT);
      expect(await balance(ids[0]!, 0)).to.eq(usd("60"));
      expect(await balance(ids[5]!, 5)).to.eq(usd("40"));
      for (let i = 1; i < 5; i++) expect(await balance(ids[i]!, i)).to.eq(0n);
    });

    it("deposits into, and withdraws from, a full set of five within the HCU limits", async function () {
      const key = randomKey();
      const ids: bigint[] = [await open(0, key)];
      for (let i = 1; i < 5; i++) ids.push(await open(i, randomKey()));
      const d = await fhevm.createEncryptedInput(addr, alice.address).add32(Number(ids[0])).add64(usd("10")).encrypt();
      const dr = (await (await pockets.connect(alice).deposit(ids, d.handles[0]!, d.handles[1]!, d.inputProof)).wait())!;
      expect(fhevm.computeTransactionHCU(dr).globalHCU).to.be.below(HCU_LIMIT);
      const w = await spendInput(SPEND.Withdraw, ids, [], fresh.address, usd("10"), 0n, key);
      const wr = (await (await pockets.connect(relay).withdraw(ids, fresh.address, w)).wait())!;
      expect(fhevm.computeTransactionHCU(wr).globalHCU).to.be.below(HCU_LIMIT);
      expect(await confidentialUsdcOf(cUsdc, fresh)).to.eq(usd("10"));
    });

    it("prints gas and HCU per action (REPORT_COSTS=1)", async function () {
      if (!process.env.REPORT_COSTS) this.skip();
      const rows: { action: string; gas: number; hcu: number; depth: number }[] = [];
      const measure = async (action: string, tx: Promise<{ wait: () => Promise<unknown> }>) => {
        const r = (await (await tx).wait()) as Parameters<typeof fhevm.computeTransactionHCU>[0] & { gasUsed: bigint };
        const h = fhevm.computeTransactionHCU(r);
        rows.push({ action, gas: Number(r.gasUsed), hcu: h.globalHCU, depth: h.maxHCUDepth });
      };
      const keys = Array.from({ length: 6 }, randomKey);
      const ids: bigint[] = [];
      for (let i = 0; i < 6; i++) {
        const input = await fhevm.createEncryptedInput(addr, relay.address).add256(keys[i]!).encrypt();
        ids.push(await pockets.pocketCount());
        await measure("open", pockets.connect(relay).open(input.handles[0]!, input.inputProof, viewers[i]!.address));
      }
      for (const n of [1, 3, 5]) {
        const d = await fhevm.createEncryptedInput(addr, alice.address).add32(Number(ids[0])).add64(usd("50")).encrypt();
        await measure(`deposit (set of ${n})`, pockets.connect(alice).deposit(ids.slice(0, n), d.handles[0]!, d.handles[1]!, d.inputProof));
      }
      for (const n of [1, 3, 5]) {
        const from = ids.slice(0, n);
        const to = ids.slice(1, n + 1);
        const s = await spendInput(SPEND.Send, from, to, ethers.ZeroAddress, usd("1"), ids[1]!, keys[0]!);
        await measure(`send (${n} paying, ${n} receiving)`, pockets.connect(relay).send(from, to, s));
      }
      for (const n of [1, 3, 5]) {
        const from = ids.slice(0, n);
        const w = await spendInput(SPEND.Withdraw, from, [], fresh.address, usd("1"), 0n, keys[0]!);
        await measure(`withdraw (set of ${n})`, pockets.connect(relay).withdraw(from, fresh.address, w));
      }
      console.table(rows);
    });

    it("keeps every token accounted for over a long run of random actions", async function () {
      // A model of the balances next to the contract's: deposits, sends (right and wrong keys,
      // short balances, missing targets) and withdrawals, then every pocket and the contract's
      // own cUSDC compared.
      const n = 5;
      const keys = Array.from({ length: n }, randomKey);
      const ids: bigint[] = [];
      for (let i = 0; i < n; i++) ids.push(await open(i, keys[i]!));
      const model = new Map<bigint, bigint>(ids.map((id) => [id, 0n]));
      let out = 0n;
      let seed = 7;
      const rand = (m: number) => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % m;
      };
      const pick = (k: number, must: bigint) => {
        const set = new Set<bigint>([must]);
        while (set.size < k) set.add(ids[rand(n)]!);
        return [...set].sort((a, b) => (a < b ? -1 : 1));
      };
      for (let step = 0; step < 24; step++) {
        const who = rand(n);
        const id = ids[who]!;
        const kind = rand(3);
        const amount = usd(String(1 + rand(60)));
        if (kind === 0) {
          await deposit(alice, pick(1 + rand(3), id), id, amount);
          model.set(id, model.get(id)! + amount);
        } else if (kind === 1) {
          const target = ids[rand(n)]!;
          const wrongKey = rand(5) === 0;
          const missing = rand(6) === 0;
          const to = missing ? pick(1, ids[(Number(target) + 1) % n]!).filter((x) => x !== target) : pick(1 + rand(3), target);
          if (to.length === 0) continue;
          await send(pick(1 + rand(3), id), to, target, amount, wrongKey ? randomKey() : keys[who]!);
          const moves = !wrongKey && to.includes(target) && model.get(id)! >= amount;
          if (moves) {
            model.set(id, model.get(id)! - amount);
            model.set(target, model.get(target)! + amount);
          }
        } else {
          await withdraw(pick(1 + rand(3), id), fresh.address, amount, keys[who]!);
          if (model.get(id)! >= amount) {
            model.set(id, model.get(id)! - amount);
            out += amount;
          }
        }
      }
      let total = 0n;
      for (let i = 0; i < n; i++) {
        expect(await balance(ids[i]!, i)).to.eq(model.get(ids[i]!), `pocket ${i}`);
        total += model.get(ids[i]!)!;
      }
      const held = await fhevm.debugger.decryptEuint(FhevmType.euint64, await cUsdc.confidentialBalanceOf(addr));
      expect(held).to.eq(total);
      expect(await confidentialUsdcOf(cUsdc, fresh)).to.eq(out);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(usd("1000") - total - out);
    });
  });

  describe("more refusals", function () {
    let key: bigint;
    let pa: bigint;
    let pb: bigint;

    beforeEach(async function () {
      key = randomKey();
      pa = await open(0, key);
      pb = await open(1, randomKey());
      await deposit(alice, [pa], pa, usd("100"));
    });

    it("refuses a pocket with no viewer, and views of a pocket never opened", async function () {
      const input = await fhevm.createEncryptedInput(addr, relay.address).add256(randomKey()).encrypt();
      await expect(pockets.connect(relay).open(input.handles[0]!, input.inputProof, ethers.ZeroAddress)).to.be.revertedWithCustomError(pockets, "ZeroAddress");
      await expect(pockets.balanceOf(9)).to.be.revertedWithCustomError(pockets, "NotAPocket");
      await expect(pockets.viewerOf(9)).to.be.revertedWithCustomError(pockets, "NotAPocket");
    });

    it("credits nothing when the depositor's cUSDC falls short", async function () {
      await giveCusdc(bob, usd("5"), [addr]);
      await deposit(bob, [pb], pb, usd("6"));
      expect(await balance(pb, 1)).to.eq(0n);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(usd("5"));
    });

    it("needs the depositor to have made the pockets their cUSDC operator", async function () {
      await giveCusdc(bob, usd("5"), []);
      const input = await fhevm.createEncryptedInput(addr, bob.address).add32(Number(pb)).add64(usd("1")).encrypt();
      await expect(pockets.connect(bob).deposit([pb], input.handles[0]!, input.handles[1]!, input.inputProof)).to.be.reverted;
    });

    it("lets anyone pay a pocket from a wallet, as a payment", async function () {
      await giveCusdc(bob, usd("50"), [addr]);
      await deposit(bob, [pa, pb], pa, usd("25"));
      expect(await balance(pa, 0)).to.eq(usd("125"));
    });

    it("moves the whole balance, and zero, as asked", async function () {
      await send([pa], [pb], pb, usd("100"), key);
      expect(await balance(pa, 0)).to.eq(0n);
      expect(await balance(pb, 1)).to.eq(usd("100"));
      await send([pa], [pb], pb, 0n, key);
      expect(await balance(pb, 1)).to.eq(usd("100"));
    });

    it("debits only the pocket whose key it is, whatever else the set holds", async function () {
      await deposit(alice, [pb], pb, usd("100"));
      await withdraw([pa, pb], fresh.address, usd("30"), key);
      expect(await balance(pa, 0)).to.eq(usd("70"));
      expect(await balance(pb, 1)).to.eq(usd("100"));
    });

    it("moves nothing when the relay changes the paying set or the amount", async function () {
      const s = await spendInput(SPEND.Send, [pa], [pb], ethers.ZeroAddress, usd("10"), pb, key);
      // Its own encryption of a bigger amount, under the holder's bound key.
      const mine = await fhevm.createEncryptedInput(addr, relay.address).add64(usd("100")).add32(Number(pb)).encrypt();
      await (await pockets.connect(relay).send([pa], [pb], { ...s, amount: mine.handles[0]!, target: mine.handles[1]!, inputProof: mine.inputProof })).wait();
      const t = await spendInput(SPEND.Send, [pa], [pb], ethers.ZeroAddress, usd("10"), pb, key);
      await (await pockets.connect(relay).send([pa, pb], [pb], t)).wait();
      expect(await balance(pa, 0)).to.eq(usd("100"));
      expect(await balance(pb, 1)).to.eq(0n);
    });

    it("refuses a bound key the relay replays in another kind of spend", async function () {
      const s = await send([pa], [pb], pb, usd("10"), key);
      await expect(pockets.connect(relay).withdraw([pa], relay.address, s)).to.be.revertedWithCustomError(pockets, "KeyUsed");
    });

    it("refuses inputs encrypted for another sender", async function () {
      const s = await spendInput(SPEND.Send, [pa], [pb], ethers.ZeroAddress, usd("10"), pb, key);
      await expect(pockets.connect(bob).send([pa], [pb], s)).to.be.reverted;
      await expect(pockets.connect(relay).withdraw([pa], ethers.ZeroAddress, s)).to.be.revertedWithCustomError(pockets, "ZeroAddress");
    });

    it("says which sets moved, never by how much", async function () {
      const s = await spendInput(SPEND.Send, [pa], [pb], ethers.ZeroAddress, usd("10"), pb, key);
      await expect(pockets.connect(relay).send([pa], [pb], s)).to.emit(pockets, "Sent").withArgs([pa], [pb]);
      const w = await spendInput(SPEND.Withdraw, [pa, pb], [], fresh.address, usd("1"), 0n, key);
      await expect(pockets.connect(relay).withdraw([pa, pb], fresh.address, w)).to.emit(pockets, "Withdrawn").withArgs([pa, pb], fresh.address);
      const d = await fhevm.createEncryptedInput(addr, alice.address).add32(Number(pb)).add64(1).encrypt();
      await expect(pockets.connect(alice).deposit([pa, pb], d.handles[0]!, d.handles[1]!, d.inputProof)).to.emit(pockets, "Deposited").withArgs(alice.address, [pa, pb]);
    });

    it("has no desk until the owner adds one, each once", async function () {
      expect(await pockets.isDesk(alice.address)).to.eq(false);
      await expect(pockets.connect(alice).addDesk(alice.address)).to.be.revertedWithCustomError(pockets, "OwnableUnauthorizedAccount");
      await expect(pockets.addDesk(ethers.ZeroAddress)).to.be.revertedWithCustomError(pockets, "ZeroAddress");
      await expect(pockets.addDesk(alice.address)).to.emit(pockets, "DeskAdded").withArgs(alice.address);
      expect(await pockets.isDesk(alice.address)).to.eq(true);
      await expect(pockets.addDesk(alice.address)).to.be.revertedWithCustomError(pockets, "DeskSet");
    });
  });

  describe("desk", function () {
    let nft: TestERC721;
    let vault: SealedVault;
    let vaultAddress: string;
    let desk: PocketDesk;
    let deskAddress: string;
    const PRICE = usd("200");

    beforeEach(async function () {
      const seaport: ISeaport = await installSeaport();
      const registry: IDelegateRegistry = await installDelegateRegistry();
      const weth = await (await ethers.getContractFactory("TestWETH")).deploy();
      const offers = (await (await ethers.getContractFactory("VaultOffers")).deploy(await seaport.getAddress(), await weth.getAddress())) as unknown as VaultOffers;
      nft = (await (await ethers.getContractFactory("TestERC721")).deploy()) as unknown as TestERC721;
      vault = (await (await ethers.getContractFactory("SealedVault")).deploy(
        await seaport.getAddress(),
        await cUsdc.getAddress(),
        await offers.getAddress(),
        await registry.getAddress(),
        treasury.address,
        deployer.address,
        FEE_BPS,
      )) as unknown as SealedVault;
      vaultAddress = await vault.getAddress();
      await (await vault.setCollection(await nft.getAddress(), true)).wait();
      desk = (await (await ethers.getContractFactory("PocketDesk")).deploy(addr, vaultAddress)) as unknown as PocketDesk;
      deskAddress = await desk.getAddress();
      await (await pockets.addDesk(deskAddress)).wait();
    });

    /** Bob seals NFT `tokenId` and offers its box to the desk, reserved for `pocket`. */
    async function offerToPocket(tokenId: number, pocket: bigint, price = PRICE) {
      await (await nft.mint(bob.address, tokenId)).wait();
      await (await nft.connect(bob).approve(vaultAddress, tokenId)).wait();
      const key = await fhevm.createEncryptedInput(vaultAddress, bob.address).add256(randomKey()).encrypt();
      const boxId = await vault.tokenCount();
      await (await vault.connect(bob).deposit(await nft.getAddress(), tokenId, key.handles[0]!, [], [], key.inputProof)).wait();
      const p = await fhevm.createEncryptedInput(vaultAddress, bob.address).add64(price).encrypt();
      const saleId = await vault.saleCount();
      await (await vault.connect(bob).offerSale(boxId, deskAddress, p.handles[0]!, p.inputProof)).wait();
      await (await desk.connect(bob).reserve(saleId, pocket)).wait();
      return { boxId, saleId };
    }

    /** The pocket's holder buys through the relay: asks with the pocket's bound key, then buys with the box's new vault key. */
    async function buy(saleId: bigint, pocket: bigint, pocketKey: bigint, boxKey: bigint) {
      const box = await fhevm.createEncryptedInput(vaultAddress, deskAddress).add256(boxKey).encrypt();
      const boxHandle = ethers.hexlify(box.handles[0]!);
      const hash = await desk.buyHash(saleId, pocket, boxHandle);
      const bound = await fhevm.createEncryptedInput(deskAddress, relay.address).add256(pocketKey ^ hash).encrypt();
      const askId = await desk.askCount();
      await (await desk.connect(relay).ask(saleId, bound.handles[0]!, bound.inputProof, boxHandle)).wait();
      const d = await fhevm.publicDecrypt([(await desk.askInfo(askId)).ok]);
      await (await desk.connect(relay).buy(askId, d.abiEncodedClearValues, d.decryptionProof, box.handles[0]!, box.inputProof)).wait();
      return { bound, box, askId, boxHandle };
    }

    /** The desk's own cUSDC, read straight from the local coprocessor (mock only): a contract cannot sign. */
    const deskCusdc = async () => {
      const handle = await cUsdc.confidentialBalanceOf(deskAddress);
      return handle === ethers.ZeroHash ? 0n : fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
    };

    const holderOf = async (boxId: bigint) => ethers.getAddress(await fhevm.debugger.decryptEaddress(await vault.confidentialOwnerOf(boxId)));

    it("buys a private sale with a pocket: the box goes to the desk with the buyer's vault key", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("500"));
      const { boxId, saleId } = await offerToPocket(5, pa);

      // The pocket's viewer reads the price before buying.
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, (await vault.saleInfo(saleId)).price, vaultAddress, viewers[0]!)).to.eq(PRICE);
      const boxKey = randomKey();
      await buy(saleId, pa, aliceKey, boxKey);

      expect(await holderOf(boxId)).to.eq(deskAddress);
      expect(await balance(pa, 0)).to.eq(usd("300"));
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(PRICE - feeOf(PRICE));
      expect(await fhevm.userDecryptEuint(FhevmType.euint32, await desk.ownerOf(boxId), deskAddress, viewers[0]!)).to.eq(pa + 1n);
      expect(await fhevm.userDecryptEbool((await vault.saleInfo(saleId)).moved, vaultAddress, viewers[0]!)).to.eq(true);
      expect(await deskCusdc()).to.eq(0n);

      // The buyer's vault key now opens the box: the NFT comes out to a fresh address.
      const { nonce } = await vault.boxInfo(boxId);
      const terms = await vault.requestHash(boxId, nonce, ACTION_WITHDRAW, fresh.address, 0, 0, ethers.ZeroHash);
      const k = await fhevm.createEncryptedInput(vaultAddress, relay.address).add256(boxKey ^ terms).encrypt();
      const requestId = await vault.requestCount();
      await (await vault.connect(relay).request(boxId, ACTION_WITHDRAW, fresh.address, 0, 0, ethers.ZeroHash, k.handles[0]!, k.inputProof)).wait();
      const { ok } = await vault.requestInfo(requestId);
      const d = await fhevm.publicDecrypt([ok]);
      await (await vault.connect(relay).finalize(requestId, d.abiEncodedClearValues, d.decryptionProof)).wait();
      expect((await vault.requestInfo(requestId)).status).to.eq(REQUEST_DONE);
      expect(await nft.ownerOf(5)).to.eq(fresh.address);
    });

    it("buys nothing with a wrong key, and the sale stays open for the real buyer", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("500"));
      const { boxId, saleId } = await offerToPocket(5, pa);
      const { askId } = await buy(saleId, pa, randomKey(), randomKey());
      expect((await desk.askInfo(askId)).status).to.eq(3n);
      expect(await holderOf(boxId)).to.eq(bob.address);
      expect(await balance(pa, 0)).to.eq(usd("500"));
      expect((await vault.saleInfo(saleId)).status).to.eq(1n);
      // The real buyer still can.
      await buy(saleId, pa, aliceKey, randomKey());
      expect(await holderOf(boxId)).to.eq(deskAddress);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(PRICE - feeOf(PRICE));
    });

    it("buys nothing when the pocket cannot cover the price", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("150"));
      const { boxId, saleId } = await offerToPocket(5, pa);
      await buy(saleId, pa, aliceKey, randomKey());
      expect(await holderOf(boxId)).to.eq(bob.address);
      expect(await balance(pa, 0)).to.eq(usd("150"));
      expect((await vault.saleInfo(saleId)).status).to.eq(1n);
      expect(await deskCusdc()).to.eq(0n);
    });

    it("hands the price back to the pocket when the seller no longer holds the box", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("500"));
      const { boxId, saleId } = await offerToPocket(5, pa);
      // Bob gives the box away before the purchase.
      await (await vault.connect(bob).confidentialTransfer(carolAddress(), boxId)).wait();
      await buy(saleId, pa, aliceKey, randomKey());
      expect(await balance(pa, 0)).to.eq(usd("500"));
      expect(await deskCusdc()).to.eq(0n);
      expect(await fhevm.userDecryptEuint(FhevmType.euint32, await desk.ownerOf(boxId), deskAddress, viewers[0]!)).to.eq(0n);
    });

    it("only lets the seller reserve, a reserved sale be asked, and a bound key and an ask serve once", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("500"));
      const { saleId } = await offerToPocket(5, pa);
      await expect(desk.connect(alice).reserve(saleId, pa)).to.be.revertedWithCustomError(desk, "NotSeller");
      const { bound, box, askId, boxHandle } = await buy(saleId, pa, aliceKey, randomKey());
      await expect(desk.connect(relay).ask(saleId, bound.handles[0]!, bound.inputProof, boxHandle)).to.be.revertedWithCustomError(desk, "NotForDesk");
      await expect(desk.connect(relay).ask(saleId + 1n, bound.handles[0]!, bound.inputProof, boxHandle)).to.be.revertedWithCustomError(desk, "NotReserved");
      const d = await fhevm.publicDecrypt([(await desk.askInfo(askId)).ok]);
      await expect(desk.connect(relay).buy(askId, d.abiEncodedClearValues, d.decryptionProof, box.handles[0]!, box.inputProof)).to.be.revertedWithCustomError(desk, "AskNotPending");
    });

    it("refuses a box key other than the one the ask named", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("500"));
      const { saleId } = await offerToPocket(5, pa);
      const box = await fhevm.createEncryptedInput(vaultAddress, deskAddress).add256(randomKey()).encrypt();
      const other = await fhevm.createEncryptedInput(vaultAddress, deskAddress).add256(randomKey()).encrypt();
      const boxHandle = ethers.hexlify(box.handles[0]!);
      const bound = await fhevm.createEncryptedInput(deskAddress, relay.address).add256(aliceKey ^ (await desk.buyHash(saleId, pa, boxHandle))).encrypt();
      await (await desk.connect(relay).ask(saleId, bound.handles[0]!, bound.inputProof, boxHandle)).wait();
      const d = await fhevm.publicDecrypt([(await desk.askInfo(0)).ok]);
      await expect(desk.connect(relay).buy(0, d.abiEncodedClearValues, d.decryptionProof, other.handles[0]!, other.inputProof)).to.be.revertedWithCustomError(desk, "WrongBoxKey");
    });

    it("buys nothing when the pocket was spent between the ask and the purchase", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("250"));
      const { boxId, saleId } = await offerToPocket(5, pa);
      const box = await fhevm.createEncryptedInput(vaultAddress, deskAddress).add256(randomKey()).encrypt();
      const boxHandle = ethers.hexlify(box.handles[0]!);
      const bound = await fhevm.createEncryptedInput(deskAddress, relay.address).add256(aliceKey ^ (await desk.buyHash(saleId, pa, boxHandle))).encrypt();
      await (await desk.connect(relay).ask(saleId, bound.handles[0]!, bound.inputProof, boxHandle)).wait();
      await withdraw([pa], fresh.address, usd("100"), aliceKey);
      const d = await fhevm.publicDecrypt([(await desk.askInfo(0)).ok]);
      await (await desk.connect(relay).buy(0, d.abiEncodedClearValues, d.decryptionProof, box.handles[0]!, box.inputProof)).wait();
      // The pocket kept its 150, the box stayed with the seller, nobody was paid.
      expect(await balance(pa, 0)).to.eq(usd("150"));
      expect(await holderOf(boxId)).to.eq(bob.address);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(0n);
      expect(await deskCusdc()).to.eq(0n);
    });

    it("does not let tokens sent to the desk pay for a pocket that is short", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      const { boxId, saleId } = await offerToPocket(5, pa);
      // Someone drops cUSDC on the desk: it does not stand in for the pocket.
      await (await cUsdc.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
        deskAddress,
        ...(await (async () => {
          const i = await fhevm.createEncryptedInput(await cUsdc.getAddress(), alice.address).add64(usd("300")).encrypt();
          return [i.handles[0]!, i.inputProof] as const;
        })()),
      )).wait();
      const { askId } = await buy(saleId, pa, aliceKey, randomKey());
      expect((await desk.askInfo(askId)).status).to.eq(3n);
      expect(await holderOf(boxId)).to.eq(bob.address);
    });

    it("pays the vault's fee to the treasury on a pocket purchase", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("500"));
      const { saleId } = await offerToPocket(5, pa);
      await buy(saleId, pa, aliceKey, randomKey());
      expect(await confidentialUsdcOf(cUsdc, treasury)).to.eq(feeOf(PRICE));
    });

    it("follows the seller's latest reservation", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      const pb = await open(1, randomKey());
      await deposit(alice, [pa], pa, usd("500"));
      const { boxId, saleId } = await offerToPocket(5, pa);
      const box = await fhevm.createEncryptedInput(vaultAddress, deskAddress).add256(randomKey()).encrypt();
      const boxHandle = ethers.hexlify(box.handles[0]!);
      const bound = await fhevm.createEncryptedInput(deskAddress, relay.address).add256(aliceKey ^ (await desk.buyHash(saleId, pa, boxHandle))).encrypt();
      await (await desk.connect(relay).ask(saleId, bound.handles[0]!, bound.inputProof, boxHandle)).wait();
      await (await desk.connect(bob).reserve(saleId, pb)).wait();
      const d = await fhevm.publicDecrypt([(await desk.askInfo(0)).ok]);
      await expect(desk.connect(relay).buy(0, d.abiEncodedClearValues, d.decryptionProof, box.handles[0]!, box.inputProof)).to.be.revertedWithCustomError(desk, "NotReserved");
      expect(await holderOf(boxId)).to.eq(bob.address);
    });

    it("refuses to reserve a sale not offered to the desk, or for a pocket never opened", async function () {
      const pa = await open(0, randomKey());
      const { saleId } = await offerToPocket(5, pa);
      await expect(desk.connect(bob).reserve(saleId, 42)).to.be.revertedWithCustomError(pockets, "NotAPocket");
      await (await nft.mint(bob.address, 6)).wait();
      await (await nft.connect(bob).approve(vaultAddress, 6)).wait();
      const key = await fhevm.createEncryptedInput(vaultAddress, bob.address).add256(randomKey()).encrypt();
      const boxId = await vault.tokenCount();
      await (await vault.connect(bob).deposit(await nft.getAddress(), 6, key.handles[0]!, [], [], key.inputProof)).wait();
      const p = await fhevm.createEncryptedInput(vaultAddress, bob.address).add64(PRICE).encrypt();
      const other = await vault.saleCount();
      await (await vault.connect(bob).offerSale(boxId, alice.address, p.handles[0]!, p.inputProof)).wait();
      await expect(desk.connect(bob).reserve(other, pa)).to.be.revertedWithCustomError(desk, "NotForDesk");
    });

    it("stops a purchase whose sale the seller cancelled after the ask", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("500"));
      const { saleId } = await offerToPocket(5, pa);
      const box = await fhevm.createEncryptedInput(vaultAddress, deskAddress).add256(randomKey()).encrypt();
      const boxHandle = ethers.hexlify(box.handles[0]!);
      const bound = await fhevm.createEncryptedInput(deskAddress, relay.address).add256(aliceKey ^ (await desk.buyHash(saleId, pa, boxHandle))).encrypt();
      await (await desk.connect(relay).ask(saleId, bound.handles[0]!, bound.inputProof, boxHandle)).wait();
      await (await vault.connect(bob).cancelSale(saleId)).wait();
      const d = await fhevm.publicDecrypt([(await desk.askInfo(0)).ok]);
      await expect(desk.connect(relay).buy(0, d.abiEncodedClearValues, d.decryptionProof, box.handles[0]!, box.inputProof)).to.be.revertedWithCustomError(desk, "NotForDesk");
      expect(await balance(pa, 0)).to.eq(usd("500"));
    });

    it("rejects a forged decryption proof", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      const { saleId } = await offerToPocket(5, pa);
      const box = await fhevm.createEncryptedInput(vaultAddress, deskAddress).add256(randomKey()).encrypt();
      const boxHandle = ethers.hexlify(box.handles[0]!);
      const bound = await fhevm.createEncryptedInput(deskAddress, relay.address).add256(randomKey()).encrypt();
      await (await desk.connect(relay).ask(saleId, bound.handles[0]!, bound.inputProof, boxHandle)).wait();
      const d = await fhevm.publicDecrypt([(await desk.askInfo(0)).ok]);
      const lie = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
      await expect(desk.connect(relay).buy(0, lie, d.decryptionProof, box.handles[0]!, box.inputProof)).to.be.reverted;
    });

    it("buys within the HCU limits", async function () {
      const aliceKey = randomKey();
      const pa = await open(0, aliceKey);
      await deposit(alice, [pa], pa, usd("500"));
      const { saleId } = await offerToPocket(5, pa);
      const box = await fhevm.createEncryptedInput(vaultAddress, deskAddress).add256(randomKey()).encrypt();
      const boxHandle = ethers.hexlify(box.handles[0]!);
      const bound = await fhevm.createEncryptedInput(deskAddress, relay.address).add256(aliceKey ^ (await desk.buyHash(saleId, pa, boxHandle))).encrypt();
      const ar = (await (await desk.connect(relay).ask(saleId, bound.handles[0]!, bound.inputProof, boxHandle)).wait())!;
      const d = await fhevm.publicDecrypt([(await desk.askInfo(0)).ok]);
      const br = (await (await desk.connect(relay).buy(0, d.abiEncodedClearValues, d.decryptionProof, box.handles[0]!, box.inputProof)).wait())!;
      for (const r of [ar, br]) expect(fhevm.computeTransactionHCU(r).globalHCU).to.be.below(20_000_000);
      if (process.env.REPORT_COSTS) {
        console.table(
          [["PocketDesk.ask", ar], ["PocketDesk.buy", br]].map(([action, r]) => {
            const receipt = r as typeof ar;
            const h = fhevm.computeTransactionHCU(receipt);
            return { action, gas: Number(receipt.gasUsed), hcu: h.globalHCU, depth: h.maxHCUDepth };
          }),
        );
      }
    });

    it("refuses a desk move from anyone but the desk", async function () {
      const pa = await open(0, randomKey());
      await expect(pockets.connect(alice).deskGive(pa, ethers.ZeroHash)).to.be.revertedWithCustomError(pockets, "OnlyDesk");
      await expect(pockets.connect(alice).deskTake(pa, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(pockets, "OnlyDesk");
      await expect(pockets.connect(alice).deskCheck(pa, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(pockets, "OnlyDesk");
      await expect(pockets.connect(alice).deskTakeFrom([pa], ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(pockets, "OnlyDesk");
      await expect(pockets.connect(alice).deskGiveTo([pa], ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(pockets, "OnlyDesk");
      await expect(pockets.addDesk(deskAddress)).to.be.revertedWithCustomError(pockets, "DeskSet");
    });

    const carolAddress = () => ethers.Wallet.createRandom().address;
  });
});
