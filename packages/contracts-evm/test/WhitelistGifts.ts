import { ratParamsFromSpec } from "../lib/ratParams";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { spec } from "@dno/game-spec";
import { whitelistParamsFromSpec } from "../lib/specParams";
import { ConfidentialCroq, Croq, DoNotOpen, Rats, TestConfidentialUSDC, TestUSDC, WhitelistGifts } from "../types";
import { announce, balanceOf, confidentialUsdcOf, deploy, deployEconomy, expectDenied, mintBoxes, ownerOf, usd } from "./helpers";

const RAT_POWERS = ratParamsFromSpec().powerBelow;

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

  const claim = (who: HardhatEthersSigner, tier: number, ratSeed: bigint, proof = proofOf(who)) => gifts.connect(who).claim(tier, proof, ratSeed);

  const croqOf = async (who: HardhatEthersSigner) => {
    const g = await gifts.giftOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, g.croq, await cCroq.getAddress(), who);
  };

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = (await ethers.getSigners()) as HardhatEthersSigner[] as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    // The sale stops at 98: two boxes are kept for the gifts.
    ({ dno, usdc, cUsdc } = await deploy({ maxSupply: 100 }, [50, 98]));
    ({ croq, cCroq } = await deployEconomy(dno, {}, 0n));
    rats = (await (await ethers.getContractFactory("Rats")).deploy(
      await usdc.getAddress(), deployer.address, deployer.address, deployer.address, usd("1"), usd("3"), "", [10, 10, 5, 10], RAT_POWERS,
    )) as unknown as Rats;
    gifts = (await (await ethers.getContractFactory("WhitelistGifts")).deploy(
      await dno.getAddress(), await rats.getAddress(), await cCroq.getAddress(), TIERS, deployer.address,
    )) as unknown as WhitelistGifts;
    giftsAddress = await gifts.getAddress();
    await dno.setGiver(giftsAddress);
    await rats.setGiver(giftsAddress);
    // Funded as the deploy script does: croquettes wrapped to it. The boxes and rats cost nothing.
    await croq.approve(await cCroq.getAddress(), 10_000);
    await cCroq.wrap(giftsAddress, 10_000);

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
    // Free, outside the sale, and nobody else can read the draw.
    expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(usd("1000"));
    await expect(receipt).to.emit(dno, "BoxGifted").withArgs(g.box, alice.address);
    expect(await dno.giftsMinted()).to.eq(1);
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
      await dno.getAddress(), await rats.getAddress(), await cCroq.getAddress(), TIERS, deployer.address,
    )) as unknown as WhitelistGifts;
    await expect(fresh.connect(alice).claim(0, proofOf(alice), 1n)).to.be.revertedWithCustomError(fresh, "NotOpen");
    await expect(fresh.connect(alice).setRoot(tree.root, (await time.latest()) + DAY)).to.be.revertedWithCustomError(fresh, "OwnableUnauthorizedAccount");
    await fresh.setRoot(ethers.id("wrong"), (await time.latest()) + DAY);
    await expect(fresh.setRoot(tree.root, (await time.latest()) + DAY)).to.emit(fresh, "RootSet");
    expect(await fresh.root()).to.eq(tree.root);
  });

  it("refuses tiers whose range does not fit the draw", async function () {
    const Gifts = await ethers.getContractFactory("WhitelistGifts");
    const args = [await dno.getAddress(), await rats.getAddress(), await cCroq.getAddress()] as const;
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
  });

  it("mints the boxes out of the ones the sale leaves, even once the sale is sold out", async function () {
    // The sale stops at its cap and announces it as sold out; the gifts don't count.
    await mintBoxes(dno, carol, 10);
    for (let sold = 10; sold < 98; sold += 10) await mintBoxes(dno, dave, Math.min(10, 98 - sold));
    expect(await announce(dno, carol)).to.eq(true);
    expect(await announce(dno, carol)).to.eq(false);
    await mintBoxes(dno, carol, 1);
    expect(await announce(dno, carol)).to.eq(true);
    expect(await dno.milestonesReached()).to.eq(2);
    expect((await mintBoxes(dno, bob, 1)).owned).to.deep.eq([]);

    await claim(alice, 0, 21n);
    await claim(bob, 1, 22n);
    expect(await ownerOf(dno, (await gifts.giftOf(alice.address)).box)).to.eq(alice.address);
    expect(await ownerOf(dno, (await gifts.giftOf(bob.address)).box)).to.eq(bob.address);
    expect(await dno.giftsMinted()).to.eq(2);
  });

  it("never mints more boxes than the sale leaves, and only for its giver", async function () {
    const more = StandardMerkleTree.of<[string, number]>([[alice.address, 0], [bob.address, 1], [dave.address, 0]], ["address", "uint8"]);
    const fresh = (await (await ethers.getContractFactory("WhitelistGifts")).deploy(
      await dno.getAddress(), await rats.getAddress(), await cCroq.getAddress(), TIERS, deployer.address,
    )) as unknown as WhitelistGifts;
    await expect(dno.connect(alice).setGiver(alice.address)).to.be.revertedWithCustomError(dno, "OwnableUnauthorizedAccount");
    await expect(dno.connect(alice).gift(alice.address)).to.be.revertedWithCustomError(dno, "NotGiver");
    await dno.setGiver(await fresh.getAddress());
    await rats.setGiver(await fresh.getAddress());
    await fresh.setRoot(more.root, (await time.latest()) + DAY);
    const proof = (who: HardhatEthersSigner) => more.getProof([...more.entries()].find(([, [a]]) => a === who.address)![0]);
    await fresh.connect(alice).claim(0, proof(alice), 31n);
    await fresh.connect(bob).claim(1, proof(bob), 0n);
    await expect(fresh.connect(dave).claim(0, proof(dave), 33n)).to.be.revertedWithCustomError(dno, "TooManyBoxes");
  });

  it("stays under the HCU limit for the biggest gift", async function () {
    const receipt = await (await claim(alice, 0, 11n)).wait();
    const { globalHCU } = fhevm.computeTransactionHCU(receipt as Parameters<typeof fhevm.computeTransactionHCU>[0]);
    console.log(`      claim, first class: ${globalHCU} HCU`);
    expect(globalHCU).to.be.below(20_000_000);
  });
});
