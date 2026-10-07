import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { spec } from "@dno/game-spec";
import { whitelistParamsFromSpec } from "../lib/specParams";
import { ConfidentialCroq, Croq, DoNotOpen, Rats, TestConfidentialUSDC, TestUSDC, WhitelistGifts } from "../types";
import { balanceOf, confidentialUsdcOf, deploy, deployEconomy, expectDenied, FEES, ownerOf, usd } from "./helpers";

const DAY = 86_400;
const { tiers: TIERS } = whitelistParamsFromSpec();

describe("WhitelistGifts", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dave: HardhatEthersSigner;
  let dno: DoNotOpen;
  let usdc: TestUSDC;
  let cUsdc: TestConfidentialUSDC;
  let croq: Croq;
  let cCroq: ConfidentialCroq;
  let rats: Rats;
  let gifts: WhitelistGifts;
  let giftsAddress: string;
  let tree: StandardMerkleTree<[string, number]>;

  const proofOf = (who: HardhatEthersSigner) => {
    for (const [i, [address]] of tree.entries()) if (address === who.address) return tree.getProof(i);
    return [];
  };

  /** Claims `who`'s gift the way the app does: the box's quantity encrypted for DoNotOpen and the gifts. */
  async function claim(who: HardhatEthersSigner, tier: number, ratSeed: bigint, proof = proofOf(who)) {
    const input = await fhevm.createEncryptedInput(await dno.getAddress(), giftsAddress).add8(1).encrypt();
    return gifts.connect(who).claim(tier, proof, input.handles[0]!, input.inputProof, ratSeed);
  }

  const croqOf = async (who: HardhatEthersSigner) => {
    const g = await gifts.giftOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, g.croq, await cCroq.getAddress(), who);
  };

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = (await ethers.getSigners()) as HardhatEthersSigner[] as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    ({ dno, usdc, cUsdc } = await deploy({ maxSupply: 100 }));
    ({ croq, cCroq } = await deployEconomy(dno, {}, 0n));
    rats = (await (await ethers.getContractFactory("Rats")).deploy(
      await usdc.getAddress(), deployer.address, deployer.address, deployer.address, usd("1"), usd("3"), "", 10, 10, 5, 10,
    )) as unknown as Rats;
    gifts = (await (await ethers.getContractFactory("WhitelistGifts")).deploy(
      await dno.getAddress(), await rats.getAddress(), await cCroq.getAddress(), await cUsdc.getAddress(), TIERS, deployer.address,
    )) as unknown as WhitelistGifts;
    giftsAddress = await gifts.getAddress();
    await rats.setGiver(giftsAddress);
    // Funded as the deploy script does: croquettes wrapped to it, and one mint price per box.
    await croq.approve(await cCroq.getAddress(), 10_000);
    await cCroq.wrap(giftsAddress, 10_000);
    await usdc.mint(deployer.address, FEES.mint * 2n);
    await usdc.approve(await cUsdc.getAddress(), FEES.mint * 2n);
    await cUsdc.wrap(giftsAddress, FEES.mint * 2n);

    tree = StandardMerkleTree.of<[string, number]>([[alice.address, 0], [bob.address, 1], [carol.address, 2]], ["address", "uint8"]);
    await gifts.setRoot(tree.root, (await time.latest()) + 30 * DAY);
  });

  it("takes its tiers from spec.json, covering the whole list", async function () {
    expect(spec.whitelist.places).to.eq(1500);
    const onChain = await gifts.tiers();
    expect(onChain.map((t) => [Number(t.croqMin), Number(t.croqMax), t.box, t.rat])).to.deep.eq(spec.whitelist.tiers.map((t) => [t.croqMin, t.croqMax, t.box, t.rat]));
    const w = whitelistParamsFromSpec();
    expect([w.boxes, w.rats, w.maxCroq]).to.deep.eq([1000, 1000, 425_000n]);
  });

  it("gives first class an encrypted draw of croquettes, a box and a rat", async function () {
    const receipt = await (await claim(alice, 0, 4242n)).wait();
    const g = await gifts.giftOf(alice.address);
    expect([g.claimed, g.tier, g.hasBox, g.hasRat]).to.deep.eq([true, 0n, true, true]);
    await expect(receipt).to.emit(gifts, "GiftClaimed").withArgs(alice.address, 0, true, g.box, true, g.rat);

    const amount = await croqOf(alice);
    expect(amount).to.be.within(BigInt(TIERS[0]!.croqMin), BigInt(TIERS[0]!.croqMax));
    expect(await balanceOf(cCroq, alice)).to.eq(amount);
    expect(await ownerOf(dno, g.box)).to.eq(alice.address);
    expect(await rats.ownerOf(g.rat)).to.eq(alice.address);
    expect(await rats.tokenOfSeed(4242n)).to.eq(g.rat);
    // The box was paid for: its price is the collection's revenue, and nobody else can read the draw.
    expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(usd("1000"));
    await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, g.croq, await cCroq.getAddress(), bob));
  });

  it("gives business a box and no rat, economy a rat and no box, each in its range", async function () {
    await claim(bob, 1, 1n);
    await claim(carol, 2, 2n);
    const b = await gifts.giftOf(bob.address);
    const c = await gifts.giftOf(carol.address);
    expect([b.hasBox, b.hasRat, c.hasBox, c.hasRat]).to.deep.eq([true, false, false, true]);
    expect(await ownerOf(dno, b.box)).to.eq(bob.address);
    expect(await rats.ownerOf(c.rat)).to.eq(carol.address);
    expect(await rats.tokenOfSeed(1n)).to.eq(0);
    expect(await croqOf(bob)).to.be.within(BigInt(TIERS[1]!.croqMin), BigInt(TIERS[1]!.croqMax));
    expect(await croqOf(carol)).to.be.within(BigInt(TIERS[2]!.croqMin), BigInt(TIERS[2]!.croqMax));
    expect(await gifts.claimedCount()).to.eq(2);
  });

  it("refuses a second claim, another tier, a wallet off the list, and claims outside the window", async function () {
    await expect(claim(alice, 1, 5n, proofOf(alice))).to.be.revertedWithCustomError(gifts, "NotOnTheList");
    await expect(claim(dave, 0, 5n, proofOf(alice))).to.be.revertedWithCustomError(gifts, "NotOnTheList");
    await expect(claim(alice, 7, 5n)).to.be.revertedWithCustomError(gifts, "BadTier");
    await claim(alice, 0, 5n);
    await expect(claim(alice, 0, 6n)).to.be.revertedWithCustomError(gifts, "AlreadyClaimed");
    // The list cannot change once someone has claimed.
    await expect(gifts.setRoot(tree.root, (await time.latest()) + DAY)).to.be.revertedWithCustomError(gifts, "RootAlreadySet");
    await time.increase(30 * DAY);
    await expect(claim(bob, 1, 7n)).to.be.revertedWithCustomError(gifts, "NotOpen");
  });

  it("waits for the root, and lets the owner correct it until the first claim", async function () {
    const fresh = (await (await ethers.getContractFactory("WhitelistGifts")).deploy(
      await dno.getAddress(), await rats.getAddress(), await cCroq.getAddress(), await cUsdc.getAddress(), TIERS, deployer.address,
    )) as unknown as WhitelistGifts;
    const input = await fhevm.createEncryptedInput(await dno.getAddress(), await fresh.getAddress()).add8(1).encrypt();
    await expect(fresh.connect(alice).claim(0, proofOf(alice), input.handles[0]!, input.inputProof, 1n)).to.be.revertedWithCustomError(fresh, "NotOpen");
    await expect(fresh.connect(alice).setRoot(tree.root, (await time.latest()) + DAY)).to.be.revertedWithCustomError(fresh, "OwnableUnauthorizedAccount");
    await fresh.setRoot(ethers.id("wrong"), (await time.latest()) + DAY);
    await expect(fresh.setRoot(tree.root, (await time.latest()) + DAY)).to.emit(fresh, "RootSet");
    expect(await fresh.root()).to.eq(tree.root);
  });

  it("refuses tiers whose range does not fit the draw", async function () {
    const Gifts = await ethers.getContractFactory("WhitelistGifts");
    const args = [await dno.getAddress(), await rats.getAddress(), await cCroq.getAddress(), await cUsdc.getAddress()] as const;
    await expect(Gifts.deploy(...args, [{ croqMin: 10, croqMax: 5, box: false, rat: false }], deployer.address)).to.be.revertedWithCustomError(gifts, "BadTier");
    await expect(Gifts.deploy(...args, [{ croqMin: 0, croqMax: 70_000, box: false, rat: false }], deployer.address)).to.be.revertedWithCustomError(gifts, "BadTier");
    await expect(Gifts.deploy(...args, [], deployer.address)).to.be.revertedWithCustomError(gifts, "BadTier");
  });

  it("gives back what is left to the owner once claims are over", async function () {
    await claim(alice, 0, 9n);
    const drawn = await croqOf(alice);
    await expect(gifts.sweep(dave.address)).to.be.revertedWithCustomError(gifts, "StillOpen");
    await time.increase(30 * DAY);
    await expect(gifts.connect(alice).sweep(alice.address)).to.be.revertedWithCustomError(gifts, "OwnableUnauthorizedAccount");
    await gifts.sweep(dave.address);
    expect(await balanceOf(cCroq, dave)).to.eq(10_000n - drawn);
    expect(await confidentialUsdcOf(cUsdc, dave)).to.eq(usd("1000") + FEES.mint);
  });

  it("stays under the HCU limit for the biggest gift", async function () {
    const receipt = await (await claim(alice, 0, 11n)).wait();
    const { globalHCU } = fhevm.computeTransactionHCU(receipt as Parameters<typeof fhevm.computeTransactionHCU>[0]);
    console.log(`      claim, first class: ${globalHCU} HCU`);
    expect(globalHCU).to.be.below(20_000_000);
  });
});
