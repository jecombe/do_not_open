import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { packCostUsd, studio } from "@dno/game-spec";
import { StudioPacks, TestUSDC } from "../types";
import { studioPacksFromSpec } from "../lib/studioPacks";
import { usd } from "./helpers";

describe("StudioPacks", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let usdc: TestUSDC;
  let packs: StudioPacks;
  const STARTER = { price: usd("2"), sketches: 10, models: 1 };
  const LITTER = { price: usd("8"), sketches: 50, models: 5 };

  beforeEach(async function () {
    [deployer, alice, bob, treasury] = (await ethers.getSigners()) as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    packs = (await (await ethers.getContractFactory("StudioPacks")).deploy(await usdc.getAddress(), treasury.address, deployer.address, [
      STARTER,
      LITTER,
    ])) as unknown as StudioPacks;
    await usdc.mint(alice.address, usd("20"));
  });

  it("sells a pack for plain USDC, paid straight to the treasury", async function () {
    await usdc.connect(alice).approve(await packs.getAddress(), usd("2"));
    await expect(packs.connect(alice).buy(alice.address, 0, usd("2")))
      .to.emit(packs, "PackBought")
      .withArgs(alice.address, alice.address, 0, 10, 1, usd("2"));
    expect(await packs.sketchesBought(alice.address)).to.eq(10);
    expect(await packs.modelsBought(alice.address)).to.eq(1);
    expect(await usdc.balanceOf(treasury.address)).to.eq(usd("2"));
    expect(await usdc.balanceOf(await packs.getAddress())).to.eq(0);
  });

  it("adds packs up, and buys for another account", async function () {
    await usdc.connect(alice).approve(await packs.getAddress(), usd("12"));
    await packs.connect(alice).buy(bob.address, 1, usd("8"));
    await packs.connect(alice).buy(bob.address, 0, usd("2"));
    expect(await packs.sketchesBought(bob.address)).to.eq(60);
    expect(await packs.modelsBought(bob.address)).to.eq(6);
    expect(await packs.sketchesBought(alice.address)).to.eq(0);
  });

  it("reverts, never half-pays, when the USDC falls short", async function () {
    await expect(packs.connect(alice).buy(alice.address, 0, usd("2"))).to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");
    await usdc.connect(bob).approve(await packs.getAddress(), usd("2"));
    await expect(packs.connect(bob).buy(bob.address, 0, usd("2"))).to.be.revertedWithCustomError(usdc, "ERC20InsufficientBalance");
    expect(await packs.sketchesBought(bob.address)).to.eq(0);
  });

  it("refuses an unknown pack, a zero account, and a price raised after the buyer looked", async function () {
    await usdc.connect(alice).approve(await packs.getAddress(), usd("20"));
    await expect(packs.connect(alice).buy(alice.address, 7, usd("100"))).to.be.revertedWithCustomError(packs, "NotForSale");
    await expect(packs.connect(alice).buy(ethers.ZeroAddress, 0, usd("2"))).to.be.revertedWithCustomError(packs, "ZeroAddress");
    await packs.setPack(0, { ...STARTER, price: usd("3") });
    await expect(packs.connect(alice).buy(alice.address, 0, usd("2"))).to.be.revertedWithCustomError(packs, "PriceChanged");
    await packs.connect(alice).buy(alice.address, 0, usd("3"));
  });

  it("lets only the owner set, change and withdraw packs, within bounds", async function () {
    await expect(packs.connect(alice).setPack(0, STARTER)).to.be.revertedWithCustomError(packs, "OwnableUnauthorizedAccount");
    await expect(packs.setPack(0, { ...STARTER, price: usd("101") })).to.be.revertedWithCustomError(packs, "PriceTooHigh");
    await expect(packs.setPack(2, { price: usd("1"), sketches: 0, models: 0 })).to.be.revertedWithCustomError(packs, "EmptyPack");
    await expect(packs.setPack(2, { price: usd("1"), sketches: 5, models: 0 })).to.emit(packs, "PackSet").withArgs(2, usd("1"), 5, 0);
    await packs.setPack(0, { price: 0, sketches: 0, models: 0 });
    await usdc.connect(alice).approve(await packs.getAddress(), usd("2"));
    await expect(packs.connect(alice).buy(alice.address, 0, usd("2"))).to.be.revertedWithCustomError(packs, "NotForSale");
  });

  it("lets only the owner move the treasury, never to zero", async function () {
    await expect(packs.connect(alice).setTreasury(alice.address)).to.be.revertedWithCustomError(packs, "OwnableUnauthorizedAccount");
    await expect(packs.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(packs, "ZeroAddress");
    await packs.setTreasury(bob.address);
    await usdc.connect(alice).approve(await packs.getAddress(), usd("2"));
    await packs.connect(alice).buy(alice.address, 0, usd("2"));
    expect(await usdc.balanceOf(bob.address)).to.eq(usd("2"));
  });

  it("deploys the packs of studio.json, each sold at least minMargin times its cost", function () {
    const params = studioPacksFromSpec();
    expect(params.length).to.eq(studio.packs.length);
    for (const pack of studio.packs) {
      expect(Number(pack.priceUsdc)).to.be.gte(studio.minMargin * packCostUsd(pack));
      expect(params[pack.id]!.price).to.eq(usd(pack.priceUsdc));
    }
    const cheap = { ...studio, packs: [{ ...studio.packs[0]!, priceUsdc: "0.1" }] };
    expect(() => studioPacksFromSpec(cheap)).to.throw(/under/);
  });
});
