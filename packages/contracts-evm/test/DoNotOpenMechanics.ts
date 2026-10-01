import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { buildCatSpec } from "@dno/generator";
import { configParamsFromSpec } from "../lib/specParams";
import { DoNotOpen, TestConfidentialUSDC, TestUSDC } from "../types";
import {
  confidentialUsdcOf,
  deploy,
  expectDenied,
  FEES,
  finalizeDuel,
  finalizeRequest,
  giveConfidentialUsdc,
  mintBoxes,
  NOT_YOURS,
  open,
  parseEvents,
  peekSeed,
  REQUEST,
  requestIdOf,
  shakeAndDecrypt,
  STARTING_CUSDC,
  traitByte,
  usd,
} from "./helpers";

describe("DoNotOpen mechanics", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let poor: HardhatEthersSigner;
  let dno: DoNotOpen;
  let address: string;
  let usdc: TestUSDC;
  let cUsdc: TestConfidentialUSDC;
  /** Alice holds A[0..2], bob holds B[0..2]. */
  let A: number[];
  let B: number[];

  const params = configParamsFromSpec();
  const share = (FEES.paidShake * BigInt(params.paidShakeHolderBps)) / 10_000n;
  const hcu = async (tx: Promise<{ wait(): Promise<unknown> }>) =>
    fhevm.computeTransactionHCU((await (await tx).wait()) as Parameters<typeof fhevm.computeTransactionHCU>[0]);

  before(async function () {
    [deployer, alice, bob, carol] = (await ethers.getSigners()) as [
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
    ];
    poor = (await ethers.getSigners())[9]!;
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    ({ dno, address, usdc, cUsdc } = await deploy());
    A = (await mintBoxes(dno, alice, 3)).owned;
    B = (await mintBoxes(dno, bob, 3)).owned;
  });

  describe("feed", function () {
    it("lets anyone feed for the fee and adds a hidden amount each time", async function () {
      for (let i = 0; i < 10; i++) {
        await expect(dno.connect(carol).feed(A[0]!)).to.emit(dno, "Fed").withArgs(A[0], carol.address);
      }
      expect(await confidentialUsdcOf(cUsdc, carol)).to.eq(STARTING_CUSDC - 10n * FEES.feed);
      await open(dno, A[0]!, alice, carol);
      const affection = Number((await dno.contentsOf(A[0]!)).affection);
      expect(affection).to.be.within(0, 10 * (params.feedBound - 1));
    });

    it("adds nothing when the feeder cannot pay", async function () {
      await giveConfidentialUsdc(usdc, cUsdc, dno, poor, FEES.feed - 1n);
      for (let i = 0; i < 6; i++) await (await dno.connect(poor).feed(A[1]!)).wait();
      expect(await confidentialUsdcOf(cUsdc, poor)).to.eq(FEES.feed - 1n);
      await open(dno, A[1]!, alice, carol);
      expect((await dno.contentsOf(A[1]!)).affection).to.eq(0n);
    });

    it("refuses opened and unknown boxes", async function () {
      await expect(dno.connect(carol).feed(9999)).to.be.revertedWithCustomError(dno, "ConfidentialERC721NonexistentToken");
      await open(dno, A[0]!, alice, carol);
      await expect(dno.connect(carol).feed(A[0]!)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("turns the accessory golden at reveal exactly like the generator", async function () {
      for (let i = 0; i < 12; i++) await (await dno.connect(carol).feed(A[0]!)).wait();
      await open(dno, A[0]!, alice, carol);
      const c = await dno.contentsOf(A[0]!);
      const cat = buildCatSpec({ seed: c.seed, affection: Number(c.affection) });
      expect(c.golden).to.eq(Number(c.affection) > params.goldenThreshold);
      expect(c.golden).to.eq(cat.rarity.golden);
      expect(Number(c.score)).to.eq(cat.rarity.score);
    });

    it("stays within the HCU budget", async function () {
      expect((await hcu(dno.connect(carol).feed(A[0]!))).globalHCU).to.be.lessThan(1_200_000);
    });
  });

  describe("paidShake", function () {
    it("shows one real trait to the payer only and keeps the holder's share in the box", async function () {
      const seed = await peekSeed(dno, A[0]!);
      const { pick, roll, handles } = await shakeAndDecrypt(dno, A[0]!, carol, true);
      expect(roll).to.eq(traitByte(seed, pick));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, handles.roll, address, alice));
      expect(await confidentialUsdcOf(cUsdc, carol)).to.eq(STARTING_CUSDC - FEES.paidShake);

      // A stranger claiming the box gets nothing and leaves the earnings in place.
      await (await dno.connect(bob).claimEarnings([A[0]!])).wait();
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC - 3n * FEES.mint);
      const before = await confidentialUsdcOf(cUsdc, alice);
      await (await dno.connect(alice).claimEarnings([A[0]!, A[1]!])).wait();
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(before + share);
      // Paid out once.
      await (await dno.connect(alice).claimEarnings([A[0]!])).wait();
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(before + share);
    });

    it("shows nothing to a payer who could not pay, and earns the holder nothing", async function () {
      await giveConfidentialUsdc(usdc, cUsdc, dno, poor, usd("1"));
      expect((await shakeAndDecrypt(dno, A[0]!, poor, true)).pick).to.eq(NOT_YOURS);
      const before = await confidentialUsdcOf(cUsdc, alice);
      await (await dno.connect(alice).claimEarnings([A[0]!])).wait();
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(before);
    });

    it("pays the share to whoever holds the box when it is claimed", async function () {
      await (await dno.connect(carol).paidShake(A[0]!)).wait();
      await (await dno.connect(alice).confidentialTransfer(bob.address, A[0]!)).wait();
      const before = await confidentialUsdcOf(cUsdc, bob);
      await (await dno.connect(bob).claimEarnings([A[0]!])).wait();
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(before + share);
    });

    it("books the rest as revenue and caps a claim at ten boxes", async function () {
      await (await dno.connect(carol).paidShake(A[0]!)).wait();
      const revenue = await fhevm.userDecryptEuint(FhevmType.euint64, await dno.revenueHandle(), address, deployer);
      expect(revenue).to.eq(6n * FEES.mint + FEES.paidShake - share);
      await expect(dno.connect(alice).claimEarnings(Array(11).fill(A[0]!))).to.be.revertedWithCustomError(dno, "TooManyBoxes");
    });
  });

  describe("entangle", function () {
    /** Accepts and relays. Returns the request status. */
    async function accept(a: number, b: number, who: HardhatEthersSigner) {
      const id = requestIdOf(dno, await (await dno.connect(who).acceptEntangle(a, b)).wait());
      await (await finalizeRequest(dno, id, carol)).wait();
      return Number((await dno.requestInfo(id))[1]);
    }

    it("links two boxes with both holders' consent and opens them together", async function () {
      await expect(dno.connect(alice).proposeEntangle(A[0]!, B[0]!)).to.emit(dno, "EntangleProposed").withArgs(A[0], B[0], alice.address);
      expect(await dno.entangleProposer(A[0]!, B[0]!)).to.eq(alice.address);
      expect(await accept(A[0]!, B[0]!, bob)).to.eq(REQUEST.Done);
      expect(await dno.partnerOf(A[0]!)).to.deep.eq([true, BigInt(B[0]!)]);
      expect(await dno.partnerOf(B[0]!)).to.deep.eq([true, BigInt(A[0]!)]);
      expect(await dno.entangleProposer(A[0]!, B[0]!)).to.eq(ethers.ZeroAddress);

      // Only alice's box was fed: the opening publishes its affection, not bob's.
      for (let i = 0; i < 4; i++) await (await dno.connect(carol).feed(A[0]!)).wait();
      // Bob opens his box; alice's is dragged along. One fee.
      expect(await open(dno, B[0]!, bob, carol)).to.eq(REQUEST.Done);
      expect((await dno.contentsOf(B[0]!)).affection).to.eq(0n);
      const fedCat = await dno.contentsOf(A[0]!);
      expect(buildCatSpec({ seed: fedCat.seed, affection: Number(fedCat.affection) }).rarity.score).to.eq(Number(fedCat.score));
      expect(await dno.revealed(A[0]!)).to.eq(true);
      expect(await dno.revealed(B[0]!)).to.eq(true);
      expect((await dno.contentsOf(A[0]!)).seed).to.eq(await peekSeed(dno, A[0]!));
    });

    it("links nothing unless the proposer holds A and the accepter holds B", async function () {
      await dno.connect(carol).proposeEntangle(A[0]!, B[0]!);
      expect(await accept(A[0]!, B[0]!, bob)).to.eq(REQUEST.Refused);
      await dno.connect(alice).proposeEntangle(A[1]!, B[1]!);
      expect(await accept(A[1]!, B[1]!, carol)).to.eq(REQUEST.Refused);
      expect((await dno.partnerOf(A[0]!))[0]).to.eq(false);
      expect((await dno.partnerOf(A[1]!))[0]).to.eq(false);
      await expect(dno.connect(bob).acceptEntangle(A[2]!, B[2]!)).to.be.revertedWithCustomError(dno, "NoSuchProposal");
    });

    it("rejects self-links, second partners, opened and missing boxes", async function () {
      await expect(dno.connect(alice).proposeEntangle(A[0]!, A[0]!)).to.be.revertedWithCustomError(dno, "SameBox");
      await expect(dno.connect(alice).proposeEntangle(A[0]!, 9999)).to.be.revertedWithCustomError(dno, "ConfidentialERC721NonexistentToken");
      await dno.connect(alice).proposeEntangle(A[0]!, B[0]!);
      await accept(A[0]!, B[0]!, bob);
      await expect(dno.connect(alice).proposeEntangle(A[0]!, B[1]!)).to.be.revertedWithCustomError(dno, "AlreadyEntangled");
      await open(dno, A[2]!, alice, carol);
      await expect(dno.connect(alice).proposeEntangle(A[2]!, B[2]!)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("lets one holder entangle two of their own boxes, and follows a transfer", async function () {
      await dno.connect(alice).proposeEntangle(A[0]!, A[1]!);
      expect(await accept(A[0]!, A[1]!, alice)).to.eq(REQUEST.Done);
      await (await dno.connect(alice).confidentialTransfer(carol.address, A[1]!)).wait();
      expect(await open(dno, A[1]!, carol, bob)).to.eq(REQUEST.Done);
      expect(await dno.revealed(A[0]!)).to.eq(true);
    });
  });

  describe("duel", function () {
    const baseScore = async (tokenId: number) => buildCatSpec({ seed: await peekSeed(dno, tokenId) }).rarity.score;

    it("resolves to the higher score and reveals one trait of the loser only", async function () {
      let duelId = 0;
      for (const a of A) {
        for (const b of B.slice(0, 2)) {
          const expectedWinner = (await baseScore(a)) > (await baseScore(b)) ? a : b;
          const loser = expectedWinner === a ? b : a;
          const winsBefore = await dno.wins(expectedWinner);

          await expect(dno.connect(alice).challengeDuel(a, b)).to.emit(dno, "DuelChallenged").withArgs(duelId, a, b);
          await expect(dno.connect(bob).acceptDuel(duelId)).to.emit(dno, "DuelAccepted").withArgs(duelId);
          const receipt = await (await finalizeDuel(dno, duelId, carol)).wait();
          const [event] = parseEvents(dno, receipt!.logs, "DuelResolved");
          const [, winnerId, loserId, traitIndex, roll] = event!;

          expect(Number(winnerId)).to.eq(expectedWinner);
          expect(Number(loserId)).to.eq(loser);
          expect(Number(roll)).to.eq(traitByte(await peekSeed(dno, loser), params.traitOffset[Number(traitIndex)]!));
          expect(await dno.wins(expectedWinner)).to.eq(winsBefore + 1n);
          const [mask] = await dno.publicTraitsOf(loser);
          expect(Number(mask) & (1 << Number(traitIndex))).to.not.eq(0);
          const info = await dno.duelInfo(duelId);
          expect([info.duelStatus, info.accepter]).to.deep.eq([3n, bob.address]);
          duelId++;
        }
      }
      for (const id of [...A, ...B]) {
        expect(await dno.status(id)).to.eq(0);
        await expectDenied(fhevm.publicDecrypt([await dno.seedHandle(id)]));
      }
    });

    it("is void, and shows nothing, unless both sides hold their boxes", async function () {
      // Carol challenges with a box she does not hold.
      await dno.connect(carol).challengeDuel(A[0]!, B[0]!);
      await dno.connect(bob).acceptDuel(0);
      const clear = await fhevm.publicDecrypt([...(await dno.duelHandles(0))]);
      expect(Object.values(clear.clearValues).map((v) => BigInt(v as bigint | boolean))).to.deep.eq([0n, 0n, 0n, 0n]);
      await expect(finalizeDuel(dno, 0, carol)).to.emit(dno, "DuelVoided").withArgs(0);
      expect((await dno.duelInfo(0)).duelStatus).to.eq(5n);
      expect((await dno.publicTraitsOf(B[0]!))[0]).to.eq(0);

      // Alice challenges properly, carol accepts for a box she does not hold.
      await dno.connect(alice).challengeDuel(A[0]!, B[0]!);
      await dno.connect(carol).acceptDuel(1);
      await expect(finalizeDuel(dno, 1, carol)).to.emit(dno, "DuelVoided").withArgs(1);
      // A challenger who gave the box away meanwhile: void too.
      await dno.connect(alice).challengeDuel(A[1]!, B[1]!);
      await (await dno.connect(alice).confidentialTransfer(carol.address, A[1]!)).wait();
      await dno.connect(bob).acceptDuel(2);
      await expect(finalizeDuel(dno, 2, carol)).to.emit(dno, "DuelVoided").withArgs(2);
    });

    it("can be cancelled by the challenger until accepted", async function () {
      await dno.connect(alice).challengeDuel(A[0]!, B[0]!);
      await expect(dno.connect(bob).cancelDuel(0)).to.be.revertedWithCustomError(dno, "NotChallenger");
      await expect(dno.connect(alice).cancelDuel(0)).to.emit(dno, "DuelCancelled").withArgs(0);
      await expect(dno.connect(bob).acceptDuel(0)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");
    });

    it("refuses opened boxes and the same box twice", async function () {
      await expect(dno.connect(alice).challengeDuel(A[0]!, A[0]!)).to.be.revertedWithCustomError(dno, "SameBox");
      await dno.connect(alice).challengeDuel(A[1]!, B[1]!);
      await open(dno, B[1]!, bob, carol);
      await expect(dno.connect(bob).acceptDuel(0)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("rejects a forged outcome and double finalisation", async function () {
      await dno.connect(alice).challengeDuel(A[0]!, B[0]!);
      await dno.connect(bob).acceptDuel(0);
      const real = await fhevm.publicDecrypt([...(await dno.duelHandles(0))]);
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const [valid, aWins, pick, roll] = coder.decode(["bool", "bool", "uint8", "uint8"], real.abiEncodedClearValues);
      const flipped = coder.encode(["bool", "bool", "uint8", "uint8"], [valid, !aWins, pick, roll]);
      await expect(dno.finalizeDuel(0, flipped, real.decryptionProof)).to.be.reverted;
      await dno.finalizeDuel(0, real.abiEncodedClearValues, real.decryptionProof);
      await expect(dno.finalizeDuel(0, real.abiEncodedClearValues, real.decryptionProof)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");
    });

    it("computes each box's encrypted score once, within the HCU budget", async function () {
      const first = await hcu(dno.connect(alice).challengeDuel(A[0]!, B[0]!));
      expect(first.globalHCU).to.be.within(1_000_000, 1_400_000);
      const accept = await hcu(dno.connect(bob).acceptDuel(0));
      expect(accept.globalHCU).to.be.lessThan(3_500_000);
      expect(accept.maxHCUDepth).to.be.lessThan(5_000_000);
      expect((await hcu(dno.connect(alice).challengeDuel(A[0]!, B[0]!))).globalHCU).to.eq(0);
    });
  });
});
