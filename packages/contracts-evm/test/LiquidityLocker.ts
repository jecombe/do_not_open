import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { Contract, ContractFactory, FunctionFragment } from "ethers";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import {
  croqPriceAtTick,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  planSingleSided,
  POOL_ABI,
  POSITION_MANAGER_ABI,
  seedSingleSided,
  sqrtRatioAtTick,
  type SingleSidedPlan,
} from "../lib/uniswapV3";
import { Croq, LiquidityLocker, TestERC721, TestUSDC } from "../types";

/** Uniswap's own builds, the bytecode deployed on every network. */
function artifact(path: string) {
  const json = JSON.parse(readFileSync(require.resolve(path), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode as string };
}
const UNISWAP = {
  factory: artifact("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
  pool: artifact("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json"),
  positionManager: artifact("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
  router: artifact("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json"),
  quoter: artifact("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json"),
};

const FEE = 10_000;
const LIQUIDITY = 4_000_000n;
const START = "0.001";
const RANGE = 1000;
const usd = (amount: string) => ethers.parseUnits(amount, 6);
/** An hour after the chain's own clock, which other suites may have moved ahead. */
const deadline = async () => (await time.latest()) + 3600;

async function deployUniswap(deployer: HardhatEthersSigner) {
  const make = async (a: { abi: unknown[]; bytecode: string }, ...args: unknown[]) => {
    const c = await new ContractFactory(a.abi as never, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c as unknown as Contract;
  };
  // Nothing here wraps ETH: any address does for WETH9, and for the NFT descriptor.
  const weth = deployer.address;
  const factory = await make(UNISWAP.factory);
  const factoryAddress = await factory.getAddress();
  const positionManager = await make(UNISWAP.positionManager, factoryAddress, weth, weth);
  const router = await make(UNISWAP.router, factoryAddress, weth);
  const quoter = await make(UNISWAP.quoter, factoryAddress, weth);
  return { factory, positionManager, router, quoter };
}

describe("Uniswap V3 tick math", function () {
  it("matches TickMath's bounds", function () {
    expect(sqrtRatioAtTick(MIN_TICK)).to.equal(MIN_SQRT_RATIO);
    expect(sqrtRatioAtTick(MAX_TICK)).to.equal(MAX_SQRT_RATIO);
    expect(sqrtRatioAtTick(0)).to.equal(1n << 96n);
    expect(() => sqrtRatioAtTick(MAX_TICK + 1)).to.throw();
    expect(() => sqrtRatioAtTick(MIN_TICK - 1)).to.throw();
    expect(() => sqrtRatioAtTick(1.5)).to.throw();
  });

  it("puts a real pool exactly on the tick, and one unit lower on the tick below", async function () {
    const [deployer] = await ethers.getSigners();
    const { factory } = await deployUniswap(deployer!);
    const usdc = await ethers.getContractFactory("TestUSDC");
    const base = await (await usdc.deploy()).getAddress();
    const ticks = [MIN_TICK + 1, -500_000, -69_077, -201, -1, 0, 1, 200, 69_077, 276_324, 500_000, MAX_TICK - 1];
    for (const tick of ticks) {
      for (const shift of [0n, -1n]) {
        const other = await (await usdc.deploy()).getAddress();
        await (await factory.createPool!(base, other, 500)).wait();
        const pool = new Contract(await factory.getPool!(base, other, 500), UNISWAP.pool.abi, deployer);
        await (await pool.initialize!(sqrtRatioAtTick(tick) + shift)).wait();
        const [, actual] = await pool.slot0!();
        expect(Number(actual), `tick ${tick}, shift ${shift}`).to.equal(tick + Number(shift));
      }
    }
  });
});

describe("planSingleSided", function () {
  const LOW = "0x1000000000000000000000000000000000000000";
  const HIGH = "0xf000000000000000000000000000000000000000";
  const base = { croqDecimals: 0, quoteDecimals: 6, startPrice: START, rangeFactor: RANGE, fee: FEE, croqAmount: LIQUIDITY };

  it("sells CROQ as the price rises when CROQ is token0", function () {
    const plan = planSingleSided({ ...base, croq: LOW, quote: HIGH });
    expect(plan.croqIsToken0).to.equal(true);
    expect([plan.token0, plan.token1]).to.deep.equal([LOW, HIGH]);
    expect([plan.amount0Desired, plan.amount1Desired]).to.deep.equal([LIQUIDITY, 0n]);
    expect(plan.tickLower % 200).to.equal(0);
    expect(plan.tickUpper % 200).to.equal(0);
    expect(plan.sqrtPriceX96).to.equal(sqrtRatioAtTick(plan.tickLower));
    const start = croqPriceAtTick(plan.tickLower, true, 0, 6);
    expect(start).to.be.at.least(0.001 * (1 - 1e-9)).and.below(0.001 * 1.0001 ** 200);
    const end = croqPriceAtTick(plan.tickUpper, true, 0, 6);
    expect(end / start).to.be.closeTo(RANGE, RANGE * 0.02);
  });

  it("sells CROQ as the price falls when CROQ is token1", function () {
    const plan = planSingleSided({ ...base, croq: HIGH, quote: LOW });
    expect(plan.croqIsToken0).to.equal(false);
    expect([plan.token0, plan.token1]).to.deep.equal([LOW, HIGH]);
    expect([plan.amount0Desired, plan.amount1Desired]).to.deep.equal([0n, LIQUIDITY]);
    expect(plan.sqrtPriceX96).to.equal(sqrtRatioAtTick(plan.tickUpper));
    const start = croqPriceAtTick(plan.tickUpper, false, 0, 6);
    expect(start).to.be.at.least(0.001 * (1 - 1e-9)).and.below(0.001 * 1.0001 ** 200);
    const end = croqPriceAtTick(plan.tickLower, false, 0, 6);
    expect(end / start).to.be.closeTo(RANGE, RANGE * 0.02);
  });

  it("refuses what Uniswap cannot do", function () {
    const ok = { ...base, croq: LOW, quote: HIGH };
    expect(() => planSingleSided({ ...ok, fee: 2500 })).to.throw(/fee tier/);
    expect(() => planSingleSided({ ...ok, startPrice: "0" })).to.throw(/positive/);
    expect(() => planSingleSided({ ...ok, startPrice: "abc" })).to.throw(/positive/);
    expect(() => planSingleSided({ ...ok, rangeFactor: 1 })).to.throw(/above 1/);
    expect(() => planSingleSided({ ...ok, croqAmount: 0n })).to.throw(/nothing/);
    expect(() => planSingleSided({ ...ok, startPrice: "1e40" })).to.throw(/outside/);
  });
});

describe("LiquidityLocker", function () {
  let deployer: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let uni: Awaited<ReturnType<typeof deployUniswap>>;
  let npmAddress: string;

  before(async function () {
    [deployer, treasury, alice, bob] = (await ethers.getSigners()) as HardhatEthersSigner[];
    uni = await deployUniswap(deployer);
    npmAddress = await uni.positionManager.getAddress();
  });

  const newLocker = async (owner = deployer.address) =>
    (await (await ethers.getContractFactory("LiquidityLocker")).deploy(npmAddress, treasury.address, owner)) as unknown as LiquidityLocker;

  describe("on its own", function () {
    it("needs a position manager and a beneficiary", async function () {
      const factory = await ethers.getContractFactory("LiquidityLocker");
      await expect(factory.deploy(ethers.ZeroAddress, treasury.address, deployer.address)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(npmAddress, ethers.ZeroAddress, deployer.address)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(npmAddress, treasury.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "OwnableInvalidOwner");
      const locker = await newLocker();
      expect(await locker.positionManager()).to.equal(npmAddress);
      expect(await locker.beneficiary()).to.equal(treasury.address);
      expect(await locker.owner()).to.equal(deployer.address);
      expect(await locker.positions()).to.deep.equal([]);
    });

    it("takes no NFT but the position manager's", async function () {
      const locker = await newLocker();
      const nft = (await (await ethers.getContractFactory("TestERC721")).deploy()) as unknown as TestERC721;
      await nft.mint(alice.address, 1);
      await expect(
        nft.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, await locker.getAddress(), 1),
      ).to.be.revertedWithCustomError(locker, "NotPositionManager");
      await expect(locker.connect(alice).onERC721Received(alice.address, alice.address, 1, "0x")).to.be.revertedWithCustomError(
        locker,
        "NotPositionManager",
      );
    });

    it("lets only its owner change the beneficiary, never to nobody", async function () {
      const locker = await newLocker();
      await expect(locker.connect(alice).setBeneficiary(alice.address)).to.be.revertedWithCustomError(locker, "OwnableUnauthorizedAccount");
      await expect(locker.setBeneficiary(ethers.ZeroAddress)).to.be.revertedWithCustomError(locker, "ZeroAddress");
      await expect(locker.setBeneficiary(bob.address)).to.emit(locker, "BeneficiaryChanged").withArgs(treasury.address, bob.address);
      expect(await locker.beneficiary()).to.equal(bob.address);
    });

    it("hands ownership over in two steps", async function () {
      const locker = await newLocker();
      await locker.transferOwnership(alice.address);
      expect(await locker.owner()).to.equal(deployer.address);
      await expect(locker.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(locker, "OwnableUnauthorizedAccount");
      await locker.connect(alice).acceptOwnership();
      expect(await locker.owner()).to.equal(alice.address);
      await expect(locker.setBeneficiary(bob.address)).to.be.revertedWithCustomError(locker, "OwnableUnauthorizedAccount");
    });

    it("collects only for a position it holds", async function () {
      const locker = await newLocker();
      // Position 999 does not exist: the manager's ownerOf reverts.
      await expect(locker.collect(999)).to.be.reverted;
    });

    it("has no way to take liquidity out", async function () {
      const locker = await newLocker();
      const functions = locker.interface.fragments
        .filter((f): f is FunctionFragment => f.type === "function")
        .map((f) => f.name)
        .sort();
      expect(functions).to.deep.equal([
        "acceptOwnership",
        "beneficiary",
        "collect",
        "onERC721Received",
        "owner",
        "pendingOwner",
        "positionManager",
        "positions",
        "renounceOwnership",
        "setBeneficiary",
        "transferOwnership",
      ]);
    });
  });

  for (const croqFirst of [true, false]) {
    describe(`a CROQ-only market, CROQ as token${croqFirst ? 0 : 1}`, function () {
      let croq: Croq;
      let usdc: TestUSDC;
      let croqAddress: string;
      let usdcAddress: string;
      let locker: LiquidityLocker;
      let plan: SingleSidedPlan;
      let pool: Contract;
      let positionId: bigint;
      let npm: Contract;

      /** Swaps through Uniswap's router, `amountIn` of `tokenIn`, for `who`. */
      async function swap(who: HardhatEthersSigner, tokenIn: string, amountIn: bigint) {
        const tokenOut = tokenIn === usdcAddress ? croqAddress : usdcAddress;
        const token = tokenIn === usdcAddress ? usdc : croq;
        await token.connect(who).approve(await uni.router.getAddress(), amountIn);
        return (uni.router.connect(who) as Contract).exactInputSingle!({
          tokenIn,
          tokenOut,
          fee: FEE,
          recipient: who.address,
          deadline: await deadline(),
          amountIn,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0,
        });
      }
      const quote = async (tokenIn: string, amountIn: bigint): Promise<bigint> => {
        const tokenOut = tokenIn === usdcAddress ? croqAddress : usdcAddress;
        const [out] = await uni.quoter.quoteExactInputSingle!.staticCall({ tokenIn, tokenOut, amountIn, fee: FEE, sqrtPriceLimitX96: 0 });
        return out;
      };
      const sqrtPrice = async (): Promise<bigint> => (await pool.slot0!())[0];
      /** True when CROQ costs at least what the range starts at. */
      const atOrAboveStart = (p: bigint) => (croqFirst ? p >= plan.sqrtPriceX96 : p <= plan.sqrtPriceX96);

      beforeEach(async function () {
        croq = (await (await ethers.getContractFactory("Croq")).deploy(20_000_000n, deployer.address)) as unknown as Croq;
        croqAddress = await croq.getAddress();
        // Redeploy USDC until the address order puts CROQ where this case wants it.
        for (;;) {
          usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
          usdcAddress = await usdc.getAddress();
          if (BigInt(croqAddress) < BigInt(usdcAddress) === croqFirst) break;
        }
        locker = await newLocker();
        plan = planSingleSided({
          croq: croqAddress,
          quote: usdcAddress,
          croqDecimals: 0,
          quoteDecimals: 6,
          startPrice: START,
          rangeFactor: RANGE,
          fee: FEE,
          croqAmount: LIQUIDITY,
        });
        expect(plan.croqIsToken0).to.equal(croqFirst);
        const seeded = await seedSingleSided(deployer, npmAddress, await locker.getAddress(), plan);
        positionId = seeded.positionId;
        pool = new Contract(seeded.pool, POOL_ABI, deployer);
        npm = new Contract(npmAddress, POSITION_MANAGER_ABI, deployer);
        await usdc.mint(alice.address, usd("1000000"));
      });

      it("takes CROQ only, and the locker holds the position", async function () {
        expect(await usdc.balanceOf(deployer.address)).to.equal(0n);
        expect(await usdc.balanceOf(await pool.getAddress())).to.equal(0n);
        const pooled = await croq.balanceOf(await pool.getAddress());
        expect(pooled).to.be.at.most(LIQUIDITY).and.at.least(LIQUIDITY - LIQUIDITY / 10_000n);
        expect(await croq.balanceOf(deployer.address)).to.equal(20_000_000n - pooled);
        expect(await npm.ownerOf!(positionId)).to.equal(await locker.getAddress());
        expect(await locker.positions()).to.deep.equal([positionId]);
        expect(await sqrtPrice()).to.equal(plan.sqrtPriceX96);
      });

      it("emits Locked from the deployer", async function () {
        const events = await locker.queryFilter(locker.filters.Locked());
        expect(events).to.have.length(1);
        expect(events[0]!.args.positionId).to.equal(positionId);
        expect(events[0]!.args.from).to.equal(deployer.address);
      });

      it("opens at the start price", async function () {
        // 1 USDC buys about 1000 CROQ, less the 1% fee, and the start is never below 0.001.
        const out = await quote(usdcAddress, usd("1"));
        expect(out).to.be.at.most(990n).and.at.least(960n);
      });

      it("buys nothing back before anyone has bought", async function () {
        await croq.transfer(bob.address, 1000n);
        await expect(swap(bob, croqAddress, 1000n)).to.be.reverted;
        expect(await croq.balanceOf(bob.address)).to.equal(1000n);
      });

      it("never sells back below the start price", async function () {
        await (await swap(alice, usdcAddress, usd("100"))).wait();
        const bought = await croq.balanceOf(alice.address);
        expect(bought).to.be.greaterThan(90_000n).and.below(100_000n);
        expect(atOrAboveStart(await sqrtPrice())).to.equal(true);
        // Everything back: the pool gives back less USDC than came in, and the price returns to the start.
        const usdcBefore = await usdc.balanceOf(alice.address);
        await (await swap(alice, croqAddress, bought)).wait();
        const back = (await usdc.balanceOf(alice.address)) - usdcBefore;
        expect(back).to.be.greaterThan(usd("97")).and.below(usd("100"));
        expect(atOrAboveStart(await sqrtPrice())).to.equal(true);
        // Alice's fees left about 1% of her CROQ unsold. Bob offers far more: the pool takes only what
        // it can still pay for at or above the start price, and hands the rest back.
        await croq.transfer(bob.address, 10_000n);
        await (await swap(bob, croqAddress, 10_000n)).wait();
        const sold = 10_000n - (await croq.balanceOf(bob.address));
        const paid = await usdc.balanceOf(bob.address);
        expect(sold).to.be.greaterThan(0n).and.below(2_000n);
        // At most the range's opening price, which the plan rounds up from 0.001 to a whole tick.
        const opening = croqPriceAtTick(croqFirst ? plan.tickLower : plan.tickUpper, croqFirst, 0, 6);
        expect(paid).to.be.greaterThan(0n).and.at.most(BigInt(Math.ceil(Number(sold) * opening * 1e6)));
        // Now nothing is left to pay with.
        await croq.transfer(bob.address, 10_000n);
        await expect(swap(bob, croqAddress, 10_000n)).to.be.reverted;
        // Bob's swap ran the pool's price into the empty ticks below the range, where nothing
        // trades: the next buyer crosses them for free and still pays the opening price.
        const out = await quote(usdcAddress, usd("1"));
        expect(Number(out)).to.be.at.most(1 / opening);
        await (await swap(alice, usdcAddress, usd("1"))).wait();
        expect(atOrAboveStart(await sqrtPrice())).to.equal(true);
      });

      it("sends trading fees to the beneficiary, leaving the liquidity", async function () {
        const before = await npm.positions!(positionId);
        await (await swap(alice, usdcAddress, usd("100"))).wait();
        await (await swap(alice, croqAddress, 50_000n)).wait();
        const [usdcBefore, croqBefore] = [await usdc.balanceOf(treasury.address), await croq.balanceOf(treasury.address)];
        // Anyone may trigger it; the fees still go to the beneficiary.
        const tx = await locker.connect(bob).collect(positionId);
        await expect(tx).to.emit(locker, "FeesCollected");
        const gotUsdc = (await usdc.balanceOf(treasury.address)) - usdcBefore;
        const gotCroq = (await croq.balanceOf(treasury.address)) - croqBefore;
        // 1% of 100 USDC, and 1% of 50,000 CROQ, less rounding.
        expect(gotUsdc).to.be.closeTo(usd("1"), 2n);
        expect(gotCroq).to.be.closeTo(500n, 2n);
        expect(await usdc.balanceOf(bob.address)).to.equal(0n);
        const after = await npm.positions!(positionId);
        expect(after.liquidity).to.equal(before.liquidity);
        // Nothing left to collect right after.
        await (await locker.collect(positionId)).wait();
        expect(await usdc.balanceOf(treasury.address)).to.equal(usdcBefore + gotUsdc);
      });

      it("follows the beneficiary when the owner changes it", async function () {
        await (await swap(alice, usdcAddress, usd("10"))).wait();
        await locker.setBeneficiary(bob.address);
        await (await locker.collect(positionId)).wait();
        expect(await usdc.balanceOf(bob.address)).to.be.closeTo(usd("0.1"), 2n);
        expect(await usdc.balanceOf(treasury.address)).to.equal(0n);
      });

      it("lets nobody take the liquidity out, the deployer included", async function () {
        const npmFull = new Contract(npmAddress, UNISWAP.positionManager.abi, deployer);
        const { liquidity } = await npm.positions!(positionId);
        await expect(
          npmFull.decreaseLiquidity!({ tokenId: positionId, liquidity, amount0Min: 0, amount1Min: 0, deadline: await deadline() }),
        ).to.be.revertedWith("Not approved");
        await expect(
          npmFull.collect!({ tokenId: positionId, recipient: deployer.address, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }),
        ).to.be.revertedWith("Not approved");
        await expect(npmFull.transferFrom!(await locker.getAddress(), deployer.address, positionId)).to.be.reverted;
        await expect(npmFull.burn!(positionId)).to.be.revertedWith("Not approved");
        expect(await npm.ownerOf!(positionId)).to.equal(await locker.getAddress());
      });

      it("sells the last CROQ at about the end of the range", async function () {
        await (await swap(alice, usdcAddress, usd("1000000"))).wait();
        const bought = await croq.balanceOf(alice.address);
        const pooled = await croq.balanceOf(await pool.getAddress());
        expect(bought).to.be.at.most(LIQUIDITY);
        // The fees on the way stay in the pool as USDC; the CROQ is all gone, give or take rounding.
        expect(pooled).to.be.at.most(2n);
        // Only what the range needed was spent: about sqrt(start x end) per CROQ on average.
        const spent = usd("1000000") - (await usdc.balanceOf(alice.address));
        const average = Number(spent) / 1e6 / Number(bought);
        expect(average).to.be.closeTo(Math.sqrt(0.001 * 0.001 * RANGE) * 1.01, 0.002);
        // Past the range, nothing more to buy.
        await expect(swap(alice, usdcAddress, usd("1"))).to.be.reverted;
      });

      it("refuses to seed a pool someone opened at another price", async function () {
        const other = await (await ethers.getContractFactory("Croq")).deploy(20_000_000n, deployer.address);
        const otherPlan = planSingleSided({
          croq: await other.getAddress(),
          quote: usdcAddress,
          croqDecimals: 0,
          quoteDecimals: 6,
          startPrice: START,
          rangeFactor: RANGE,
          fee: FEE,
          croqAmount: LIQUIDITY,
        });
        const npmFull = new Contract(npmAddress, UNISWAP.positionManager.abi, alice);
        await (await npmFull.createAndInitializePoolIfNecessary!(otherPlan.token0, otherPlan.token1, FEE, sqrtRatioAtTick(0))).wait();
        const refusal = await seedSingleSided(deployer, npmAddress, await locker.getAddress(), otherPlan).then(
          () => null,
          (e: Error) => e,
        );
        expect(refusal?.message).to.match(/already trades/);
        expect(await locker.positions()).to.deep.equal([positionId]);
      });
    });
  }
});
