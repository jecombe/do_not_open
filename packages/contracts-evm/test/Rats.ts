import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { studio } from "@dno/game-spec";
import { Croq, RatPantry, Rats, TestUSDC } from "../types";
import { ratParamsFromSpec } from "../lib/ratParams";
import { usd } from "./helpers";

const DAY = 86_400;

describe("Rats and RatPantry", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let attester: HardhatEthersSigner;
  let usdc: TestUSDC;
  let croq: Croq;
  let rats: Rats;
  let pantry: RatPantry;

  async function adoptSig(minter: string, job: string, uri: string, deadline: number, signer = attester) {
    const { chainId } = await ethers.provider.getNetwork();
    return signer.signTypedData(
      { name: "DO NOT OPEN Rats", version: "1", chainId, verifyingContract: await rats.getAddress() },
      { Adopt: [{ name: "minter", type: "address" }, { name: "job", type: "bytes32" }, { name: "uri", type: "string" }, { name: "deadline", type: "uint256" }] },
      { minter, job, uri, deadline },
    );
  }

  beforeEach(async function () {
    [deployer, alice, bob, treasury, attester] = (await ethers.getSigners()) as HardhatEthersSigner[] as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    croq = (await (await ethers.getContractFactory("Croq")).deploy(20_000_000, deployer.address)) as unknown as Croq;
    rats = (await (await ethers.getContractFactory("Rats")).deploy(
      await usdc.getAddress(), treasury.address, deployer.address, attester.address, usd("1"), usd("3"), "https://api.test/rats/", 700, 300, 50, 2,
    )) as unknown as Rats;
    pantry = (await (await ethers.getContractFactory("RatPantry")).deploy(await croq.getAddress(), await rats.getAddress(), 10, 7)) as unknown as RatPantry;
    await croq.transfer(await pantry.getAddress(), 1_000);
    await usdc.mint(alice.address, usd("20"));
    await usdc.connect(alice).approve(await rats.getAddress(), usd("20"));
  });

  it("adopts a free rat by its seed, once, paid to the treasury", async function () {
    await expect(rats.connect(alice).mintSeed(42, usd("1")))
      .to.emit(rats, "RatMinted")
      .withArgs(1, alice.address, 0, ethers.zeroPadValue("0x2a", 32), "", usd("1"));
    expect(await rats.ownerOf(1)).to.eq(alice.address);
    expect(await rats.tokenOfSeed(42)).to.eq(1);
    expect(await rats.tokenURI(1)).to.eq("https://api.test/rats/1");
    expect(await usdc.balanceOf(treasury.address)).to.eq(usd("1"));
    expect(await usdc.balanceOf(await rats.getAddress())).to.eq(0);
    await expect(rats.connect(alice).mintSeed(42, usd("1"))).to.be.revertedWithCustomError(rats, "AlreadyAdopted");
    // The largest seed fits.
    await rats.connect(alice).mintSeed(2n ** 64n - 1n, usd("1"));
    expect(await rats.totalSupply()).to.eq(2);
  });

  it("adopts an AI rat only on the attester's signature, for the caller, once", async function () {
    const job = ethers.id("job-1");
    const uri = "ar://abc";
    const deadline = (await time.latest()) + 600;
    const sig = await adoptSig(alice.address, job, uri, deadline);
    // Someone else cannot use Alice's signature, nor change the files.
    await usdc.mint(bob.address, usd("5"));
    await usdc.connect(bob).approve(await rats.getAddress(), usd("5"));
    await expect(rats.connect(bob).mintModel(job, uri, deadline, sig, usd("3"))).to.be.revertedWithCustomError(rats, "BadSignature");
    await expect(rats.connect(alice).mintModel(job, "ar://other", deadline, sig, usd("3"))).to.be.revertedWithCustomError(rats, "BadSignature");
    const forged = await adoptSig(alice.address, job, uri, deadline, bob);
    await expect(rats.connect(alice).mintModel(job, uri, deadline, forged, usd("3"))).to.be.revertedWithCustomError(rats, "BadSignature");

    await expect(rats.connect(alice).mintModel(job, uri, deadline, sig, usd("3"))).to.emit(rats, "RatMinted").withArgs(1, alice.address, 1, job, uri, usd("3"));
    expect((await rats.ratOf(1)).kind).to.eq(1);
    await expect(rats.connect(alice).mintModel(job, uri, deadline, sig, usd("3"))).to.be.revertedWithCustomError(rats, "AlreadyAdopted");

    const late = (await time.latest()) - 1;
    await expect(rats.connect(alice).mintModel(ethers.id("job-2"), uri, late, await adoptSig(alice.address, ethers.id("job-2"), uri, late), usd("3"))).to.be.revertedWithCustomError(rats, "Expired");
  });

  it("refuses a price raised after the buyer looked, and short USDC", async function () {
    await rats.setPrices(usd("2"), usd("3"));
    await expect(rats.connect(alice).mintSeed(1, usd("1"))).to.be.revertedWithCustomError(rats, "PriceChanged");
    await expect(rats.connect(bob).mintSeed(1, usd("2"))).to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");
    expect(await rats.tokenOfSeed(1)).to.eq(0);
  });

  it("lets only the owner set prices, treasury, attester and base URI, within bounds", async function () {
    await expect(rats.connect(alice).setPrices(usd("1"), usd("1"))).to.be.revertedWithCustomError(rats, "OwnableUnauthorizedAccount");
    await expect(rats.setPrices(0, usd("1"))).to.be.revertedWithCustomError(rats, "ZeroPrice");
    await expect(rats.setPrices(usd("101"), usd("1"))).to.be.revertedWithCustomError(rats, "PriceTooHigh");
    await expect(rats.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(rats, "ZeroAddress");
    await expect(rats.setAttester(ethers.ZeroAddress)).to.be.revertedWithCustomError(rats, "ZeroAddress");
    await rats.setBaseURI("ipfs://x/");
    await rats.connect(alice).mintSeed(5, usd("1"));
    expect(await rats.tokenURI(1)).to.eq("ipfs://x/1");
  });

  it("pays each rat its CROQ a day to whoever owns it, at most maxDays at once", async function () {
    await rats.connect(alice).mintSeed(7, usd("1"));
    expect(await pantry.claimable(1)).to.eq(0);
    await time.increase(DAY * 2 + 100);
    expect(await pantry.claimable(1)).to.eq(20);
    await expect(pantry.connect(alice).claim([1])).to.emit(pantry, "RatsFed").withArgs(alice.address, [1], 20);
    expect(await croq.balanceOf(alice.address)).to.eq(20);
    // Nothing twice; the part of a day already waited is kept.
    expect(await pantry.claimable(1)).to.eq(0);
    await time.increase(DAY - 50);
    expect(await pantry.claimable(1)).to.eq(10);
    // Past the cap, only maxDays are paid.
    await time.increase(DAY * 30);
    expect(await pantry.claimable(1)).to.eq(70);
    // A rat sold earns for its new owner; the old one cannot claim it.
    await rats.connect(alice).transferFrom(alice.address, bob.address, 1);
    await expect(pantry.connect(alice).claim([1])).to.be.revertedWithCustomError(pantry, "NotYourRat");
    await pantry.connect(bob).claim([1]);
    expect(await croq.balanceOf(bob.address)).to.eq(70);
  });

  it("pays what is left when the pantry runs dry, and refuses an empty claim", async function () {
    for (let s = 1; s <= 20; s++) await rats.connect(alice).mintSeed(s, usd("1"));
    await time.increase(DAY * 7);
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    // 20 rats x 70 = 1,400 owed, 1,000 in the pantry.
    await pantry.connect(alice).claim(ids);
    expect(await croq.balanceOf(alice.address)).to.eq(1_000);
    expect(await pantry.reserve()).to.eq(0);
    await expect(pantry.connect(alice).claim([])).to.be.revertedWithCustomError(pantry, "NoRats");
  });

  it("refuses a claim while it is empty, so the days earned wait for the CROQ", async function () {
    const empty = (await (await ethers.getContractFactory("RatPantry")).deploy(await croq.getAddress(), await rats.getAddress(), 10, 7)) as unknown as RatPantry;
    await rats.connect(alice).mintSeed(9, usd("1"));
    await time.increase(DAY * 3);
    await expect(empty.connect(alice).claim([1])).to.be.revertedWithCustomError(empty, "PantryEmpty");
    // The treasury sends CROQ with a plain transfer: the three days are still there.
    await croq.transfer(await empty.getAddress(), 500);
    await empty.connect(alice).claim([1]);
    expect(await croq.balanceOf(alice.address)).to.eq(30);
  });

  it("caps each kind for good, and each wallet's mints, but not what a wallet holds", async function () {
    const Rats = await ethers.getContractFactory("Rats");
    const args = [await usdc.getAddress(), treasury.address, deployer.address, attester.address, usd("1"), usd("3"), "https://api.test/rats/"] as const;
    await expect(Rats.deploy(...args, 0, 1, 1, 1)).to.be.revertedWithCustomError(rats, "ZeroCap");
    await expect(Rats.deploy(...args, 1, 1, 0, 1)).to.be.revertedWithCustomError(rats, "ZeroCap");
    const small = (await Rats.deploy(...args, 2, 1, 2, 1)) as unknown as Rats;
    const at = await small.getAddress();
    await usdc.connect(alice).approve(at, usd("20"));
    await usdc.mint(bob.address, usd("20"));
    await usdc.connect(bob).approve(at, usd("20"));

    await small.connect(alice).mintSeed(1, usd("1"));
    await small.connect(alice).mintSeed(2, usd("1"));
    expect(await small.mintedBy(alice.address)).to.eq(2);
    // Two seed rats out of two: none left, whoever asks.
    await expect(small.connect(bob).mintSeed(3, usd("1"))).to.be.revertedWithCustomError(small, "SoldOut");
    expect(await small.seedMinted()).to.eq(2);

    // Alice minted her two: the AI rat left is refused to her, not to Bob.
    const job = ethers.id("job-cap");
    const deadline = (await time.latest()) + 600;
    const sign = async (who: string) =>
      attester.signTypedData(
        { name: "DO NOT OPEN Rats", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: at },
        { Adopt: [{ name: "minter", type: "address" }, { name: "job", type: "bytes32" }, { name: "uri", type: "string" }, { name: "deadline", type: "uint256" }] },
        { minter: who, job, uri: "ar://x", deadline },
      );
    await expect(small.connect(alice).mintModel(job, "ar://x", deadline, await sign(alice.address), usd("3"))).to.be.revertedWithCustomError(small, "WalletLimit");
    await small.connect(bob).mintModel(job, "ar://x", deadline, await sign(bob.address), usd("3"));
    const job2 = ethers.id("job-cap-2");
    const sig2 = await attester.signTypedData(
      { name: "DO NOT OPEN Rats", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: at },
      { Adopt: [{ name: "minter", type: "address" }, { name: "job", type: "bytes32" }, { name: "uri", type: "string" }, { name: "deadline", type: "uint256" }] },
      { minter: bob.address, job: job2, uri: "ar://x", deadline },
    );
    await expect(small.connect(bob).mintModel(job2, "ar://x", deadline, sig2, usd("3"))).to.be.revertedWithCustomError(small, "SoldOut");

    // Holding more is fine: Bob can be given Alice's rats.
    await small.connect(alice).transferFrom(alice.address, bob.address, 1);
    await small.connect(alice).transferFrom(alice.address, bob.address, 2);
    expect(await small.balanceOf(bob.address)).to.eq(3);
  });

  it("takes its numbers from studio.json", function () {
    const p = ratParamsFromSpec();
    expect(p.seedPrice).to.eq(usd(studio.rats.mint.seedPriceUsdc));
    expect(p.modelPrice).to.eq(usd(studio.rats.mint.modelPriceUsdc));
    expect(p.perDay).to.eq(studio.rats.croquettes.perDay);
    expect([p.maxSeedRats, p.maxModelRats, p.maxPerWallet]).to.deep.eq([studio.rats.mint.maxSeedRats, studio.rats.mint.maxModelRats, studio.rats.mint.maxPerWallet]);
    expect(p.maxGiftRats).to.eq(studio.rats.mint.maxGiftRats);
    expect(() => ratParamsFromSpec({ ...studio, rats: { ...studio.rats, mint: { ...studio.rats.mint, seedPriceUsdc: "0" } } })).to.throw(/positive/);
  });

  it("lets only the giver adopt free rats, outside the paid caps and the wallet limit, up to maxGiftRats", async function () {
    await expect(rats.connect(alice).gift(alice.address, 7)).to.be.revertedWithCustomError(rats, "NotGiver");
    await expect(rats.connect(alice).setGiver(alice.address)).to.be.revertedWithCustomError(rats, "OwnableUnauthorizedAccount");
    await expect(rats.setGiver(bob.address)).to.emit(rats, "GiverSet").withArgs(bob.address);
    await expect(rats.connect(bob).gift(alice.address, 7))
      .to.emit(rats, "RatMinted")
      .withArgs(1, alice.address, 0, ethers.zeroPadValue("0x07", 32), "", 0);
    expect(await rats.ownerOf(1)).to.eq(alice.address);
    expect([await rats.seedMinted(), await rats.giftMinted(), await rats.mintedBy(alice.address)]).to.deep.eq([0n, 1n, 0n]);
    expect(await usdc.balanceOf(treasury.address)).to.eq(0);
    // A seed is adopted once, whichever way.
    await expect(rats.connect(alice).mintSeed(7, usd("1"))).to.be.revertedWithCustomError(rats, "AlreadyAdopted");
    await expect(rats.connect(bob).gift(alice.address, 7)).to.be.revertedWithCustomError(rats, "AlreadyAdopted");
    await rats.connect(bob).gift(alice.address, 8);
    await expect(rats.connect(bob).gift(alice.address, 9)).to.be.revertedWithCustomError(rats, "SoldOut");
    // The rats earn croquettes like any other.
    await time.increase(2 * DAY);
    await expect(pantry.connect(alice).claim([1])).to.emit(pantry, "RatsFed");
  });
});
