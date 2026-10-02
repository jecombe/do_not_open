import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { spec } from "@dno/game-spec";
import { buildCatSpec } from "@dno/generator";
import { configParamsFromSpec } from "../lib/specParams";
import { DoNotOpen, TestConfidentialUSDC, TestUSDC } from "../types";
import {
  confidentialUsdcOf,
  deploy,
  DUEL,
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
  postDuel,
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
      for (const a of A) {
        for (const b of B.slice(0, 2)) {
          const expectedWinner = (await baseScore(a)) > (await baseScore(b)) ? a : b;
          const loser = expectedWinner === a ? b : a;
          const winsBefore = await dno.wins(expectedWinner);

          const duelId = await dno.duelCount();
          await expect(dno.connect(alice).postDuel(a, 0, false)).to.emit(dno, "DuelPosted").withArgs(duelId, a, 0, alice.address, false);
          await expect(finalizeDuel(dno, duelId, carol)).to.emit(dno, "DuelOpened");
          await expect(dno.connect(bob).acceptDuel(duelId, b)).to.emit(dno, "DuelAccepted").withArgs(duelId, b, bob.address);
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
          expect([info.duelStatus, info.tokenIdB, info.accepter]).to.deep.eq([DUEL.Resolved, BigInt(b), bob.address]);
        }
      }
      for (const id of [...A, ...B]) {
        expect(await dno.status(id)).to.eq(0);
        await expectDenied(fhevm.publicDecrypt([await dno.seedHandle(id)]));
      }
    });

    it("only goes on the shelf once the challenger is proven to hold the box", async function () {
      // Carol posts a box she does not hold: the proof says no, and nobody can accept.
      await dno.connect(carol).postDuel(A[0]!, 0, false);
      await expect(dno.connect(bob).acceptDuel(0, B[0]!)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");
      const clear = await fhevm.publicDecrypt([...(await dno.duelHandles(0))]);
      expect(Object.values(clear.clearValues)).to.deep.eq([false]);
      await expect(finalizeDuel(dno, 0, bob)).to.emit(dno, "DuelVoided").withArgs(0);
      expect((await dno.duelInfo(0)).duelStatus).to.eq(DUEL.Void);
      await expect(dno.connect(bob).acceptDuel(0, B[0]!)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");

      // Alice posts her own: open for a week.
      await dno.connect(alice).postDuel(A[0]!, 0, false);
      await expect(finalizeDuel(dno, 1, bob)).to.emit(dno, "DuelOpened");
      const info = await dno.duelInfo(1);
      expect(info.duelStatus).to.eq(DUEL.Open);
      expect(info.openUntil).to.eq(BigInt(await time.latest()) + (await dno.DUEL_LIFETIME()));
      expect(await dno.DUEL_LIFETIME()).to.eq(BigInt(Number(spec.mechanics.duel!.lifetimeDays) * 86_400));
    });

    it("goes back on the shelf when the accepter brought a box they do not hold, showing nothing", async function () {
      const duelId = await postDuel(dno, A[0]!, alice, carol);
      await dno.connect(carol).acceptDuel(duelId, B[0]!);
      const clear = await fhevm.publicDecrypt([...(await dno.duelHandles(duelId))]);
      expect(Object.values(clear.clearValues).map((v) => BigInt(v as bigint | boolean))).to.deep.eq([1n, 0n, 0n, 0n, 0n]);
      await expect(finalizeDuel(dno, duelId, carol)).to.emit(dno, "DuelReopened").withArgs(duelId);
      const info = await dno.duelInfo(duelId);
      expect([info.duelStatus, info.tokenIdB, info.accepter]).to.deep.eq([DUEL.Open, 0n, ethers.ZeroAddress]);
      expect((await dno.publicTraitsOf(B[0]!))[0]).to.eq(0);

      // The real holder can still take it up.
      await dno.connect(bob).acceptDuel(duelId, B[0]!);
      await expect(finalizeDuel(dno, duelId, carol)).to.emit(dno, "DuelResolved");
    });

    it("is void, and says nothing of the accepter, when the challenger gave the box away", async function () {
      const duelId = await postDuel(dno, A[1]!, alice, carol);
      await (await dno.connect(alice).confidentialTransfer(carol.address, A[1]!)).wait();
      await dno.connect(bob).acceptDuel(duelId, B[1]!);
      const clear = await fhevm.publicDecrypt([...(await dno.duelHandles(duelId))]);
      expect(Object.values(clear.clearValues).map((v) => BigInt(v as bigint | boolean))).to.deep.eq([0n, 0n, 0n, 0n, 0n]);
      await expect(finalizeDuel(dno, duelId, carol)).to.emit(dno, "DuelVoided").withArgs(duelId);
      expect((await dno.duelInfo(duelId)).duelStatus).to.eq(DUEL.Void);
    });

    it("lets only the named box accept a reserved duel", async function () {
      await expect(dno.connect(alice).postDuel(A[0]!, A[0]!, true)).to.be.revertedWithCustomError(dno, "SameBox");
      const duelId = await postDuel(dno, A[0]!, alice, carol, B[1]!);
      const info = await dno.duelInfo(duelId);
      expect([info.reserved, info.tokenIdB]).to.deep.eq([true, BigInt(B[1]!)]);
      await expect(dno.connect(bob).acceptDuel(duelId, B[0]!)).to.be.revertedWithCustomError(dno, "NotThisBox");
      await dno.connect(bob).acceptDuel(duelId, B[1]!);
      await expect(finalizeDuel(dno, duelId, carol)).to.emit(dno, "DuelResolved");
    });

    it("keeps one listing per box, and refuses its own box, opened boxes and late takers", async function () {
      const first = await postDuel(dno, A[0]!, alice, carol);
      await expect(dno.connect(alice).acceptDuel(first, A[0]!)).to.be.revertedWithCustomError(dno, "SameBox");
      // Posting the same box again replaces the first listing.
      const second = await dno.duelCount();
      await dno.connect(alice).postDuel(A[0]!, 0, false);
      await expect(finalizeDuel(dno, second, carol)).to.emit(dno, "DuelCancelled").withArgs(first);
      expect((await dno.duelInfo(first)).duelStatus).to.eq(DUEL.Cancelled);

      await time.increase(Number(await dno.DUEL_LIFETIME()) + 1);
      await expect(dno.connect(bob).acceptDuel(second, B[0]!)).to.be.revertedWithCustomError(dno, "DuelExpired");

      const third = await postDuel(dno, A[1]!, alice, carol);
      await open(dno, B[1]!, bob, carol);
      await expect(dno.connect(bob).acceptDuel(third, B[1]!)).to.be.revertedWithCustomError(dno, "NotSealed");
      await open(dno, A[1]!, alice, carol);
      await expect(dno.connect(bob).acceptDuel(third, B[2]!)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("can be cancelled by the challenger until accepted", async function () {
      await dno.connect(alice).postDuel(A[0]!, 0, false);
      await expect(dno.connect(bob).cancelDuel(0)).to.be.revertedWithCustomError(dno, "NotChallenger");
      await expect(dno.connect(alice).cancelDuel(0)).to.emit(dno, "DuelCancelled").withArgs(0);
      await expect(finalizeDuel(dno, 0, carol)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");

      const duelId = await postDuel(dno, A[0]!, alice, carol);
      await expect(dno.connect(alice).cancelDuel(duelId)).to.emit(dno, "DuelCancelled").withArgs(duelId);
      await expect(dno.connect(bob).acceptDuel(duelId, B[0]!)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");
      // Accepted duels can no longer be withdrawn.
      const third = await postDuel(dno, A[1]!, alice, carol);
      await dno.connect(bob).acceptDuel(third, B[1]!);
      await expect(dno.connect(alice).cancelDuel(third)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");
    });

    it("rejects a forged outcome and double finalisation", async function () {
      const duelId = await postDuel(dno, A[0]!, alice, carol);
      await dno.connect(bob).acceptDuel(duelId, B[0]!);
      const real = await fhevm.publicDecrypt([...(await dno.duelHandles(duelId))]);
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const types = ["bool", "bool", "bool", "uint8", "uint8"];
      const [aHolds, valid, aWins, pick, roll] = coder.decode(types, real.abiEncodedClearValues);
      const flipped = coder.encode(types, [aHolds, valid, !aWins, pick, roll]);
      await expect(dno.finalizeDuel(duelId, flipped, real.decryptionProof)).to.be.reverted;
      await dno.finalizeDuel(duelId, real.abiEncodedClearValues, real.decryptionProof);
      await expect(dno.finalizeDuel(duelId, real.abiEncodedClearValues, real.decryptionProof)).to.be.revertedWithCustomError(dno, "WrongDuelStatus");
    });

    it("computes each box's encrypted score once, within the HCU budget", async function () {
      const first = await hcu(dno.connect(alice).postDuel(A[0]!, 0, false));
      expect(first.globalHCU).to.be.within(1_000_000, 1_500_000);
      await (await finalizeDuel(dno, 0, carol)).wait();
      const accept = await hcu(dno.connect(bob).acceptDuel(0, B[0]!));
      expect(accept.globalHCU).to.be.lessThan(3_600_000);
      expect(accept.maxHCUDepth).to.be.lessThan(5_000_000);
      expect((await hcu(dno.connect(alice).postDuel(A[0]!, 0, false))).globalHCU).to.be.lessThan(200_000);
    });
  });
});
