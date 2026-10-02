import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { DecryptionCredits, TestUSDC } from "../types";
import { usd } from "./helpers";

describe("DecryptionCredits", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let usdc: TestUSDC;
  let credits: DecryptionCredits;
  const PRICE = usd("0.01");

  beforeEach(async function () {
    [deployer, alice, bob, treasury] = (await ethers.getSigners()) as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    credits = (await (await ethers.getContractFactory("DecryptionCredits")).deploy(
      await usdc.getAddress(),
      PRICE,
      treasury.address,
      deployer.address,
    )) as unknown as DecryptionCredits;
    await usdc.mint(alice.address, usd("10"));
  });

  it("sells credits for plain USDC, paid straight to the treasury", async function () {
    await usdc.connect(alice).approve(await credits.getAddress(), usd("1"));
    await expect(credits.connect(alice).buy(alice.address, 100, PRICE))
      .to.emit(credits, "CreditsBought")
      .withArgs(alice.address, alice.address, 100, usd("1"));
    expect(await credits.bought(alice.address)).to.eq(100);
    expect(await usdc.balanceOf(treasury.address)).to.eq(usd("1"));
    expect(await usdc.balanceOf(await credits.getAddress())).to.eq(0);
  });

  it("buys for another account", async function () {
    await usdc.connect(alice).approve(await credits.getAddress(), usd("0.5"));
    await credits.connect(alice).buy(bob.address, 50, PRICE);
    expect(await credits.bought(bob.address)).to.eq(50);
    expect(await credits.bought(alice.address)).to.eq(0);
  });

  it("reverts, never half-pays, when the USDC falls short", async function () {
    await usdc.connect(alice).approve(await credits.getAddress(), usd("100"));
    await expect(credits.connect(alice).buy(alice.address, 2_000, PRICE)).to.be.revertedWithCustomError(usdc, "ERC20InsufficientBalance");
    expect(await credits.bought(alice.address)).to.eq(0);
    await usdc.connect(alice).approve(await credits.getAddress(), 0);
    await expect(credits.connect(alice).buy(alice.address, 1, PRICE)).to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");
  });

  it("refuses zero credits, a zero account, and a price raised after the buyer looked", async function () {
    await usdc.connect(alice).approve(await credits.getAddress(), usd("10"));
    await expect(credits.connect(alice).buy(alice.address, 0, PRICE)).to.be.revertedWithCustomError(credits, "NoCredits");
    await expect(credits.connect(alice).buy(ethers.ZeroAddress, 1, PRICE)).to.be.revertedWithCustomError(credits, "ZeroAddress");
    await credits.setPrice(usd("0.02"));
    await expect(credits.connect(alice).buy(alice.address, 1, PRICE)).to.be.revertedWithCustomError(credits, "PriceChanged");
    await credits.connect(alice).buy(alice.address, 1, usd("0.02"));
    expect(await usdc.balanceOf(treasury.address)).to.eq(usd("0.02"));
  });

  it("lets only the owner set the price, up to 1 USDC, and the treasury", async function () {
    await expect(credits.connect(alice).setPrice(1)).to.be.revertedWithCustomError(credits, "OwnableUnauthorizedAccount");
    await expect(credits.connect(alice).setTreasury(alice.address)).to.be.revertedWithCustomError(credits, "OwnableUnauthorizedAccount");
    await expect(credits.setPrice(usd("1") + 1n)).to.be.revertedWithCustomError(credits, "PriceTooHigh");
    await expect(credits.setPrice(usd("1"))).to.emit(credits, "PriceSet").withArgs(usd("1"));
    await expect(credits.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(credits, "ZeroAddress");
    await expect(credits.setTreasury(bob.address)).to.emit(credits, "TreasurySet").withArgs(bob.address);
  });
});
