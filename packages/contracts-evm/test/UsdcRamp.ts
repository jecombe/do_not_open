import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { TestConfidentialUSDC, TestSwapRouter, TestUSDC, UsdcRamp } from "../types";
import { confidentialUsdcOf, usd } from "./helpers";

describe("UsdcRamp", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let usdc: TestUSDC;
  let cUsdc: TestConfidentialUSDC;
  let router: TestSwapRouter;
  let ramp: UsdcRamp;
  const ONE_ETH = ethers.parseEther("1");
  const FEE_BPS = 30n;
  const deadline = () => Math.floor(Date.now() / 1000) + 3600;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    [deployer, alice] = (await ethers.getSigners()) as [HardhatEthersSigner, HardhatEthersSigner];
    usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    cUsdc = (await (await ethers.getContractFactory("TestConfidentialUSDC")).deploy(await usdc.getAddress())) as unknown as TestConfidentialUSDC;
    router = (await (await ethers.getContractFactory("TestSwapRouter")).deploy(await usdc.getAddress(), usd("2500"))) as unknown as TestSwapRouter;
    ramp = (await (await ethers.getContractFactory("UsdcRamp")).deploy(
      await router.getAddress(),
      await usdc.getAddress(),
      await cUsdc.getAddress(),
      FEE_BPS,
      deployer.address,
    )) as unknown as UsdcRamp;
  });

  it("buys USDC with ETH, minus a 0.3% fee kept in ETH", async function () {
    const fee = (ONE_ETH * FEE_BPS) / 10_000n;
    const [quoted, quotedFee] = await ramp.quote(ONE_ETH);
    expect(quotedFee).to.eq(fee);
    expect(quoted).to.eq(((ONE_ETH - fee) * usd("2500")) / ONE_ETH);
    await expect(ramp.connect(alice).buy(quoted, false, deadline(), { value: ONE_ETH }))
      .to.emit(ramp, "Bought")
      .withArgs(alice.address, ONE_ETH, fee, quoted, false);
    expect(await usdc.balanceOf(alice.address)).to.eq(quoted);
    expect(await ramp.fees()).to.eq(fee);
  });

  it("hands the USDC over already shielded as cUSDC", async function () {
    const [quoted] = await ramp.quote(ONE_ETH);
    await ramp.connect(alice).buy(quoted, true, deadline(), { value: ONE_ETH });
    expect(await usdc.balanceOf(alice.address)).to.eq(0);
    expect(await usdc.balanceOf(await ramp.getAddress())).to.eq(0);
    expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(quoted);
  });

  it("refuses a worse price than asked, a fee above 1%, and fee withdrawals by anyone but the owner", async function () {
    const [quoted] = await ramp.quote(ONE_ETH);
    await expect(ramp.connect(alice).buy(quoted + 1n, false, deadline(), { value: ONE_ETH })).to.be.revertedWithCustomError(router, "Slippage");
    const factory = await ethers.getContractFactory("UsdcRamp");
    await expect(factory.deploy(await router.getAddress(), await usdc.getAddress(), await cUsdc.getAddress(), 101, deployer.address)).to.be.revertedWithCustomError(
      factory,
      "FeeTooHigh",
    );
    await ramp.connect(alice).buy(0, false, deadline(), { value: ONE_ETH });
    await expect(ramp.connect(alice).withdrawFees(alice.address)).to.be.revertedWithCustomError(ramp, "OwnableUnauthorizedAccount");
    await expect(ramp.withdrawFees(deployer.address)).to.changeEtherBalance(deployer, (ONE_ETH * FEE_BPS) / 10_000n);
    await expect(ramp.withdrawFees(deployer.address)).to.be.revertedWithCustomError(ramp, "NothingToWithdraw");
  });
});
