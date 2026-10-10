import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import { ethers, fhevm } from "hardhat";
import { SealedPockets, SealedPositions, TestConfidentialToken, TestERC20 } from "../types";
import { deployUniswap, openPool, seedFullRange, swap, type Uniswap } from "./uniswap";

const FEE = 3000;
const FEE_BPS = 500n;
const STATUS = { Funding: 1n, Open: 2n, Closed: 3n, Failed: 4n, Out: 5n } as const;
const FUNDING = { Pending: 1n, Done: 2n, Refunded: 3n } as const;
const ACTION = { Collect: 0, Decrease: 1, Give: 2, TakeOut: 3 } as const;
/** A pocket key, as the page derives one: any 256-bit secret. */
const randomKey = () => BigInt(ethers.hexlify(ethers.randomBytes(32)));
const coder = ethers.AbiCoder.defaultAbiCoder();
/** A controller, as the page derives one from a hash: a key that never holds ETH. */
const freshController = () => new Wallet(ethers.hexlify(ethers.randomBytes(32)));

/**
 * Two tokens as on Sepolia: a 6-decimal dollar and an 18-decimal ether, each wrapped into a
 * confidential token (6 decimals, so 10^12 plain wei per unit of cWETH) with its own pockets.
 * Positions are real Uniswap V3 positions, on Uniswap's own bytecode.
 */
