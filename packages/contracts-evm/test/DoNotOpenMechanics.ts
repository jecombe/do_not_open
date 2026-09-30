import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { buildCatSpec } from "@dno/generator";
import { configParamsFromSpec } from "../lib/specParams";
import { DoNotOpen } from "../types";
import {
  deploy,
  expectDenied,
  FEES,
  finalizeDuel,
  finalizeObserve,
  peekSeed,
  shakeAndDecrypt,
  STATE_IDS,
  TRAIT_KEYS,
  traitByte,
} from "./helpers";

describe("DoNotOpen mechanics", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dno: DoNotOpen;
  let address: string;

  const params = configParamsFromSpec();
  const hcu = async (tx: Promise<{ wait(): Promise<unknown> }>) =>
    fhevm.computeTransactionHCU((await (await tx).wait()) as Parameters<typeof fhevm.computeTransactionHCU>[0]);

  before(async function () {
    [deployer, alice, bob, carol] = (await ethers.getSigners()) as [
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
    ];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    ({ dno, address } = await deploy());
    // Boxes 0-2 belong to alice, 3-5 to bob.
    await dno.connect(alice).mint(3, { value: FEES.mint * 3n });
    await dno.connect(bob).mint(3, { value: FEES.mint * 3n });
  });

  describe("feed", function () {
    /** Mock only. The affection handle is exposed by observeHandles once a box was fed. */
    const peekAffection = async (tokenId: number) => {
      const handles = await dno.observeHandles(tokenId);
      return handles.length < 2 ? 0n : fhevm.debugger.decryptEuint(FhevmType.euint32, handles[1]!);
    };

    it("lets anyone feed a box and adds a hidden amount each time", async function () {
      const max = BigInt(params.feedBound - 1);
      let previous = 0n;
      const gains = new Set<bigint>();
      for (let i = 0; i < 10; i++) {
        await expect(dno.connect(carol).feed(0, { value: FEES.feed })).to.emit(dno, "Fed").withArgs(0, carol.address);
        const now = await peekAffection(0);
        expect(now - previous).to.be.within(0n, max);
        gains.add(now - previous);
        previous = now;
      }
      // Ten identical draws out of four values would be a one-in-260,000 coincidence.
      expect(gains.size).to.be.greaterThan(1);
    });

    it("keeps affection unreadable, even for the feeder and the holder", async function () {
      await dno.connect(carol).feed(0, { value: FEES.feed });
      const [, affectionHandle] = await dno.observeHandles(0);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint32, affectionHandle!, address, carol));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint32, affectionHandle!, address, alice));
      await expectDenied(fhevm.publicDecrypt([affectionHandle!]));
    });

    it("requires the exact fee, an existing box and a sealed one", async function () {
      await expect(dno.connect(carol).feed(0)).to.be.revertedWithCustomError(dno, "WrongPayment");
      await expect(dno.connect(carol).feed(99, { value: FEES.feed })).to.be.revertedWithCustomError(dno, "ERC721NonexistentToken");
      await dno.connect(alice).observe(0, { value: FEES.observe });
      await expect(dno.connect(carol).feed(0, { value: FEES.feed })).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("stays within the documented HCU budget", async function () {
      expect((await hcu(dno.connect(carol).feed(0, { value: FEES.feed }))).globalHCU).to.be.lessThan(150_000);
    });

    it("turns the accessory golden at reveal only above the threshold", async function () {
      const threshold = BigInt(params.goldenThreshold);

      // Box 0: fed until its hidden affection is past the threshold.
      while ((await peekAffection(0)) <= threshold) await dno.connect(carol).feed(0, { value: FEES.feed });
      // Box 1: fed, but kept at or below the threshold.
      await dno.connect(carol).feed(1, { value: FEES.feed });
      expect(await peekAffection(1)).to.be.lessThanOrEqual(threshold);

      for (const [tokenId, expectGolden] of [[0, true], [1, false], [2, false]] as const) {
        const seed = await peekSeed(dno, tokenId);
        const affection = Number(await peekAffection(tokenId));
        const cat = buildCatSpec({ seed, affection });
        expect(cat.rarity.golden).to.eq(expectGolden);

        await dno.connect(alice).observe(tokenId, { value: FEES.observe });
        await expect(finalizeObserve(dno, tokenId, carol))
          .to.emit(dno, "Observed")
          .withArgs(tokenId, seed, STATE_IDS[cat.state], cat.rarity.score, expectGolden);

        const contents = await dno.contentsOf(tokenId);
        expect(contents.golden).to.eq(expectGolden);
        expect(Number(contents.affection)).to.eq(affection);
        expect(Number(contents.score)).to.eq(cat.rarity.score);
      }
    });

    it("rejects an inflated affection at reveal", async function () {
      await dno.connect(carol).feed(0, { value: FEES.feed });
      await dno.connect(alice).observe(0, { value: FEES.observe });
      const real = await fhevm.publicDecrypt([...(await dno.observeHandles(0))]);
      const [seed] = ethers.AbiCoder.defaultAbiCoder().decode(["uint64", "uint32"], real.abiEncodedClearValues);
      const forged = ethers.AbiCoder.defaultAbiCoder().encode(["uint64", "uint32"], [seed, 999]);
      await expect(dno.finalizeObserve(0, forged, real.decryptionProof)).to.be.reverted;
    });
  });

  describe("paidShake", function () {
    it("shows one real trait to the payer only and credits the holder 70%", async function () {
      const seed = await peekSeed(dno, 0);
      const share = (FEES.paidShake * BigInt(params.paidShakeHolderBps)) / 10_000n;

      const { pick, roll, handles } = await shakeAndDecrypt(dno, 0, carol, true);
      expect(roll).to.eq(traitByte(seed, pick));

      // The holder is paid but learns nothing.
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, handles.roll, address, alice));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, handles.pick, address, alice));

      expect(await dno.credits(alice.address)).to.eq(share);
      expect(await dno.totalCredits()).to.eq(share);
      await expect(dno.connect(alice).claim()).to.changeEtherBalance(alice, share);
      expect(await dno.credits(alice.address)).to.eq(0);
      await expect(dno.connect(alice).claim()).to.be.revertedWithCustomError(dno, "NothingToClaim");
    });

    it("emits Shaken with paid = true", async function () {
      await expect(dno.connect(carol).paidShake(0, { value: FEES.paidShake }))
        .to.emit(dno, "Shaken")
        .withArgs(0, carol.address, true);
    });

    it("is refused to the holder, without the exact fee, or on an opened box", async function () {
      await expect(dno.connect(alice).paidShake(0, { value: FEES.paidShake })).to.be.revertedWithCustomError(dno, "HolderShakesForFree");
      await expect(dno.connect(carol).paidShake(0, { value: FEES.paidShake - 1n })).to.be.revertedWithCustomError(dno, "WrongPayment");
      await dno.connect(alice).observe(0, { value: FEES.observe });
      await expect(dno.connect(carol).paidShake(0, { value: FEES.paidShake })).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("credits whoever holds the box at the time of the shake", async function () {
      const share = (FEES.paidShake * BigInt(params.paidShakeHolderBps)) / 10_000n;
      await dno.connect(carol).paidShake(0, { value: FEES.paidShake });
      await dno.connect(alice).transferFrom(alice.address, bob.address, 0);
      await dno.connect(carol).paidShake(0, { value: FEES.paidShake });
      expect(await dno.credits(alice.address)).to.eq(share);
      expect(await dno.credits(bob.address)).to.eq(share);
    });

    it("keeps unclaimed holder credits out of the owner's withdrawal", async function () {
      const share = (FEES.paidShake * BigInt(params.paidShakeHolderBps)) / 10_000n;
      await dno.connect(carol).paidShake(0, { value: FEES.paidShake });
      const revenue = FEES.mint * 6n + FEES.paidShake - share;
      await expect(dno.connect(deployer).withdraw(deployer.address)).to.changeEtherBalance(deployer, revenue);
      await expect(dno.connect(alice).claim()).to.changeEtherBalance(alice, share);
      expect(await ethers.provider.getBalance(address)).to.eq(0);
    });
  });

  describe("entangle", function () {
    it("links two boxes with both holders' consent and opens them together", async function () {
      await expect(dno.connect(alice).proposeEntangle(0, 3)).to.emit(dno, "EntangleProposed").withArgs(0, 3);
      expect((await dno.partnerOf(0)).entangled).to.eq(false);

      await expect(dno.connect(bob).acceptEntangle(0, 3)).to.emit(dno, "Entangled").withArgs(0, 3);
      expect(await dno.partnerOf(0)).to.deep.eq([true, 3n]);
      expect(await dno.partnerOf(3)).to.deep.eq([true, 0n]);

      // Bob observes his box; alice's is dragged along. One fee.
      const tx = dno.connect(bob).observe(3, { value: FEES.observe });
      await expect(tx).to.emit(dno, "ObserveRequested").withArgs(3).and.to.emit(dno, "ObserveRequested").withArgs(0);
      expect(await dno.status(0)).to.eq(1);
      expect(await dno.status(3)).to.eq(1);

      await finalizeObserve(dno, 0, carol);
      await finalizeObserve(dno, 3, carol);
      expect(await dno.revealed(0)).to.eq(true);
      expect(await dno.revealed(3)).to.eq(true);
      expect((await dno.contentsOf(0)).seed).to.eq(await peekSeed(dno, 0));
    });

    it("needs the second holder's consent", async function () {
      await dno.connect(alice).proposeEntangle(0, 3);
      await expect(dno.connect(carol).acceptEntangle(0, 3)).to.be.revertedWithCustomError(dno, "NotHolder");
      await expect(dno.connect(alice).acceptEntangle(0, 3)).to.be.revertedWithCustomError(dno, "NotHolder");
      // Nobody can accept a proposal that was never made, in either direction.
      await expect(dno.connect(bob).acceptEntangle(1, 3)).to.be.revertedWithCustomError(dno, "NoSuchProposal");
      await expect(dno.connect(alice).acceptEntangle(3, 0)).to.be.revertedWithCustomError(dno, "NoSuchProposal");
      // Observing before acceptance affects only one box.
      await dno.connect(bob).observe(3, { value: FEES.observe });
      expect(await dno.status(0)).to.eq(0);
    });

    it("voids a proposal when the proposer's box changes hands", async function () {
      await dno.connect(alice).proposeEntangle(0, 3);
      await dno.connect(alice).transferFrom(alice.address, carol.address, 0);
      await expect(dno.connect(bob).acceptEntangle(0, 3)).to.be.revertedWithCustomError(dno, "NoSuchProposal");
    });

    it("rejects self-links, second partners, opened and missing boxes", async function () {
      await expect(dno.connect(alice).proposeEntangle(0, 0)).to.be.revertedWithCustomError(dno, "SameBox");
      await expect(dno.connect(bob).proposeEntangle(0, 3)).to.be.revertedWithCustomError(dno, "NotHolder");
      await expect(dno.connect(alice).proposeEntangle(0, 99)).to.be.revertedWithCustomError(dno, "ERC721NonexistentToken");

      await dno.connect(alice).proposeEntangle(0, 3);
      await dno.connect(alice).proposeEntangle(1, 3);
      await dno.connect(bob).acceptEntangle(0, 3);
      await expect(dno.connect(bob).acceptEntangle(1, 3)).to.be.revertedWithCustomError(dno, "AlreadyEntangled");
      await expect(dno.connect(alice).proposeEntangle(0, 4)).to.be.revertedWithCustomError(dno, "AlreadyEntangled");

      await dno.connect(alice).observe(2, { value: FEES.observe });
      await expect(dno.connect(alice).proposeEntangle(2, 4)).to.be.revertedWithCustomError(dno, "NotSealed");
      await expect(dno.connect(bob).proposeEntangle(4, 2)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("lets one holder entangle two of their own boxes, and follows a transfer", async function () {
      await dno.connect(alice).proposeEntangle(0, 1);
      await dno.connect(alice).acceptEntangle(0, 1);
      await dno.connect(alice).transferFrom(alice.address, carol.address, 1);

      // Carol now holds box 1; opening it still opens alice's box 0.
      await dno.connect(carol).observe(1, { value: FEES.observe });
      expect(await dno.status(0)).to.eq(1);
    });

    it("uses no FHE operation", async function () {
      expect((await hcu(dno.connect(alice).proposeEntangle(0, 3))).globalHCU).to.eq(0);
      expect((await hcu(dno.connect(bob).acceptEntangle(0, 3))).globalHCU).to.eq(0);
    });
  });

  describe("duel", function () {
    const baseScore = async (tokenId: number) => buildCatSpec({ seed: await peekSeed(dno, tokenId) }).rarity.score;

    it("resolves to the higher score and reveals one trait of the loser only", async function () {
      // Every alice box against every bob box.
      let duelId = 0;
      for (const a of [0, 1, 2]) {
        for (const b of [3, 4, 5]) {
          const scoreA = await baseScore(a);
          const scoreB = await baseScore(b);
          const expectedWinner = scoreA > scoreB ? a : b;
          const loser = expectedWinner === a ? b : a;
          const winsBefore = await dno.wins(expectedWinner);

          await expect(dno.connect(alice).challengeDuel(a, b)).to.emit(dno, "DuelChallenged").withArgs(duelId, a, b);
          await expect(dno.connect(bob).acceptDuel(duelId)).to.emit(dno, "DuelAccepted").withArgs(duelId);

          const tx = await finalizeDuel(dno, duelId, carol);
          const receipt = await tx.wait();
          const event = receipt!.logs.map((l) => dno.interface.parseLog(l)).find((e) => e?.name === "DuelResolved")!;
          const [, winnerId, loserId, traitIndex, roll] = event.args;

          expect(Number(winnerId)).to.eq(expectedWinner);
          expect(Number(loserId)).to.eq(loser);
          expect(Number(roll)).to.eq(traitByte(await peekSeed(dno, loser), params.traitOffset[Number(traitIndex)]!));
          expect(await dno.wins(expectedWinner)).to.eq(winsBefore + 1n);

          const [mask, rolls] = await dno.publicTraitsOf(loser);
          expect(Number(mask) & (1 << Number(traitIndex))).to.not.eq(0);
          expect(Number(rolls[Number(traitIndex)])).to.eq(Number(roll));
          expect((await dno.duelInfo(duelId)).duelStatus).to.eq(3);
          duelId++;
        }
      }
      // Nothing else leaked: every box is still sealed with a private seed.
      for (let tokenId = 0; tokenId < 6; tokenId++) {
        expect(await dno.status(tokenId)).to.eq(0);
        await expectDenied(fhevm.publicDecrypt([await dno.seedHandle(tokenId)]));
      }
    });

    it("lets the challenger win only on a strictly higher score", async function () {
      // Equal scores cannot be forced with random seeds; this pins the comparison the
      // tie rule rests on: the published bit is exactly (scoreA > scoreB).
      const scoreA = await baseScore(0);
      const scoreB = await baseScore(3);
      await dno.connect(alice).challengeDuel(0, 3);
      await dno.connect(bob).acceptDuel(0);
      const result = await fhevm.publicDecrypt([...(await dno.duelHandles(0))]);
      const [aWins] = ethers.AbiCoder.defaultAbiCoder().decode(["bool", "uint8", "uint8"], result.abiEncodedClearValues);
      expect(aWins).to.eq(scoreA > scoreB);
    });

    it("computes each box's encrypted score once and reuses it", async function () {
      const first = await hcu(dno.connect(alice).challengeDuel(0, 3));
      expect(first.globalHCU).to.be.within(1_000_000, 1_400_000);
      const accept = await hcu(dno.connect(bob).acceptDuel(0));
      expect(accept.globalHCU).to.be.within(2_000_000, 2_500_000);
      expect(accept.maxHCUDepth).to.be.lessThan(5_000_000);

      // Same boxes again: both scores are cached.
      expect((await hcu(dno.connect(alice).challengeDuel(0, 3))).globalHCU).to.eq(0);
      expect((await hcu(dno.connect(bob).acceptDuel(1))).globalHCU).to.be.lessThan(1_100_000);
    });

    it("needs both holders' consent", async function () {
      await expect(dno.connect(bob).challengeDuel(0, 3)).to.be.revertedWithCustomError(dno, "NotHolder");
      await dno.connect(alice).challengeDuel(0, 3);
      await expect(dno.connect(alice).acceptDuel(0)).to.be.revertedWithCustomError(dno, "NotHolder");
      await expect(dno.connect(carol).acceptDuel(0)).to.be.revertedWithCustomError(dno, "NotHolder");
      await expect(dno.connect(bob).acceptDuel(7)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");
    });

    it("can be cancelled by the challenger until accepted", async function () {
      await dno.connect(alice).challengeDuel(0, 3);
      await expect(dno.connect(bob).cancelDuel(0)).to.be.revertedWithCustomError(dno, "NotHolder");
      await expect(dno.connect(alice).cancelDuel(0)).to.emit(dno, "DuelCancelled").withArgs(0);
      await expect(dno.connect(bob).acceptDuel(0)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");

      await dno.connect(alice).challengeDuel(0, 3);
      await dno.connect(bob).acceptDuel(1);
      await expect(dno.connect(alice).cancelDuel(1)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");
    });

    it("is void if the challenger's box was transferred, and refuses opened boxes", async function () {
      await dno.connect(alice).challengeDuel(0, 3);
      await dno.connect(alice).transferFrom(alice.address, carol.address, 0);
      await expect(dno.connect(bob).acceptDuel(0)).to.be.revertedWithCustomError(dno, "ChallengerNoLongerHolds");

      await expect(dno.connect(alice).challengeDuel(1, 1)).to.be.revertedWithCustomError(dno, "SameBox");
      await dno.connect(alice).challengeDuel(1, 4);
      await dno.connect(bob).observe(4, { value: FEES.observe });
      await expect(dno.connect(bob).acceptDuel(1)).to.be.revertedWithCustomError(dno, "NotSealed");
      await expect(dno.connect(alice).challengeDuel(2, 4)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("rejects a forged outcome and double finalisation", async function () {
      await dno.connect(alice).challengeDuel(0, 3);
      await expect(dno.finalizeDuel(0, "0x", "0x")).to.be.revertedWithCustomError(dno, "WrongDuelStatus"); // not accepted yet
      await dno.connect(bob).acceptDuel(0);

      const real = await fhevm.publicDecrypt([...(await dno.duelHandles(0))]);
      const [aWins, pick, roll] = ethers.AbiCoder.defaultAbiCoder().decode(["bool", "uint8", "uint8"], real.abiEncodedClearValues);
      const flipped = ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint8", "uint8"], [!aWins, pick, roll]);
      await expect(dno.finalizeDuel(0, flipped, real.decryptionProof)).to.be.reverted;

      await dno.finalizeDuel(0, real.abiEncodedClearValues, real.decryptionProof);
      await expect(dno.finalizeDuel(0, real.abiEncodedClearValues, real.decryptionProof)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");
    });

    it("still resolves if a box is opened while the outcome is pending", async function () {
      await dno.connect(alice).challengeDuel(0, 3);
      await dno.connect(bob).acceptDuel(0);
      await dno.connect(alice).observe(0, { value: FEES.observe });
      await finalizeObserve(dno, 0, carol);
      await expect(finalizeDuel(dno, 0, carol)).to.emit(dno, "DuelResolved");
    });
  });
});
