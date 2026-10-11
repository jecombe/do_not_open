import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { PocketSavings, SealedPockets, TestConfidentialShare, TestConfidentialUSDC, TestUSDC, TestVaultBatcher, TestYieldVault } from "../types";
import { usd } from "./tokens";

const SIDE = { Save: 0, Unsave: 1 } as const;
const WINDOW = { Open: 0, Joined: 1, Settled: 2, Canceled: 3 } as const;
const BATCH = { Pending: 0, Dispatched: 1, Finalized: 2, Canceled: 3 } as const;
/** 1 USDC gives 0.98 share; 1 share gives 1.02 USDC. */
const DEPOSIT_RATE = 980_000n;
const REDEEM_RATE = 1_020_000n;
const RATE_ONE = 1_000_000n;
const randomKey = () => BigInt(ethers.hexlify(ethers.randomBytes(32)));

describe("PocketSavings", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  /** Sends opens, saves and the windows' joins and settlements: holds no pocket. */
  let relay: HardhatEthersSigner;
  let viewers: HardhatEthersSigner[];
  let usdc: TestUSDC;
  let cUsdc: TestConfidentialUSDC;
  let share: TestConfidentialShare;
  let yieldVault: TestYieldVault;
  let depositBatcher: TestVaultBatcher;
  let redeemBatcher: TestVaultBatcher;
  let pockets: SealedPockets;
  let savings: PocketSavings;
  let pocketsAddr: string;
  let addr: string;

  async function giveCusdc(who: HardhatEthersSigner, amount: bigint, operators: string[]) {
    await (await usdc.mint(who.address, amount)).wait();
    await (await usdc.connect(who).approve(await cUsdc.getAddress(), amount)).wait();
    await (await cUsdc.connect(who).wrap(who.address, amount)).wait();
    for (const o of operators) await (await cUsdc.connect(who).setOperator(o, (await time.latest()) + 365 * 86_400)).wait();
  }

  async function open(n: number, key: bigint) {
    const input = await fhevm.createEncryptedInput(pocketsAddr, relay.address).add256(key).encrypt();
    const id = await pockets.pocketCount();
    await (await pockets.connect(relay).open(input.handles[0]!, input.inputProof, viewers[n]!.address)).wait();
    return id;
  }

  async function deposit(who: HardhatEthersSigner, set: bigint[], target: bigint, amount: bigint) {
    const input = await fhevm.createEncryptedInput(pocketsAddr, who.address).add32(Number(target)).add64(amount).encrypt();
    await (await pockets.connect(who).deposit(set, input.handles[0]!, input.handles[1]!, input.inputProof)).wait();
  }

  const balance = async (pocketId: bigint, n: number) => fhevm.userDecryptEuint(FhevmType.euint64, await pockets.balanceOf(pocketId), pocketsAddr, viewers[n]!);
  const sharesOf = async (pocketId: bigint, n: number) => {
    const handle = await savings.sharesOf(pocketId);
    return handle === ethers.ZeroHash ? 0n : fhevm.userDecryptEuint(FhevmType.euint64, handle, addr, viewers[n]!);
  };
  const committedOf = async (windowId: bigint | number, pocketId: bigint, n: number) => {
    const handle = await savings.committedOf(windowId, pocketId);
    return handle === ethers.ZeroHash ? null : fhevm.userDecryptEuint(FhevmType.euint64, handle, addr, viewers[n]!);
  };
  /** The savings' own cUSDC or shares, read straight from the local coprocessor (mock only). */
  const held = async (token: TestConfidentialUSDC | TestConfidentialShare, who = addr) => {
    const handle = await token.confidentialBalanceOf(who);
    return handle === ethers.ZeroHash ? 0n : fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  };

  /** What a page encrypts for a save or an unsave: the amount, then the key bound to its handle. */
  async function spendInput(side: number, from: bigint[], amount: bigint, key: bigint, sender = relay) {
    const values = await fhevm.createEncryptedInput(addr, sender.address).add64(amount).encrypt();
    const a = ethers.hexlify(values.handles[0]!);
    const hash = await savings.saveHash(side, from, a);
    const bound = await fhevm.createEncryptedInput(addr, sender.address).add256(key ^ hash).encrypt();
    return { amount: a, inputProof: values.inputProof, boundKey: bound.handles[0]!, keyProof: bound.inputProof };
  }

  async function save(from: bigint[], amount: bigint, key: bigint) {
    const s = await spendInput(SIDE.Save, from, amount, key);
    await (await savings.connect(relay).save(from, s)).wait();
    return s;
  }

  async function unsave(from: bigint[], amount: bigint, key: bigint) {
    const s = await spendInput(SIDE.Unsave, from, amount, key);
    await (await savings.connect(relay).unsave(from, s)).wait();
    return s;
  }

  /** Zama's side of a batch: dispatched, its total decrypted by the KMS, settled with the proof. */
  async function runBatch(batcher: TestVaultBatcher, batchId: bigint) {
    await (await batcher.dispatchBatch()).wait();
    const total = await batcher.totalDeposits(batchId);
    const d = await fhevm.publicDecrypt([total]);
    const [clear] = ethers.AbiCoder.defaultAbiCoder().decode(["uint64"], d.abiEncodedClearValues);
    await (await batcher.dispatchBatchCallback(batchId, clear, d.decryptionProof)).wait();
    return clear as bigint;
  }

  /** The relayer's round: joins the side's open window, waits for the batch, settles the window and every pocket of it. */
  async function round(side: number) {
    const windowId = await savings.openWindow(side);
    await (await savings.connect(relay).join(side)).wait();
    const { batchId } = await savings.windowInfo(windowId);
    const batcher = side === SIDE.Save ? depositBatcher : redeemBatcher;
    await runBatch(batcher, batchId);
    await (await savings.connect(relay).settle(windowId)).wait();
    await (await savings.connect(relay).settlePockets(windowId, [...(await savings.windowPockets(windowId))])).wait();
    return windowId;
  }

  beforeEach(async function () {
    const signers = (await ethers.getSigners()) as HardhatEthersSigner[];
    [deployer, alice, , relay] = signers as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    viewers = signers.slice(10, 16);
    usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    cUsdc = (await (await ethers.getContractFactory("TestConfidentialUSDC")).deploy(await usdc.getAddress())) as unknown as TestConfidentialUSDC;
    pockets = (await (await ethers.getContractFactory("SealedPockets")).deploy(await cUsdc.getAddress(), deployer.address, 5)) as unknown as SealedPockets;
    pocketsAddr = await pockets.getAddress();
    yieldVault = (await (await ethers.getContractFactory("TestYieldVault")).deploy(await usdc.getAddress(), 1_020_000n)) as unknown as TestYieldVault;
    share = (await (await ethers.getContractFactory("TestConfidentialShare")).deploy(await yieldVault.getAddress())) as unknown as TestConfidentialShare;
    const Batcher = await ethers.getContractFactory("TestVaultBatcher");
    depositBatcher = (await Batcher.deploy(await yieldVault.getAddress(), await cUsdc.getAddress(), await share.getAddress(), DEPOSIT_RATE, 0)) as unknown as TestVaultBatcher;
    redeemBatcher = (await Batcher.deploy(await yieldVault.getAddress(), await share.getAddress(), await cUsdc.getAddress(), REDEEM_RATE, 0)) as unknown as TestVaultBatcher;
    savings = (await (await ethers.getContractFactory("PocketSavings")).deploy(pocketsAddr, await depositBatcher.getAddress(), await redeemBatcher.getAddress())) as unknown as PocketSavings;
    addr = await savings.getAddress();
    await (await pockets.setSavings(addr)).wait();
    // The batchers pay their claims from their own balances: shares for the deposits, cUSDC for the redeems.
    await (await share.mint(await depositBatcher.getAddress(), usd("1000000"))).wait();
    await (await usdc.mint(deployer.address, usd("1000000"))).wait();
    await (await usdc.approve(await cUsdc.getAddress(), usd("1000000"))).wait();
    await (await cUsdc.wrap(await redeemBatcher.getAddress(), usd("1000000"))).wait();
    await giveCusdc(alice, usd("1000"), [pocketsAddr]);
  });

  it("wires the pockets' token, the batchers' tokens and two open windows", async function () {
    expect(await savings.token()).to.eq(await cUsdc.getAddress());
    expect(await savings.share()).to.eq(await share.getAddress());
    expect(await savings.windowCount()).to.eq(2n);
    expect(await savings.openWindow(SIDE.Save)).to.eq(0n);
    expect(await savings.openWindow(SIDE.Unsave)).to.eq(1n);
    expect((await savings.windowInfo(0)).side).to.eq(BigInt(SIDE.Save));
    expect((await savings.windowInfo(1)).side).to.eq(BigInt(SIDE.Unsave));
    expect(await cUsdc.isOperator(addr, await depositBatcher.getAddress())).to.eq(true);
    expect(await share.isOperator(addr, await redeemBatcher.getAddress())).to.eq(true);
    // Batchers whose tokens do not match the pockets' are refused.
    const Batcher = await ethers.getContractFactory("TestVaultBatcher");
    const wrong = await Batcher.deploy(await yieldVault.getAddress(), await share.getAddress(), await share.getAddress(), REDEEM_RATE, 0);
    await expect((await ethers.getContractFactory("PocketSavings")).deploy(pocketsAddr, await depositBatcher.getAddress(), await wrong.getAddress())).to.be.revertedWithCustomError(savings, "WrongRoute");
    // The pockets take their savings once.
    await expect(pockets.setSavings(addr)).to.be.revertedWithCustomError(pockets, "SavingsSet");
    await expect(savings.windowInfo(7)).to.be.revertedWithCustomError(savings, "NoWindow");
  });

  it("puts a pocket's cUSDC aside among decoys, joins the batch as one participant, and credits its shares once the batch settles", async function () {
    const key = randomKey();
    const pa = await open(0, key);
    const d1 = await open(1, randomKey());
    const d2 = await open(2, randomKey());
    await deposit(alice, [pa], pa, usd("500"));
    const set = [pa, d1, d2];

    const s = await spendInput(SIDE.Save, set, usd("100"), key);
    await expect(savings.connect(relay).save(set, s)).to.emit(savings, "Saved").withArgs(0, set);
    expect(await balance(pa, 0)).to.eq(usd("400"));
    expect(await held(cUsdc)).to.eq(usd("100"));
    // Every pocket of the set has a commitment; only the key's is not zero, and only its viewer reads it.
    expect(await savings.windowPockets(0)).to.deep.eq(set);
    expect(await committedOf(0, pa, 0)).to.eq(usd("100"));
    expect(await committedOf(0, d1, 1)).to.eq(0n);
    expect(await committedOf(0, d2, 2)).to.eq(0n);
    expect((await savings.windowInfo(0)).pocketCount).to.eq(3n);

    // The relayer joins the window: the batcher gets one participant with an encrypted total.
    await expect(savings.connect(relay).join(SIDE.Save)).to.emit(savings, "WindowJoined").withArgs(0, 1);
    expect(await held(cUsdc)).to.eq(0n);
    expect(await held(cUsdc, await depositBatcher.getAddress())).to.eq(usd("100"));
    let w = await savings.windowInfo(0);
    expect(w.state).to.eq(BigInt(WINDOW.Joined));
    expect(w.batchId).to.eq(1n);
    expect(await savings.openWindow(SIDE.Save)).to.eq(2n);
    expect(await savings.lastBatch(SIDE.Save)).to.eq(1n);

    // Zama's batch: only the total is decrypted.
    expect(await runBatch(depositBatcher, 1n)).to.eq(usd("100"));
    expect(await depositBatcher.batchState(1)).to.eq(BATCH.Finalized);
    await expect(savings.connect(relay).settle(0)).to.emit(savings, "WindowSettled").withArgs(0, WINDOW.Settled, DEPOSIT_RATE);
    expect(await held(share)).to.eq((usd("100") * DEPOSIT_RATE) / RATE_ONE);
    w = await savings.windowInfo(0);
    expect(w.rate).to.eq(DEPOSIT_RATE);
    expect(w.left).to.eq(3n);

    // Each pocket of the window gets its part: the shares for the one that saved, zero for the decoys.
    await expect(savings.connect(relay).settlePockets(0, set)).to.emit(savings, "PocketSettled").withArgs(0, pa);
    expect(await sharesOf(pa, 0)).to.eq((usd("100") * DEPOSIT_RATE) / RATE_ONE);
    expect(await sharesOf(d1, 1)).to.eq(0n);
    expect(await sharesOf(d2, 2)).to.eq(0n);
    expect(await committedOf(0, pa, 0)).to.eq(null);
    expect((await savings.windowInfo(0)).left).to.eq(0n);
    // The shares stay here, under the pockets' names; the pocket's cUSDC balance is untouched.
    expect(await balance(pa, 0)).to.eq(usd("400"));
  });

  it("brings the savings back as cUSDC through the redeem batcher, at the batch's rate", async function () {
    const key = randomKey();
    const pa = await open(0, key);
    const d1 = await open(1, randomKey());
    await deposit(alice, [pa], pa, usd("500"));
    await save([pa, d1], usd("100"), key);
    await round(SIDE.Save);
    const shares = (usd("100") * DEPOSIT_RATE) / RATE_ONE;
    expect(await sharesOf(pa, 0)).to.eq(shares);

    // Half the shares back. The unsave window lists both pockets; only the key's committed shares.
    const half = shares / 2n;
    const u = await spendInput(SIDE.Unsave, [pa, d1], half, key);
    await expect(savings.connect(relay).unsave([pa, d1], u)).to.emit(savings, "Unsaved").withArgs(1, [pa, d1]);
    expect(await sharesOf(pa, 0)).to.eq(shares - half);
    expect(await committedOf(1, pa, 0)).to.eq(half);
    expect(await committedOf(1, d1, 1)).to.eq(0n);
    await round(SIDE.Unsave);
    expect(await balance(pa, 0)).to.eq(usd("400") + (half * REDEEM_RATE) / RATE_ONE);
    expect(await balance(d1, 1)).to.eq(0n);
    expect(await sharesOf(pa, 0)).to.eq(shares - half);
    // Nothing of the pockets' is left in the savings but rounding dust.
    expect(await held(cUsdc)).to.eq(0n);
    expect(await held(share)).to.eq(shares - half);
  });

  it("saves nothing with a wrong key or a short balance, and asks nothing back beyond the shares, without a revert", async function () {
    const key = randomKey();
    const pa = await open(0, key);
    const d1 = await open(1, randomKey());
    await deposit(alice, [pa], pa, usd("500"));
    await save([pa, d1], usd("100"), randomKey());
    expect(await balance(pa, 0)).to.eq(usd("500"));
    expect(await committedOf(0, pa, 0)).to.eq(0n);
    await save([pa, d1], usd("600"), key);
    expect(await balance(pa, 0)).to.eq(usd("500"));
    expect(await committedOf(0, pa, 0)).to.eq(0n);
    // A window of zeros still joins; the batch sees nothing, cancels, and the pockets get their zeros back.
    await round(SIDE.Save);
    expect((await savings.windowInfo(0)).state).to.eq(BigInt(WINDOW.Canceled));
    expect(await balance(pa, 0)).to.eq(usd("500"));
    expect(await sharesOf(pa, 0)).to.eq(0n);

    // Unsaving more shares than held, or with a wrong key, moves nothing either.
    await save([pa, d1], usd("100"), key);
    await round(SIDE.Save);
    const shares = (usd("100") * DEPOSIT_RATE) / RATE_ONE;
    await unsave([pa, d1], shares + 1n, key);
    await unsave([pa, d1], shares, randomKey());
    expect(await sharesOf(pa, 0)).to.eq(shares);
    expect(await committedOf(await savings.openWindow(SIDE.Unsave), pa, 0)).to.eq(0n);
  });

  it("gives every pocket its commitment back when the batch is canceled, on both sides", async function () {
    const key = randomKey();
    const pa = await open(0, key);
    const d1 = await open(1, randomKey());
    await deposit(alice, [pa], pa, usd("500"));
    await save([pa, d1], usd("100"), key);
    await (await savings.connect(relay).join(SIDE.Save)).wait();
    await (await depositBatcher.cancel(1)).wait();
    await expect(savings.connect(relay).settle(0)).to.emit(savings, "WindowSettled").withArgs(0, WINDOW.Canceled, 0);
    expect(await held(cUsdc)).to.eq(usd("100"));
    await (await savings.connect(relay).settlePockets(0, [pa, d1])).wait();
    expect(await balance(pa, 0)).to.eq(usd("500"));
    expect(await balance(d1, 1)).to.eq(0n);
    expect(await sharesOf(pa, 0)).to.eq(0n);
    expect(await held(cUsdc)).to.eq(0n);

    // The redeem side: the shares come back to the pocket's share balance.
    await save([pa, d1], usd("100"), key);
    await round(SIDE.Save);
    const shares = (usd("100") * DEPOSIT_RATE) / RATE_ONE;
    await unsave([pa, d1], shares, key);
    expect(await sharesOf(pa, 0)).to.eq(0n);
    const windowId = await savings.openWindow(SIDE.Unsave);
    await (await savings.connect(relay).join(SIDE.Unsave)).wait();
    await (await redeemBatcher.cancel((await savings.windowInfo(windowId)).batchId)).wait();
    await (await savings.connect(relay).settle(windowId)).wait();
    await (await savings.connect(relay).settlePockets(windowId, [pa, d1])).wait();
    expect(await sharesOf(pa, 0)).to.eq(shares);
    expect(await balance(pa, 0)).to.eq(usd("400"));
  });

  it("joins one window per batch, and keeps the window's steps in order", async function () {
    const key = randomKey();
    const pa = await open(0, key);
    await deposit(alice, [pa], pa, usd("500"));
    await expect(savings.connect(relay).join(SIDE.Save)).to.be.revertedWithCustomError(savings, "EmptyWindow");
    await save([pa], usd("10"), key);
    await expect(savings.connect(relay).settle(0)).to.be.revertedWithCustomError(savings, "WindowNotJoined");
    await expect(savings.connect(relay).settlePockets(0, [pa])).to.be.revertedWithCustomError(savings, "WindowNotSettled");
    await (await savings.connect(relay).join(SIDE.Save)).wait();
    // The next window takes the next save, and cannot join the same batch.
    await save([pa], usd("10"), key);
    expect(await savings.openWindow(SIDE.Save)).to.eq(2n);
    expect(await committedOf(2, pa, 0)).to.eq(usd("10"));
    await expect(savings.connect(relay).join(SIDE.Save)).to.be.revertedWithCustomError(savings, "BatchAlreadyJoined").withArgs(1);
    await expect(savings.connect(relay).settle(0)).to.be.revertedWithCustomError(savings, "BatchNotDone").withArgs(0, BATCH.Pending);
    await runBatch(depositBatcher, 1n);
    // Now batch 2 is open: the second window joins it.
    await (await savings.connect(relay).join(SIDE.Save)).wait();
    expect((await savings.windowInfo(2)).batchId).to.eq(2n);
    await (await savings.connect(relay).settle(0)).wait();
    await expect(savings.connect(relay).settle(0)).to.be.revertedWithCustomError(savings, "WindowNotJoined");
    await (await savings.connect(relay).settlePockets(0, [pa])).wait();
    await expect(savings.connect(relay).settlePockets(0, [pa])).to.be.revertedWithCustomError(savings, "NotCommitted").withArgs(0, pa);
    expect(await sharesOf(pa, 0)).to.eq((usd("10") * DEPOSIT_RATE) / RATE_ONE);
    // Two saves of one pocket in a window add up, listing the pocket once.
    await save([pa], usd("5"), key);
    await save([pa], usd("7"), key);
    const open3 = await savings.openWindow(SIDE.Save);
    expect(await savings.windowPockets(open3)).to.deep.eq([pa]);
    expect(await committedOf(open3, pa, 0)).to.eq(usd("12"));
    expect(await balance(pa, 0)).to.eq(usd("468"));
  });

  it("runs a bound key once, and moves nothing when the relay changes the set or the amount", async function () {
    const key = randomKey();
    const pa = await open(0, key);
    const d1 = await open(1, randomKey());
    const d2 = await open(2, randomKey());
    await deposit(alice, [pa], pa, usd("500"));
    const s = await save([pa, d1], usd("10"), key);
    await expect(savings.connect(relay).save([pa, d1], s)).to.be.revertedWithCustomError(savings, "KeyUsed");
    // The same input as an unsave is another action: refused too.
    await expect(savings.connect(relay).unsave([pa, d1], s)).to.be.revertedWithCustomError(savings, "KeyUsed");
    const other = await spendInput(SIDE.Save, [pa, d1], usd("10"), key);
    await (await savings.connect(relay).save([pa, d1, d2], other)).wait();
    expect(await balance(pa, 0)).to.eq(usd("490"));
    const bigger = await spendInput(SIDE.Save, [pa], usd("10"), key);
    const forged = await fhevm.createEncryptedInput(addr, relay.address).add64(usd("400")).encrypt();
    await (await savings.connect(relay).save([pa], { ...bigger, amount: forged.handles[0]!, inputProof: forged.inputProof })).wait();
    expect(await balance(pa, 0)).to.eq(usd("490"));
    // Sets as the pockets check them.
    await expect(savings.connect(relay).save([d1, pa], other)).to.be.revertedWithCustomError(savings, "BadSet");
    await expect(savings.connect(relay).save([], other)).to.be.revertedWithCustomError(savings, "BadSet");
    await expect(savings.connect(relay).save([pa, 9n], other)).to.be.revertedWithCustomError(savings, "NotAPocket");
    // Only the desk and the savings move a pocket's balance.
    await expect(pockets.connect(relay).deskGive(pa, ethers.ZeroHash)).to.be.revertedWithCustomError(pockets, "OnlyDesk");
  });

  describe("limits and costs", function () {
    const HCU_LIMIT = 20_000_000;
    const HCU_DEPTH_LIMIT = 5_000_000;

    it("saves over a full set of five, and settles five pockets, within the HCU limits", async function () {
      const key = randomKey();
      const ids: bigint[] = [await open(0, key)];
      for (let i = 1; i < 5; i++) ids.push(await open(i, randomKey()));
      await deposit(alice, [ids[0]!], ids[0]!, usd("100"));
      const s = await spendInput(SIDE.Save, ids, usd("40"), key);
      const saved = (await (await savings.connect(relay).save(ids, s)).wait())!;
      let hcu = fhevm.computeTransactionHCU(saved);
      expect(hcu.globalHCU).to.be.below(HCU_LIMIT);
      expect(hcu.maxHCUDepth).to.be.below(HCU_DEPTH_LIMIT);
      await (await savings.connect(relay).join(SIDE.Save)).wait();
      await runBatch(depositBatcher, 1n);
      await (await savings.connect(relay).settle(0)).wait();
      const settled = (await (await savings.connect(relay).settlePockets(0, ids)).wait())!;
      hcu = fhevm.computeTransactionHCU(settled);
      expect(hcu.globalHCU).to.be.below(HCU_LIMIT);
      expect(hcu.maxHCUDepth).to.be.below(HCU_DEPTH_LIMIT);
      expect(await sharesOf(ids[0]!, 0)).to.eq((usd("40") * DEPOSIT_RATE) / RATE_ONE);
      const u = await spendInput(SIDE.Unsave, ids, usd("10"), key);
      const unsaved = (await (await savings.connect(relay).unsave(ids, u)).wait())!;
      hcu = fhevm.computeTransactionHCU(unsaved);
      expect(hcu.globalHCU).to.be.below(HCU_LIMIT);
      expect(hcu.maxHCUDepth).to.be.below(HCU_DEPTH_LIMIT);
    });

    it("prints gas and HCU per action (REPORT_COSTS=1)", async function () {
      if (!process.env.REPORT_COSTS) this.skip();
      const rows: { action: string; gas: number; hcu: number; depth: number }[] = [];
      const measure = async (action: string, tx: Promise<{ wait: () => Promise<unknown> }>) => {
        const r = (await (await tx).wait()) as Parameters<typeof fhevm.computeTransactionHCU>[0] & { gasUsed: bigint };
        const h = fhevm.computeTransactionHCU(r);
        rows.push({ action, gas: Number(r.gasUsed), hcu: h.globalHCU, depth: h.maxHCUDepth });
      };
      const key = randomKey();
      const ids: bigint[] = [await open(0, key)];
      for (let i = 1; i < 5; i++) ids.push(await open(i, randomKey()));
      await deposit(alice, [ids[0]!], ids[0]!, usd("500"));
      for (const n of [1, 3, 5]) {
        const s = await spendInput(SIDE.Save, ids.slice(0, n), usd("10"), key);
        await measure(`save (set of ${n})`, savings.connect(relay).save(ids.slice(0, n), s));
      }
      await measure("join", savings.connect(relay).join(SIDE.Save));
      await runBatch(depositBatcher, 1n);
      await measure("settle", savings.connect(relay).settle(0));
      for (const n of [1, 3]) await measure(`settlePockets (${n})`, savings.connect(relay).settlePockets(0, n === 1 ? [ids[0]!] : ids.slice(1, 4)));
      await measure("settlePockets (1 more)", savings.connect(relay).settlePockets(0, [ids[4]!]));
      for (const n of [1, 3, 5]) {
        const s = await spendInput(SIDE.Unsave, ids.slice(0, n), usd("1"), key);
        await measure(`unsave (set of ${n})`, savings.connect(relay).unsave(ids.slice(0, n), s));
      }
      console.table(rows);
    });
  });
});