describe("SealedPositions", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  /** Sends every open, settle and action for the holders: holds nothing. */
  let relay: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let trader: HardhatEthersSigner;
  let viewers: HardhatEthersSigner[];
  let u: Uniswap;
  let usd: TestERC20;
  let eth: TestERC20;
  let cUsd: TestConfidentialToken;
  let cEth: TestConfidentialToken;
  let usdPockets: SealedPockets;
  let ethPockets: SealedPockets;
  let positions: SealedPositions;
  let addr: string;
  /** Uniswap's order: token0 below token1, and which pockets hold each. */
  let token0: string;
  let token1: string;
  let pockets0: SealedPockets;
  let pockets1: SealedPockets;
  let tick: number;
  /** Plain units per confidential unit of token0 and token1. */
  let rate0: bigint;
  let rate1: bigint;

  const toUnits = (whole: string, decimals = 6) => ethers.parseUnits(whole, decimals);

  async function giveConfidential(token: TestERC20, wrapper: TestConfidentialToken, who: HardhatEthersSigner, plain: bigint, operator: string) {
    await (await token.mint(who.address, plain)).wait();
    await (await token.connect(who).approve(await wrapper.getAddress(), plain)).wait();
    await (await wrapper.connect(who).wrap(who.address, plain)).wait();
    await (await wrapper.connect(who).setOperator(operator, (await time.latest()) + 365 * 86_400)).wait();
  }

  /** Opens a pocket through the relay, read by `viewers[n]`. */
  async function openPocket(pockets: SealedPockets, n: number, key: bigint) {
    const input = await fhevm.createEncryptedInput(await pockets.getAddress(), relay.address).add256(key).encrypt();
    const id = await pockets.pocketCount();
    await (await pockets.connect(relay).open(input.handles[0]!, input.inputProof, viewers[n]!.address)).wait();
    return id;
  }

  async function deposit(pockets: SealedPockets, who: HardhatEthersSigner, set: bigint[], target: bigint, amount: bigint) {
    const input = await fhevm.createEncryptedInput(await pockets.getAddress(), who.address).add32(Number(target)).add64(amount).encrypt();
    await (await pockets.connect(who).deposit(set, input.handles[0]!, input.handles[1]!, input.inputProof)).wait();
  }

  const balance = async (pockets: SealedPockets, pocketId: bigint, n: number) =>
    fhevm.userDecryptEuint(FhevmType.euint64, await pockets.balanceOf(pocketId), await pockets.getAddress(), viewers[n]!);

  /** A holder: a pocket of each token (keys and viewers), and the decoys next to them. */
  interface Holder {
    key0: bigint;
    key1: bigint;
    p0: bigint;
    p1: bigint;
    n0: number;
    n1: number;
  }

  /** `n` picks the viewers: 2n for token0's pocket, 2n + 1 for token1's. Funds both pockets. */
  async function holder(n: number, who: HardhatEthersSigner, amount0: bigint, amount1: bigint): Promise<Holder> {
    const key0 = randomKey();
    const key1 = randomKey();
    const p0 = await openPocket(pockets0, 2 * n, key0);
    const p1 = await openPocket(pockets1, 2 * n + 1, key1);
    if (amount0 > 0n) await deposit(pockets0, who, [p0], p0, amount0);
    if (amount1 > 0n) await deposit(pockets1, who, [p1], p1, amount1);
    return { key0, key1, p0, p1, n0: 2 * n, n1: 2 * n + 1 };
  }

  const range = (lower = tick - 600, upper = tick + 600) => ({ token0, token1, fee: FEE, tickLower: lower, tickUpper: upper });

  /** What a page encrypts to fund a position: the amounts and targets, then both keys bound to the terms. */
  async function funds(h: Holder, amount0: bigint, amount1: bigint, bind: (f: never) => Promise<bigint>, opts: { set0?: bigint[]; set1?: bigint[]; key0?: bigint; key1?: bigint; deadline?: number } = {}) {
    const set0 = opts.set0 ?? [h.p0];
    const set1 = opts.set1 ?? [h.p1];
    const values = await fhevm.createEncryptedInput(addr, relay.address).add64(amount0).add64(amount1).add32(Number(h.p0)).add32(Number(h.p1)).encrypt();
    const f = {
      set0,
      set1,
      amount0: ethers.hexlify(values.handles[0]!),
      amount1: ethers.hexlify(values.handles[1]!),
      target0: ethers.hexlify(values.handles[2]!),
      target1: ethers.hexlify(values.handles[3]!),
      inputProof: values.inputProof,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: opts.deadline ?? (await time.latest()) + 3600,
    };
    const terms = await bind(f as never);
    const bound = await fhevm.createEncryptedInput(addr, relay.address).add256((opts.key0 ?? h.key0) ^ terms).add256((opts.key1 ?? h.key1) ^ terms).encrypt();
    return { f, k: { boundKey0: bound.handles[0]!, boundKey1: bound.handles[1]!, keyProof: bound.inputProof } };
  }

  /** Brings the unwraps' proofs. */
  async function settle(fundingId: bigint) {
    const fd = await positions.fundingInfo(fundingId);
    const d0 = await fhevm.publicDecrypt([fd.unwrap0]);
    const d1 = await fhevm.publicDecrypt([fd.unwrap1]);
    const clear = (d: { abiEncodedClearValues: string }) => coder.decode(["uint256"], d.abiEncodedClearValues)[0] as bigint;
    return (await positions.connect(relay).settle(fundingId, clear(d0), d0.decryptionProof, clear(d1), d1.decryptionProof)).wait();
  }

  /** Opens a position for `h` steered by `controller`, and settles it. */
  async function openPosition(h: Holder, controller: Wallet, amount0: bigint, amount1: bigint, r = range()) {
    const { f, k } = await funds(h, amount0, amount1, (f) => positions.openHash(controller.address, r, f));
    const positionId = await positions.positionCount();
    const fundingId = await positions.fundingCount();
    const openReceipt = (await (await positions.connect(relay).open(r, controller.address, f, k)).wait())!;
    const settleReceipt = (await settle(fundingId))!;
    return { positionId, fundingId, openReceipt, settleReceipt };
  }

  /** Where tokens coming out go: the holder's own pockets, among `decoys`. */
  async function out(h: Holder, set0 = [h.p0], set1 = [h.p1]) {
    const values = await fhevm.createEncryptedInput(addr, relay.address).add32(Number(h.p0)).add32(Number(h.p1)).encrypt();
    return { set0, set1, target0: ethers.hexlify(values.handles[0]!), target1: ethers.hexlify(values.handles[1]!), inputProof: values.inputProof };
  }

  async function sign(controller: Wallet, positionId: bigint, action: number, terms: string) {
    const deadline = (await time.latest()) + 3600;
    const digest = await positions.actDigest(positionId, action, terms, deadline);
    return { deadline, signature: controller.signingKey.sign(digest).serialized };
  }

  async function collect(controller: Wallet, positionId: bigint, o: Awaited<ReturnType<typeof out>>) {
    const { deadline, signature } = await sign(controller, positionId, ACTION.Collect, await positions.outHash(o));
    return (await positions.connect(relay).collect(positionId, o, deadline, signature)).wait();
  }

  async function decrease(controller: Wallet, positionId: bigint, liquidity: bigint, o: Awaited<ReturnType<typeof out>>) {
    const terms = ethers.keccak256(coder.encode(["uint128", "uint256", "uint256", "bytes32"], [liquidity, 0, 0, await positions.outHash(o)]));
    const { deadline, signature } = await sign(controller, positionId, ACTION.Decrease, terms);
    return (await positions.connect(relay).decrease(positionId, liquidity, 0, 0, o, deadline, signature)).wait();
  }

  const liquidityOf = async (tokenId: bigint) => (await u.positionManager.positions!(tokenId)).liquidity as bigint;
  /** Lots of trading back and forth across the range: fees for the positions in it. */
  async function trade(rounds = 3) {
    for (let i = 0; i < rounds; i++) {
      await swap(u, trader, token0, token1, FEE, (await asErc20(token0).decimals()) === 6n ? toUnits("20000") : toUnits("10", 18));
      await swap(u, trader, token1, token0, FEE, (await asErc20(token1).decimals()) === 6n ? toUnits("20000") : toUnits("10", 18));
    }
  }
  const asErc20 = (a: string) => (a === String(usd.target) ? usd : eth);

  beforeEach(async function () {
    const signers = (await ethers.getSigners()) as HardhatEthersSigner[];
    [deployer, alice, bob, relay, treasury, trader] = signers as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    viewers = signers.slice(10, 20);
    u = await deployUniswap(deployer);
    const erc20 = await ethers.getContractFactory("TestERC20");
    usd = (await erc20.deploy("USD Coin (Test)", "USDC", 6)) as unknown as TestERC20;
    eth = (await erc20.deploy("Wrapped Ether (Test)", "WETH", 18)) as unknown as TestERC20;
    const wrapper = await ethers.getContractFactory("TestConfidentialToken");
    cUsd = (await wrapper.deploy(await usd.getAddress(), "Confidential USDC", "cUSDC")) as unknown as TestConfidentialToken;
    cEth = (await wrapper.deploy(await eth.getAddress(), "Confidential WETH", "cWETH")) as unknown as TestConfidentialToken;
    const pocketsFactory = await ethers.getContractFactory("SealedPockets");
    usdPockets = (await pocketsFactory.deploy(await cUsd.getAddress(), deployer.address)) as unknown as SealedPockets;
    ethPockets = (await pocketsFactory.deploy(await cEth.getAddress(), deployer.address)) as unknown as SealedPockets;
    positions = (await (await ethers.getContractFactory("SealedPositions")).deploy(await u.positionManager.getAddress(), treasury.address, deployer.address, FEE_BPS)) as unknown as SealedPositions;
    addr = await positions.getAddress();
    for (const p of [usdPockets, ethPockets]) {
      await (await p.addDesk(addr)).wait();
      await (await positions.addPockets(await p.getAddress())).wait();
    }

    // 2,000 dollars an ether, a deep full-range pool around it.
    const opened = await openPool(u, await usd.getAddress(), await eth.getAddress(), FEE, 1e18 / 2000e6);
    ({ token0, token1, tick } = opened);
    const usdFirst = opened.aFirst;
    [pockets0, pockets1] = usdFirst ? [usdPockets, ethPockets] : [ethPockets, usdPockets];
    [rate0, rate1] = usdFirst ? [1n, 10n ** 12n] : [10n ** 12n, 1n];
    await (await usd.mint(deployer.address, toUnits("10000000"))).wait();
    await (await eth.mint(deployer.address, toUnits("5000", 18))).wait();
    const [seed0, seed1] = usdFirst ? [toUnits("4000000"), toUnits("2000", 18)] : [toUnits("2000", 18), toUnits("4000000")];
    await seedFullRange(u, deployer, token0, token1, FEE, seed0, seed1);
    await (await usd.mint(trader.address, toUnits("1000000"))).wait();
    await (await eth.mint(trader.address, toUnits("1000", 18))).wait();

    for (const who of [alice, bob]) {
      await giveConfidential(usd, cUsd, who, toUnits("100000"), await usdPockets.getAddress());
      await giveConfidential(eth, cEth, who, toUnits("50", 18), await ethPockets.getAddress());
    }
  });

  /** Confidential units of token0 and token1 for `dollars` and `ethers`, in Uniswap's order. */
  const amounts = (dollars: string, ethers_: string): [bigint, bigint] => {
    const d = toUnits(dollars);
    const e = toUnits(ethers_);
    return pockets0 === usdPockets ? [d, e] : [e, d];
  };

  describe("open", function () {
    it("opens a Uniswap position out of two pockets, held here, and gives the leftovers back", async function () {
      const [a0, a1] = amounts("4000", "1");
      const h = await holder(0, alice, a0, a1);
      const controller = freshController();
      const { positionId, fundingId } = await openPosition(h, controller, a0, a1);

      const p = await positions.positionInfo(positionId);
      expect(p.status).to.eq(STATUS.Open);
      expect(p.controller).to.eq(controller.address);
      expect(await positions.positionOf(controller.address)).to.eq(positionId + 1n);
      expect(await u.positionManager.ownerOf!(p.tokenId)).to.eq(addr);
      expect(await liquidityOf(p.tokenId)).to.be.greaterThan(0n);
      expect((await positions.fundingInfo(fundingId)).status).to.eq(FUNDING.Done);

      // What Uniswap took left the pockets; the rest came back, to the unit (below a unit, dust stays).
      const settled = (await positions.queryFilter(positions.filters.Settled(fundingId)))[0]!.args;
      expect(settled.ok).to.eq(true);
      const spent0 = (settled.amount0 + rate0 - 1n) / rate0;
      const spent1 = (settled.amount1 + rate1 - 1n) / rate1;
      expect(await balance(pockets0, h.p0, h.n0)).to.eq(a0 - spent0);
      expect(await balance(pockets1, h.p1, h.n1)).to.eq(a1 - spent1);
      // One side is used up to the unit, the other only in part.
      expect(spent0 === a0 || spent1 === a1).to.eq(true);
    });

    it("hides the paying pockets among decoys, whose balances stay as they were", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0, a1);
      const other = await holder(1, bob, a0, a1);
      const controller = freshController();
      const r = range();
      const set0 = [h.p0, other.p0].sort((x, y) => Number(x - y));
      const set1 = [h.p1, other.p1].sort((x, y) => Number(x - y));
      const { f, k } = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f), { set0, set1 });
      await expect(positions.connect(relay).open(r, controller.address, f, k)).to.emit(positions, "Funded").withArgs(0, 0, set0, set1);
      await settle(0n);
      expect(await balance(pockets0, other.p0, other.n0)).to.eq(a0);
      expect(await balance(pockets1, other.p1, other.n1)).to.eq(a1);
      expect((await positions.positionInfo(0)).status).to.eq(STATUS.Open);
    });

    it("takes nothing from either side when one key is wrong, and the position fails", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0, a1);
      const controller = freshController();
      const r = range();
      const { f, k } = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f), { key1: randomKey() });
      await (await positions.connect(relay).open(r, controller.address, f, k)).wait();
      // The unwraps are of nothing: a refused funding reveals zeros.
      const fd = await positions.fundingInfo(0);
      expect((await fhevm.publicDecrypt([fd.unwrap0])).clearValues[fd.unwrap0 as `0x${string}`]).to.eq(0n);
      await settle(0n);
      expect((await positions.positionInfo(0)).status).to.eq(STATUS.Failed);
      expect((await positions.fundingInfo(0)).status).to.eq(FUNDING.Refunded);
      expect(await balance(pockets0, h.p0, h.n0)).to.eq(a0);
      expect(await balance(pockets1, h.p1, h.n1)).to.eq(a1);
    });

    it("takes nothing when one pocket is short", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0, a1 / 2n);
      const controller = freshController();
      await openPosition(h, controller, a0, a1);
      expect((await positions.positionInfo(0)).status).to.eq(STATUS.Failed);
      expect(await balance(pockets0, h.p0, h.n0)).to.eq(a0);
      expect(await balance(pockets1, h.p1, h.n1)).to.eq(a1 / 2n);
    });

    it("binds the keys to every term: a relayer that swaps the controller or the range moves nothing", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0, a1);
      const controller = freshController();
      const r = range();
      const { f, k } = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f));
      const thief = freshController();
      await (await positions.connect(relay).open(r, thief.address, f, k)).wait();
      await settle(0n);
      expect((await positions.positionInfo(0)).status).to.eq(STATUS.Failed);
      expect(await balance(pockets0, h.p0, h.n0)).to.eq(a0);
      // The same inputs cannot be sent again, with the right terms or not.
      await expect(positions.connect(relay).open(r, controller.address, f, k)).to.be.revertedWithCustomError(positions, "KeyUsed");
      const wide = range(tick - 1200, tick + 1200);
      const again = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f));
      await (await positions.connect(relay).open(wide, controller.address, again.f, again.k)).wait();
      await settle(1n);
      expect((await positions.positionInfo(1)).status).to.eq(STATUS.Failed);
      expect(await balance(pockets1, h.p1, h.n1)).to.eq(a1);
    });

    it("gives everything back when Uniswap refuses the mint (the deadline passed)", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0, a1);
      const controller = freshController();
      const r = range();
      const { f, k } = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f), { deadline: (await time.latest()) + 60 });
      await (await positions.connect(relay).open(r, controller.address, f, k)).wait();
      await time.increase(120);
      await settle(0n);
      expect((await positions.positionInfo(0)).status).to.eq(STATUS.Failed);
      expect(await balance(pockets0, h.p0, h.n0)).to.eq(a0);
      expect(await balance(pockets1, h.p1, h.n1)).to.eq(a1);
    });

    it("settles once, even when someone finalized an unwrap on the token first", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0, a1);
      const controller = freshController();
      const r = range();
      const { f, k } = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f));
      await (await positions.connect(relay).open(r, controller.address, f, k)).wait();
      const fd = await positions.fundingInfo(0);
      const d0 = await fhevm.publicDecrypt([fd.unwrap0]);
      const wrapper0 = pockets0 === usdPockets ? cUsd : cEth;
      await (await wrapper0.connect(bob).finalizeUnwrap(fd.unwrap0, coder.decode(["uint256"], d0.abiEncodedClearValues)[0], d0.decryptionProof)).wait();
      await settle(0n);
      expect((await positions.positionInfo(0)).status).to.eq(STATUS.Open);
      await expect(settle(0n)).to.be.revertedWithCustomError(positions, "FundingNotPending");
    });

    it("rejects a forged cleartext", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0, a1);
      const controller = freshController();
      const r = range();
      const { f, k } = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f));
      await (await positions.connect(relay).open(r, controller.address, f, k)).wait();
      const fd = await positions.fundingInfo(0);
      const d0 = await fhevm.publicDecrypt([fd.unwrap0]);
      const d1 = await fhevm.publicDecrypt([fd.unwrap1]);
      await expect(positions.connect(relay).settle(0, a0 * 10n, d0.decryptionProof, 0, d1.decryptionProof)).to.be.reverted;
    });

    it("refuses a used controller, a pool without pockets and a reversed range", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0 * 2n, a1 * 2n);
      const controller = freshController();
      await openPosition(h, controller, a0, a1);
      const r = range();
      const { f, k } = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f));
      await expect(positions.connect(relay).open(r, controller.address, f, k)).to.be.revertedWithCustomError(positions, "ControllerUsed");
      const stranger = await (await ethers.getContractFactory("TestERC20")).deploy("Other", "OTH", 18);
      const [x0, x1] = BigInt(await stranger.getAddress()) < BigInt(token1) ? [await stranger.getAddress(), token1] : [token1, await stranger.getAddress()];
      await expect(positions.connect(relay).open({ ...r, token0: x0, token1: x1 }, freshController().address, f, k)).to.be.revertedWithCustomError(positions, "NotATokenHere");
      await expect(positions.connect(relay).open({ ...r, tickLower: r.tickUpper, tickUpper: r.tickLower }, freshController().address, f, k)).to.be.revertedWithCustomError(positions, "BadRange");
    });

    it("needs to be a desk of the pockets", async function () {
      const lone = (await (await ethers.getContractFactory("SealedPockets")).deploy(await cUsd.getAddress(), deployer.address)) as unknown as SealedPockets;
      const other = (await (await ethers.getContractFactory("SealedPositions")).deploy(await u.positionManager.getAddress(), treasury.address, deployer.address, FEE_BPS)) as unknown as SealedPositions;
      await (await other.addPockets(await lone.getAddress())).wait();
      await expect(other.addPockets(await lone.getAddress())).to.be.revertedWithCustomError(other, "SideSet");
      await expect(lone.connect(alice).deskTakeFrom([0], ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(lone, "OnlyDesk");
    });

    it("adds liquidity to an open position, out of anyone's pockets", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0, a1);
      const g = await holder(1, bob, a0, a1);
      const controller = freshController();
      const { positionId } = await openPosition(h, controller, a0, a1);
      const tokenId = (await positions.positionInfo(positionId)).tokenId;
      const before = await liquidityOf(tokenId);
      const { f, k } = await funds(g, a0, a1, (f) => positions.addHash(positionId, f));
      await (await positions.connect(relay).add(positionId, f, k)).wait();
      await settle(1n);
      expect(await liquidityOf(tokenId)).to.be.greaterThan(before);
      expect((await positions.fundingInfo(1)).status).to.eq(FUNDING.Done);
    });

    it("opens within the HCU limits", async function () {
      const [a0, a1] = amounts("2000", "1");
      const h = await holder(0, alice, a0, a1);
      const decoys = [];
      for (let i = 1; i <= 4; i++) decoys.push(await holder(i, bob, 0n, 0n));
      const set0 = [h.p0, ...decoys.map((d) => d.p0)].sort((x, y) => Number(x - y));
      const set1 = [h.p1, ...decoys.map((d) => d.p1)].sort((x, y) => Number(x - y));
      const controller = freshController();
      const r = range();
      const { f, k } = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f), { set0, set1 });
      const openReceipt = (await (await positions.connect(relay).open(r, controller.address, f, k)).wait())!;
      const settleReceipt = (await settle(0n))!;
      await trade();
      const o = await out(h, set0, set1);
      const collectReceipt = (await collect(controller, 0n, o))!;
      for (const receipt of [openReceipt, settleReceipt, collectReceipt]) {
        const h = fhevm.computeTransactionHCU(receipt);
        expect(h.globalHCU).to.be.below(20_000_000);
        expect(h.maxHCUDepth).to.be.below(5_000_000);
      }
      if (process.env.REPORT_COSTS) {
        console.table(
          [
            ["SealedPositions.open (5 + 5 pockets)", openReceipt],
            ["SealedPositions.settle (mint)", settleReceipt],
            ["SealedPositions.collect (5 + 5 pockets)", collectReceipt],
          ].map(([action, r]) => {
            const receipt = r as typeof openReceipt;
            const h = fhevm.computeTransactionHCU(receipt);
            return { action, gas: Number(receipt.gasUsed), hcu: h.globalHCU, depth: h.maxHCUDepth };
          }),
        );
      }
    });
  });

  // REPORT_COSTS=1: the table in docs/VAULT.md, sets of 1, 3 and 5 pockets a side.
  (process.env.REPORT_COSTS ? it : it.skip)("reports what each action costs", async function () {
    const rows: [string, Awaited<ReturnType<typeof settle>>][] = [];
    const [a0, a1] = amounts("4000", "2");
    const others = [];
    for (let i = 1; i <= 4; i++) others.push(await holder(i, bob, 0n, 0n));
    const h = await holder(0, alice, a0, a1);
    for (const size of [1, 3, 5]) {
      const set0 = [h.p0, ...others.slice(0, size - 1).map((d) => d.p0)].sort((x, y) => Number(x - y));
      const set1 = [h.p1, ...others.slice(0, size - 1).map((d) => d.p1)].sort((x, y) => Number(x - y));
      const controller = freshController();
      const r = range();
      const { f, k } = await funds(h, a0, a1, (f) => positions.openHash(controller.address, r, f), { set0, set1 });
      const positionId = await positions.positionCount();
      const fundingId = await positions.fundingCount();
      rows.push([`open, ${size} + ${size} pockets`, (await (await positions.connect(relay).open(r, controller.address, f, k)).wait())!]);
      rows.push([`settle (mint), ${size} + ${size}`, (await settle(fundingId))!]);
      await trade();
      rows.push([`collect, ${size} + ${size}`, (await collect(controller, positionId, await out(h, set0, set1)))!]);
      if (size === 1) {
        const tokenId = (await positions.positionInfo(positionId)).tokenId;
        const liq = await liquidityOf(tokenId);
        rows.push(["decrease half, 1 + 1", (await decrease(controller, positionId, liq / 2n, await out(h)))!]);
        rows.push(["decrease the rest (closes), 1 + 1", (await decrease(controller, positionId, liq - liq / 2n, await out(h)))!]);
      }
      // Pockets are refilled for the next size: the position took them.
      await deposit(pockets0, alice, [h.p0], h.p0, a0);
      await deposit(pockets1, alice, [h.p1], h.p1, a1);
      if (size === 3) {
        const next = freshController();
        const g = await sign(controller, positionId, ACTION.Give, ethers.keccak256(coder.encode(["address"], [next.address])));
        rows.push(["give", (await (await positions.connect(relay).give(positionId, next.address, g.deadline, g.signature)).wait())!]);
        const to = freshController().address;
        const o = await sign(next, positionId, ACTION.TakeOut, ethers.keccak256(coder.encode(["address"], [to])));
        rows.push(["takeOut", (await (await positions.connect(relay).takeOut(positionId, to, o.deadline, o.signature)).wait())!]);
      }
    }
    console.table(
      rows.map(([action, r]) => {
        const h = fhevm.computeTransactionHCU(r!);
        return { action, gas: Number(r!.gasUsed), hcu: h.globalHCU, depth: h.maxHCUDepth };
      }),
    );
  });

  describe("holders", function () {
    let h: Holder;
    let controller: Wallet;
    let positionId: bigint;
    let tokenId: bigint;
    let left0: bigint;
    let left1: bigint;

    beforeEach(async function () {
      const [a0, a1] = amounts("4000", "2");
      h = await holder(0, alice, a0, a1);
      controller = freshController();
      ({ positionId } = await openPosition(h, controller, a0, a1));
      tokenId = (await positions.positionInfo(positionId)).tokenId;
      left0 = await balance(pockets0, h.p0, h.n0);
      left1 = await balance(pockets1, h.p1, h.n1);
    });

    it("collects the trading fees into the holder's pockets, the treasury's share in the clear", async function () {
      await trade();
      const o = await out(h);
      const receipt = (await collect(controller, positionId, o))!;
      const ev = (await positions.queryFilter(positions.filters.Collected(positionId), receipt.blockNumber, receipt.blockNumber))[0]!.args;
      expect(ev.amount0).to.be.greaterThan(0n);
      expect(ev.amount1).to.be.greaterThan(0n);
      expect(ev.fee0).to.eq((ev.amount0 * FEE_BPS) / 10_000n);
      expect(await asErc20(token0).balanceOf(treasury.address)).to.eq(ev.fee0);
      expect(await asErc20(token1).balanceOf(treasury.address)).to.eq(ev.fee1);
      expect(await balance(pockets0, h.p0, h.n0)).to.eq(left0 + (ev.amount0 - ev.fee0) / rate0);
      expect(await balance(pockets1, h.p1, h.n1)).to.eq(left1 + (ev.amount1 - ev.fee1) / rate1);
      // The liquidity stays.
      expect((await positions.positionInfo(positionId)).status).to.eq(STATUS.Open);
    });

    it("pays into the target among decoys only", async function () {
      const other = await holder(1, bob, 0n, 0n);
      await trade();
      const set0 = [h.p0, other.p0].sort((x, y) => Number(x - y));
      const set1 = [h.p1, other.p1].sort((x, y) => Number(x - y));
      await collect(controller, positionId, await out(h, set0, set1));
      expect(await balance(pockets0, other.p0, other.n0)).to.eq(0n);
      expect(await balance(pockets1, other.p1, other.n1)).to.eq(0n);
      expect(await balance(pockets0, h.p0, h.n0)).to.be.greaterThan(left0);
    });

    it("only obeys its controller, once per signature", async function () {
      const o = await out(h);
      const stranger = freshController();
      const forged = await sign(stranger, positionId, ACTION.Collect, await positions.outHash(o));
      await expect(positions.connect(relay).collect(positionId, o, forged.deadline, forged.signature)).to.be.revertedWithCustomError(positions, "NotController");
      const { deadline, signature } = await sign(controller, positionId, ACTION.Collect, await positions.outHash(o));
      await (await positions.connect(relay).collect(positionId, o, deadline, signature)).wait();
      await expect(positions.connect(relay).collect(positionId, o, deadline, signature)).to.be.revertedWithCustomError(positions, "NotController");
      // A signature for other pockets does not send the fees elsewhere.
      const elsewhere = await out(await holder(1, bob, 0n, 0n));
      const signed = await sign(controller, positionId, ACTION.Collect, await positions.outHash(o));
      await expect(positions.connect(relay).collect(positionId, elsewhere, signed.deadline, signed.signature)).to.be.revertedWithCustomError(positions, "NotController");
    });

    it("refuses a signature past its deadline", async function () {
      const o = await out(h);
      const { deadline, signature } = await sign(controller, positionId, ACTION.Collect, await positions.outHash(o));
      await time.increaseTo(deadline + 1);
      await expect(positions.connect(relay).collect(positionId, o, deadline, signature)).to.be.revertedWithCustomError(positions, "Expired");
    });

    it("takes part of the liquidity out into the pockets, then the rest, which closes it", async function () {
      const liquidity = await liquidityOf(tokenId);
      await decrease(controller, positionId, liquidity / 2n, await out(h));
      expect(await liquidityOf(tokenId)).to.eq(liquidity - liquidity / 2n);
      const mid0 = await balance(pockets0, h.p0, h.n0);
      expect(mid0).to.be.greaterThan(left0);
      await expect(decrease(controller, positionId, liquidity - liquidity / 2n, await out(h))).to.emit(positions, "Closed").withArgs(positionId);
      expect((await positions.positionInfo(positionId)).status).to.eq(STATUS.Closed);
      expect(await positions.positionOf(controller.address)).to.eq(0n);
      await expect(u.positionManager.ownerOf!(tokenId)).to.be.reverted;
      // Everything is back but Uniswap's rounding, a unit or two.
      const [a0, a1] = amounts("4000", "2");
      expect(a0 - (await balance(pockets0, h.p0, h.n0))).to.be.lessThan(3n);
      expect(a1 - (await balance(pockets1, h.p1, h.n1))).to.be.lessThan(3n);
    });

    it("gives the trading fees' share to the treasury when liquidity comes out, never the liquidity's", async function () {
      await trade();
      const liquidity = await liquidityOf(tokenId);
      const receipt = (await decrease(controller, positionId, liquidity, await out(h)))!;
      const fees = (await positions.queryFilter(positions.filters.Collected(positionId), receipt.blockNumber, receipt.blockNumber))[0]!.args;
      expect(await asErc20(token0).balanceOf(treasury.address)).to.eq(fees.fee0);
      expect(fees.fee0).to.eq((fees.amount0 * FEE_BPS) / 10_000n);
    });

    it("hands the position to another controller", async function () {
      const next = freshController();
      const terms = ethers.keccak256(coder.encode(["address"], [next.address]));
      const { deadline, signature } = await sign(controller, positionId, ACTION.Give, terms);
      await expect(positions.connect(relay).give(positionId, next.address, deadline, signature)).to.emit(positions, "Given").withArgs(positionId, next.address);
      expect(await positions.positionOf(next.address)).to.eq(positionId + 1n);
      expect(await positions.positionOf(controller.address)).to.eq(0n);
      const b = await holder(1, bob, 0n, 0n);
      const o = await out(b);
      const old = await sign(controller, positionId, ACTION.Collect, await positions.outHash(o));
      await expect(positions.connect(relay).collect(positionId, o, old.deadline, old.signature)).to.be.revertedWithCustomError(positions, "NotController");
      await trade();
      await collect(next, positionId, o);
      expect(await balance(pockets0, b.p0, b.n0)).to.be.greaterThan(0n);
      // A controller steers one position, once: it cannot be handed back to the first.
      const back = await sign(next, positionId, ACTION.Give, ethers.keccak256(coder.encode(["address"], [controller.address])));
      await expect(positions.connect(relay).give(positionId, controller.address, back.deadline, back.signature)).to.be.revertedWithCustomError(positions, "ControllerUsed");
    });

    it("takes the Uniswap NFT out to any address", async function () {
      const to = freshController().address;
      const { deadline, signature } = await sign(controller, positionId, ACTION.TakeOut, ethers.keccak256(coder.encode(["address"], [to])));
      await expect(positions.connect(relay).takeOut(positionId, to, deadline, signature)).to.emit(positions, "TakenOut").withArgs(positionId, to);
      expect(await u.positionManager.ownerOf!(tokenId)).to.eq(to);
      expect((await positions.positionInfo(positionId)).status).to.eq(STATUS.Out);
      const o = await out(h);
      const late = await sign(controller, positionId, ACTION.Collect, await positions.outHash(o));
      await expect(positions.connect(relay).collect(positionId, o, late.deadline, late.signature)).to.be.revertedWithCustomError(positions, "NotOpen");
    });

    it("refuses actions on a position that never opened", async function () {
      await expect(positions.connect(relay).collect(99, await out(h), 0, "0x")).to.be.revertedWithCustomError(positions, "NotAPosition");
    });
  });

  describe("deposit", function () {
    it("takes an existing Uniswap position, its sender public, and collects it into pockets", async function () {
      const h = await holder(0, alice, 0n, 0n);
      // Alice minted a position on Uniswap herself, with plain tokens.
      const npm = u.positionManager.connect(alice) as Contract;
      for (const t of [token0, token1]) {
        await (await asErc20(t).mint(alice.address, t === String(usd.target) ? toUnits("4000") : toUnits("2", 18))).wait();
        await (await asErc20(t).connect(alice).approve(await npm.getAddress(), ethers.MaxUint256)).wait();
      }
      const r = range();
      const minted = await (
        await npm.mint!({
          ...r,
          amount0Desired: await asErc20(token0).balanceOf(alice.address),
          amount1Desired: await asErc20(token1).balanceOf(alice.address),
          amount0Min: 0,
          amount1Min: 0,
          recipient: alice.address,
          deadline: (await time.latest()) + 3600,
        })
      ).wait();
      const tokenId = npm.interface.parseLog(minted.logs.find((l: { address: string }) => l.address === String(npm.target)))!.args.tokenId as bigint;
      const controller = freshController();
      const data = coder.encode(["address"], [controller.address]);
      await expect(npm["safeTransferFrom(address,address,uint256,bytes)"]!(alice.address, addr, tokenId, data)).to.emit(positions, "Deposited").withArgs(0, alice.address, tokenId);
      const p = await positions.positionInfo(0);
      expect(p.status).to.eq(STATUS.Open);
      expect(p.range.tickLower).to.eq(r.tickLower);
      await trade();
      await collect(controller, 0n, await out(h));
      expect(await balance(pockets0, h.p0, h.n0)).to.be.greaterThan(0n);
    });

    it("refuses an NFT that is not a Uniswap position", async function () {
      const nft = await (await ethers.getContractFactory("TestERC721")).deploy();
      await (await nft.mint(alice.address, 1)).wait();
      await expect(
        nft.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](alice.address, addr, 1, coder.encode(["address"], [freshController().address])),
      ).to.be.reverted;
    });
  });

  describe("owner", function () {
    it("caps the fee at 10% and needs a treasury", async function () {
      await expect(positions.setFee(1001)).to.be.revertedWithCustomError(positions, "FeeTooHigh");
      await expect(positions.setFee(1000)).to.emit(positions, "FeeSet").withArgs(1000);
      await expect(positions.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(positions, "ZeroAddress");
      await expect(positions.connect(alice).setFee(0)).to.be.revertedWithCustomError(positions, "OwnableUnauthorizedAccount");
      await expect(positions.connect(alice).addPockets(await usdPockets.getAddress())).to.be.revertedWithCustomError(positions, "OwnableUnauthorizedAccount");
    });

    it("lists the tokens it takes, with their pockets", async function () {
      expect(await positions.tokens()).to.deep.eq([await usd.getAddress(), await eth.getAddress()]);
      const side = await positions.sideOf(await eth.getAddress());
      expect(side.pockets).to.eq(await ethPockets.getAddress());
      expect(side.rate).to.eq(10n ** 12n);
    });
  });
});
