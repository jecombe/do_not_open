import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { powerBounds, ratParamsFromSpec } from "../lib/ratParams";
import { DoNotOpen, DoNotOpenConfig, RatTricks, Rats, TestConfidentialUSDC, TestUSDC } from "../types";
import { confidentialUsdcOf, deploy, expectDenied, FEES, mintBoxes, NOT_YOURS, open, peekSeed, shakeAndDecrypt, traitByte, usd } from "./helpers";

const DAY = 86_400;
const SCRAMBLED = 254;
/** Even odds in these tests, so every power turns up within a few mints. */
const EVEN_ODDS = powerBounds([3334, 3333, 3333]);
const REBATE = (FEES.paidShake * 3000n) / 10_000n;

describe("RatTricks", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let broke: HardhatEthersSigner;
  let dno: DoNotOpen;
  let config: DoNotOpenConfig;
  let usdc: TestUSDC;
  let cUsdc: TestConfidentialUSDC;
  let rats: Rats;
  let tricks: RatTricks;
  let tricksAddress: string;
  let offsets: number[];
  let boxA: number;
  let boxB: number;
  let nextSeed = 1n;

  const powerOf = async (ratId: bigint) => Number(await fhevm.debugger.decryptEuint(FhevmType.euint8, await rats.powerOf(ratId)));

  /** Adopts free rats for `who` until one has power `power`, the way any player would mint. */
  async function ratWithPower(who: HardhatEthersSigner, power: number) {
    for (let i = 0; i < 60; i++) {
      const seed = nextSeed++;
      await (await rats.connect(who).mintSeed(seed, usd("1"))).wait();
      const id = await rats.tokenOfSeed(seed);
      if ((await powerOf(id)) === power) return id;
    }
    throw new Error(`no rat with power ${power}`);
  }

  async function trick(who: HardhatEthersSigner, ratId: bigint, tokenId: number, trait = 0) {
    const input = await fhevm.createEncryptedInput(tricksAddress, who.address).add8(trait).encrypt();
    return tricks.connect(who).trick(ratId, tokenId, input.handles[0]!, input.inputProof);
  }

  async function sniff(who: HardhatEthersSigner, ratId: bigint, tokenId: number) {
    await (await tricks.connect(who).sniff(ratId, tokenId)).wait();
    const [pick, roll] = await tricks.lastSniff(tokenId, who.address);
    return {
      pick: Number(await fhevm.userDecryptEuint(FhevmType.euint8, pick, await dno.getAddress(), who)),
      roll: Number(await fhevm.userDecryptEuint(FhevmType.euint8, roll, await dno.getAddress(), who)),
    };
  }

  /** The true roll at `pick` of a box. */
  const truth = async (tokenId: number, pick: number) => traitByte(await peekSeed(dno, tokenId), pick);

  beforeEach(async function () {
    const signers = (await ethers.getSigners()) as HardhatEthersSigner[];
    [deployer, alice, bob, carol] = signers as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    broke = signers[9]!;
    ({ dno, config, usdc, cUsdc } = await deploy({ maxSupply: 100 }));
    rats = (await (await ethers.getContractFactory("Rats")).deploy(
      await usdc.getAddress(), deployer.address, deployer.address, deployer.address, usd("1"), usd("3"), "", [500, 10, 500, 10], EVEN_ODDS,
    )) as unknown as Rats;
    tricks = (await (await ethers.getContractFactory("RatTricks")).deploy(
      await dno.getAddress(), await rats.getAddress(), await cUsdc.getAddress(), await config.getAddress(), REBATE, 3 * DAY, 7 * DAY, deployer.address, deployer.address,
    )) as unknown as RatTricks;
    tricksAddress = await tricks.getAddress();
    await dno.setGuard(tricksAddress);
    await dno.setTrustedReader(tricksAddress, true);
    await rats.setTricks(tricksAddress);
    const until = (await time.latest()) + 365 * DAY;
    // The treasury (the deployer here) pays the rebates; the players let the rats pay for sniffs.
    for (const who of [deployer, alice, bob, carol, broke]) {
      await cUsdc.connect(who).setOperator(tricksAddress, until);
      await usdc.mint(who.address, usd("500"));
      await usdc.connect(who).approve(await rats.getAddress(), usd("500"));
    }
    offsets = (await config.traitOffsets()).map(Number);
    boxA = (await mintBoxes(dno, alice, 1, 1)).owned[0]!;
    boxB = (await mintBoxes(dno, bob, 1, 1)).owned[0]!;
  });

  describe("powers", function () {
    it("turns the spec's odds into bounds on a 16-bit draw", async function () {
      expect(ratParamsFromSpec().powerBelow).to.deep.eq([36045, 55706]);
      expect(() => powerBounds([5000, 5000, 0])).to.throw(/odds/);
      expect(() => powerBounds([5000, 3000, 1000])).to.throw(/odds/);
      const Rats = await ethers.getContractFactory("Rats");
      const args = [await usdc.getAddress(), deployer.address, deployer.address, deployer.address, usd("1"), usd("3"), ""] as const;
      await expect(Rats.deploy(...args, [1, 1, 1, 1], [0, 10])).to.be.revertedWithCustomError(rats, "BadOdds");
      await expect(Rats.deploy(...args, [1, 1, 1, 1], [10, 5])).to.be.revertedWithCustomError(rats, "BadOdds");
    });

    it("draws 1, 2 or 3 at every mint, readable by the holder alone", async function () {
      await (await rats.connect(alice).mintSeed(42, usd("1"))).wait();
      const id = await rats.tokenOfSeed(42);
      const power = Number(await fhevm.userDecryptEuint(FhevmType.euint8, await rats.powerOf(id), await rats.getAddress(), alice));
      expect(power).to.be.within(1, 3);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, await rats.powerOf(id), await rats.getAddress(), bob));

      // Sold: the buyer asks to read it; nobody else may.
      await rats.connect(alice).transferFrom(alice.address, bob.address, id);
      await expect(rats.connect(carol).allowPower(id)).to.be.revertedWithCustomError(rats, "NotYourRat");
      await rats.connect(bob).allowPower(id);
      expect(Number(await fhevm.userDecryptEuint(FhevmType.euint8, await rats.powerOf(id), await rats.getAddress(), bob))).to.eq(power);
      // Only the tricks compute with it.
      await expect(rats.connect(bob).powerFor(id)).to.be.revertedWithCustomError(rats, "NotTricks");
    });

    it("gives the whitelist's gift rats a power too", async function () {
      await rats.setGiver(deployer.address);
      await rats.gift(carol.address, 777);
      const id = await rats.tokenOfSeed(777);
      expect(Number(await fhevm.userDecryptEuint(FhevmType.euint8, await rats.powerOf(id), await rats.getAddress(), carol))).to.be.within(1, 3);
    });

    it("spreads the powers by the odds", async function () {
      const seen = new Set<number>();
      for (let i = 0; i < 12; i++) {
        await (await rats.connect(carol).mintSeed(1000n + BigInt(i), usd("1"))).wait();
        seen.add(await powerOf(await rats.tokenOfSeed(1000n + BigInt(i))));
      }
      expect(seen.size).to.be.greaterThan(1);
    });
  });

  describe("sniff", function () {
    it("reads a trait of someone else's box at the full price, for the sniffer alone", async function () {
      const rat = await ratWithPower(alice, 2);
      const before = await confidentialUsdcOf(cUsdc, alice);
      const { pick, roll } = await sniff(alice, rat, boxB);
      expect(offsets).to.include(pick);
      expect(roll).to.eq(await truth(boxB, pick));
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(before - FEES.paidShake);
      const [handle] = await tricks.lastSniff(boxB, alice.address);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, handle, await dno.getAddress(), bob));
      await expect(tricks.connect(bob).sniff(rat, boxB)).to.be.revertedWithCustomError(tricks, "NotYourRat");
    });

    it("gives a power-1 rat its rebate back from the treasury", async function () {
      const rat = await ratWithPower(alice, 1);
      const before = await confidentialUsdcOf(cUsdc, alice);
      const treasury = await confidentialUsdcOf(cUsdc, deployer);
      await sniff(alice, rat, boxB);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(before - FEES.paidShake + REBATE);
      expect(await confidentialUsdcOf(cUsdc, deployer)).to.eq(treasury - REBATE);
    });

    it("reads nothing, and costs the treasury nothing, when the sniffer cannot pay", async function () {
      const rat = await ratWithPower(alice, 1);
      await rats.connect(alice).transferFrom(alice.address, broke.address, rat);
      const treasury = await confidentialUsdcOf(cUsdc, deployer);
      const { pick, roll } = await sniff(broke, rat, boxB);
      expect([pick, roll]).to.deep.eq([NOT_YOURS, 0]);
      expect(await confidentialUsdcOf(cUsdc, deployer)).to.eq(treasury);
      expect(await confidentialUsdcOf(cUsdc, broke)).to.eq(0n);
    });

    it("skips the rebate while the treasury has not made the tricks its operator", async function () {
      await cUsdc.connect(deployer).setOperator(tricksAddress, 0);
      const rat = await ratWithPower(alice, 1);
      const before = await confidentialUsdcOf(cUsdc, alice);
      await sniff(alice, rat, boxB);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(before - FEES.paidShake);
    });
  });

  describe("tricks", function () {
    /** Shakes `tokenId` until every one of `wanted` offsets came up at least once. */
    async function shakeAll(who: HardhatEthersSigner, tokenId: number, paid: boolean, wanted = offsets) {
      const seen = new Map<number, number[]>();
      for (let i = 0; i < 60 && wanted.some((o) => !seen.has(o)); i++) {
        const { pick, roll } = await shakeAndDecrypt(dno, tokenId, who, paid);
        seen.set(pick, [...(seen.get(pick) ?? []), roll]);
      }
      return seen;
    }

    it("power 3 on one's own box shields every trait: strangers read a fake, the same every time", async function () {
      const rat = await ratWithPower(alice, 3);
      await expect(trick(alice, rat, boxA)).to.emit(tricks, "TrickPlayed");
      const seen = await shakeAll(bob, boxA, true);
      let fakes = 0;
      for (const [pick, rolls] of seen) {
        expect(offsets).to.include(pick);
        expect(new Set(rolls).size, "a fake is stable").to.eq(1);
        if (rolls[0] !== (await truth(boxA, pick))) fakes++;
      }
      expect(fakes).to.be.greaterThan(2);
      // The holder still reads the truth.
      const own = await shakeAndDecrypt(dno, boxA, alice);
      expect(own.roll).to.eq(await truth(boxA, own.pick));
      // A rat's sniff is a stranger's shake too.
      const sniffer = await ratWithPower(carol, 2);
      const s = await sniff(carol, sniffer, boxA);
      expect(s.roll).to.eq(seen.get(s.pick)![0]);

      // Three days later, the shield is gone.
      await time.increase(3 * DAY);
      const after = await shakeAndDecrypt(dno, boxA, bob, true);
      expect(after.roll).to.eq(await truth(boxA, after.pick));
    });

    it("power 2 shields the one trait its holder picked", async function () {
      const rat = await ratWithPower(alice, 2);
      await trick(alice, rat, boxA, 1);
      const seen = await shakeAll(bob, boxA, true, [offsets[1]!, offsets[3]!]);
      const blocked = seen.get(offsets[1]!)!;
      expect(new Set(blocked).size).to.eq(1);
      const seed = await peekSeed(dno, boxA);
      for (const [pick, rolls] of seen) {
        if (pick !== offsets[1]) for (const r of rolls) expect(r).to.eq(traitByte(seed, pick));
      }
    });

    it("on someone else's box, jams the holder's own shakes", async function () {
      const rat = await ratWithPower(bob, 3);
      await trick(bob, rat, boxA);
      for (let i = 0; i < 3; i++) {
        const { pick, roll } = await shakeAndDecrypt(dno, boxA, alice);
        expect([pick, roll]).to.deep.eq([SCRAMBLED, 0]);
      }
      // Strangers are not jammed: a jam is not a shield.
      const paid = await shakeAndDecrypt(dno, boxA, carol, true);
      expect(paid.roll).to.eq(await truth(boxA, paid.pick));

      await time.increase(3 * DAY);
      const own = await shakeAndDecrypt(dno, boxA, alice);
      expect(own.roll).to.eq(await truth(boxA, own.pick));
    });

    it("power 2 jams only the trait picked", async function () {
      const rat = await ratWithPower(bob, 2);
      await trick(bob, rat, boxA, 4);
      const seen = await shakeAll(alice, boxA, false, [SCRAMBLED, offsets[0]!]);
      expect(seen.has(offsets[4]!)).to.eq(false);
      expect(seen.get(SCRAMBLED)!.every((r) => r === 0)).to.eq(true);
      const seed = await peekSeed(dno, boxA);
      for (const [pick, rolls] of seen) if (pick !== SCRAMBLED) for (const r of rolls) expect(r).to.eq(traitByte(seed, pick));
    });

    it("lets a full shield resist jams", async function () {
      await trick(alice, await ratWithPower(alice, 3), boxA);
      await trick(bob, await ratWithPower(bob, 3), boxA);
      for (let i = 0; i < 3; i++) {
        const { pick, roll } = await shakeAndDecrypt(dno, boxA, alice);
        expect(pick).to.not.eq(SCRAMBLED);
        expect(roll).to.eq(await truth(boxA, pick));
      }
    });

    it("lets power 1 bluff: nothing changes, and the trick looks like any other", async function () {
      const rat = await ratWithPower(alice, 1);
      const now = BigInt(await time.latest()) + 1n;
      await expect(trick(alice, rat, boxA)).to.emit(tricks, "TrickPlayed").withArgs(rat, boxA, alice.address, now + BigInt(3 * DAY), now + BigInt(10 * DAY));
      await trick(alice, await ratWithPower(alice, 1), boxB);
      const paid = await shakeAndDecrypt(dno, boxA, bob, true);
      expect(paid.roll).to.eq(await truth(boxA, paid.pick));
      const own = await shakeAndDecrypt(dno, boxB, bob);
      expect(own.roll).to.eq(await truth(boxB, own.pick));
    });

    it("rests a rat ten days between tricks, and only its holder sets it", async function () {
      const rat = await ratWithPower(alice, 2);
      await expect(trick(bob, rat, boxB)).to.be.revertedWithCustomError(tricks, "NotYourRat");
      await trick(alice, rat, boxA);
      const ready = await tricks.readyAt(rat);
      await expect(trick(alice, rat, boxB)).to.be.revertedWithCustomError(tricks, "Recharging").withArgs(ready);
      await time.increaseTo(ready);
      await trick(alice, rat, boxB);
    });

    it("refuses opened boxes, and answers DoNotOpen alone", async function () {
      const rat = await ratWithPower(alice, 2);
      await expect(tricks.connect(alice).filter(boxA, true, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(tricks, "OnlyBoxes");
      await open(dno, boxA, alice, bob);
      await expect(trick(alice, rat, boxA)).to.be.revertedWithCustomError(tricks, "NotSealed");
    });

    it("stays far under the HCU limit", async function () {
      const rat = await ratWithPower(alice, 3);
      const t = await (await trick(alice, rat, boxA)).wait();
      const s = await (await tricks.connect(bob).sniff(await ratWithPower(bob, 1), boxA)).wait();
      const hcu = (r: unknown) => fhevm.computeTransactionHCU(r as Parameters<typeof fhevm.computeTransactionHCU>[0]).globalHCU;
      console.log(`      trick: ${hcu(t)} HCU, sniff (shielded box, rebate): ${hcu(s)} HCU`);
      expect(hcu(t)).to.be.below(20_000_000);
      expect(hcu(s)).to.be.below(20_000_000);
    });
  });
});
