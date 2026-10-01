import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { economyFromSpec, pantryParamsFromSpec } from "../lib/specParams";
import { ConfidentialCroq, Croq, DoNotOpen, Pantry } from "../types";
import {
  balanceOf,
  deploy,
  deployEconomy,
  expectDenied,
  giveCroquettes,
  mintBoxes,
  open as openBox,
  peek64,
  peekSeed,
  proveAlive,
  STATE_IDS,
} from "./helpers";

const DAY = 86_400;
const params = pantryParamsFromSpec();
const { totalSupply, allocation } = economyFromSpec();
const FUNDED = allocation.gameReserve + allocation.welcomeBags;
const WELCOME = BigInt(params.welcomeBag);
const MAX_DAY = BigInt(params.purrMaxPerDay);

/** Equal odds for the four states, so a handful of boxes covers all of them. */
const EVEN_STATES = { stateRollBelow: [16384, 32768, 49152] as [number, number, number] };
const stateOfSeed = (seed: bigint) => {
  const roll = Number(seed & 0xffffn);
  return EVEN_STATES.stateRollBelow.findIndex((below) => roll < below) === -1
    ? 3
    : EVEN_STATES.stateRollBelow.findIndex((below) => roll < below);
};

describe("CROQ economy", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dno: DoNotOpen;
  let croq: Croq;
  let cCroq: ConfidentialCroq;
  let pantry: Pantry;
  let pantryAddress: string;
  let cCroqAddress: string;
  /** Alice holds A[0..2], bob holds B[0..2]. */
  let A: number[];
  let B: number[];

  const hcu = async (tx: Promise<{ wait(): Promise<unknown> }>) =>
    fhevm.computeTransactionHCU((await (await tx).wait()) as Parameters<typeof fhevm.computeTransactionHCU>[0]);

  /** Encrypts `amount` for the Pantry and serves it to `tokenId`. */
  async function feed(who: HardhatEthersSigner, tokenId: number, amount: bigint) {
    const input = await fhevm.createEncryptedInput(pantryAddress, who.address).add64(amount).encrypt();
    return pantry.connect(who).feed(tokenId, input.handles[0]!, input.inputProof);
  }

  const weight = async (tokenId: number) => peek64(await pantry.weightHandle(tokenId));
  const treasuryShare = async () => peek64(await pantry.treasuryShareHandle());
  const burnt = async () => peek64(await pantry.burntHandle());
  const reserve = async () => peek64(await pantry.reserveHandle());
  const approvePantry = async (who: HardhatEthersSigner) =>
    (await cCroq.connect(who).setOperator(pantryAddress, (await time.latest()) + 365 * DAY)).wait();

  /** Opens a box of alice's (or of `holder`). */
  const open = (tokenId: number, holder: HardhatEthersSigner = alice) => openBox(dno, tokenId, holder, carol);
  /** What `who` may read about `tokenId` today: meals and croquettes eaten. */
  async function today(tokenId: number, who: HardhatEthersSigner) {
    const [meals, eaten] = await pantry.todayHandles(tokenId, who.address);
    if (meals === ethers.ZeroHash) return { meals: 0n, eaten: 0n };
    return {
      meals: await fhevm.userDecryptEuint(FhevmType.euint8, meals, pantryAddress, who),
      eaten: await fhevm.userDecryptEuint(FhevmType.euint64, eaten, pantryAddress, who),
    };
  }

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
    ({ dno } = await deploy(EVEN_STATES));
    ({ croq, cCroq, pantry, pantryAddress, cCroqAddress } = await deployEconomy(dno));
    A = (await mintBoxes(dno, alice, 3)).owned;
    B = (await mintBoxes(dno, bob, 3)).owned;
  });

  describe("CROQ and cCROQ", function () {
    it("mints the whole fixed supply once, with no decimals and no way to mint more", async function () {
      expect(await croq.totalSupply()).to.eq(totalSupply);
      expect(await croq.decimals()).to.eq(0n);
      expect(await croq.symbol()).to.eq("CROQ");
      expect(await croq.balanceOf(deployer.address)).to.eq(totalSupply - FUNDED);
      const functions = croq.interface.fragments.filter((f) => f.type === "function").map((f) => (f as unknown as { name: string }).name);
      expect(functions.some((name) => /mint/i.test(name))).to.eq(false);
    });

    it("wraps 1:1 into a balance only its holder can read", async function () {
      expect(await cCroq.decimals()).to.eq(0n);
      expect(await cCroq.rate()).to.eq(1n);
      expect(await cCroq.symbol()).to.eq("cCROQ");
      await giveCroquettes(croq, cCroq, alice, 250n);
      expect(await balanceOf(cCroq, alice)).to.eq(250n);
      const handle = await cCroq.confidentialBalanceOf(alice.address);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, cCroqAddress, bob));
      await expectDenied(fhevm.publicDecrypt([handle]));
    });

    it("moves hidden amounts between players and unwraps back to plain CROQ", async function () {
      await giveCroquettes(croq, cCroq, alice, 300n);
      const sent = await fhevm.createEncryptedInput(cCroqAddress, alice.address).add64(120n).encrypt();
      await (await cCroq.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](bob.address, sent.handles[0]!, sent.inputProof)).wait();
      expect(await balanceOf(cCroq, alice)).to.eq(180n);
      expect(await balanceOf(cCroq, bob)).to.eq(120n);

      const out = await fhevm.createEncryptedInput(cCroqAddress, bob.address).add64(70n).encrypt();
      const receipt = await (
        await cCroq.connect(bob)["unwrap(address,address,bytes32,bytes)"](bob.address, bob.address, out.handles[0]!, out.inputProof)
      ).wait();
      const requested = cCroq.interface.parseLog(receipt!.logs.find((l) => l.address === cCroqAddress && cCroq.interface.parseLog(l)?.name === "UnwrapRequested")!)!;
      const requestId = requested.args[1] as string;
      const result = await fhevm.publicDecrypt([requestId]);
      await (await cCroq.finalizeUnwrap(requestId, 70n, result.decryptionProof)).wait();
      expect(await croq.balanceOf(bob.address)).to.eq(70n);
      expect(await balanceOf(cCroq, bob)).to.eq(50n);
    });
  });

  describe("fund", function () {
    it("wraps the funded CROQ into the Pantry's reserve", async function () {
      expect(await cCroq.inferredTotalSupply()).to.eq(FUNDED);
      expect(await reserve()).to.eq(FUNDED);
      expect(await peek64(await cCroq.confidentialBalanceOf(pantryAddress))).to.eq(FUNDED);

      await (await croq.approve(pantryAddress, 500n)).wait();
      await expect(pantry.fund(500n)).to.emit(pantry, "Funded").withArgs(deployer.address, 500n);
      expect(await reserve()).to.eq(FUNDED + 500n);
    });

    it("rejects parameters that would break the accounting", async function () {
      const factory = await ethers.getContractFactory("Pantry");
      const bad = [
        { mealBurnBps: 8_001 },
        { mealsPerDay: 0 },
        { maxEatenPerDay: 0 },
        { buildFloors: [0, 10, 20, 30] as [number, number, number, number] },
        { buildFloors: [1, 10, 10, 30] as [number, number, number, number] },
        { sickMinWeight: 150_000 },
        { sickWeightSpread: 0 },
        { diseaseRollBelow: [40_000, 40_000] as [number, number] },
        { purrMaxDays: 0 },
        { halvingPeriod: 0 },
        { vetMultiplier: 0 },
        { maxBoxesPerClaim: 0 },
        { purrMaxPerDay: 255 },
      ];
      for (const override of bad) {
        await expect(
          factory.deploy(await dno.getAddress(), cCroqAddress, deployer.address, pantryParamsFromSpec(override)),
        ).to.be.revertedWithCustomError(
          pantry,
          "InvalidParams",
        );
      }
    });
  });

  describe("claim", function () {
    it("pays one welcome bag per box into the box, and the boxes' holder takes it", async function () {
      await expect(pantry.connect(alice).claim(A))
        .to.emit(pantry, "WelcomeBag")
        .withArgs(A[0])
        .and.not.to.emit(pantry, "Purred");
      expect(await balanceOf(cCroq, alice)).to.eq(3n * WELCOME);
      expect(await reserve()).to.eq(FUNDED - 3n * WELCOME);
    });

    it("keeps a box's bag in the box when a stranger asks for it", async function () {
      await (await pantry.connect(carol).claim([A[0]!])).wait();
      expect(await balanceOf(cCroq, carol)).to.eq(0n);
      expect(await peek64(await pantry.stashHandle(A[0]!))).to.eq(WELCOME);
      await (await pantry.connect(alice).claim([A[0]!])).wait();
      expect(await balanceOf(cCroq, alice)).to.eq(WELCOME);
      expect(await peek64(await pantry.stashHandle(A[0]!))).to.eq(0n);
    });

    it("pays the bag to the box, not the wallet: a box that changes hands gets no second bag", async function () {
      await (await pantry.connect(alice).claim([A[0]!])).wait();
      await (await dno.connect(alice).confidentialTransfer(carol.address, A[0]!)).wait();
      await (await pantry.connect(carol).claim([A[0]!])).wait();
      expect(await balanceOf(cCroq, carol)).to.eq(0n);
    });

    it("purrs a hidden 0 to max per day, then nothing until the next whole day", async function () {
      await (await pantry.connect(alice).claim(A)).wait();
      let before = await balanceOf(cCroq, alice);
      await (await pantry.connect(alice).claim([A[0]!])).wait();
      expect(await balanceOf(cCroq, alice)).to.eq(before);

      const draws = new Set<bigint>();
      for (let day = 0; day < 8; day++) {
        await time.increase(DAY);
        await expect(pantry.connect(alice).claim(A)).to.emit(pantry, "Purred").withArgs(A[0], 1);
        const now = await balanceOf(cCroq, alice);
        expect(now - before).to.be.within(0n, 3n * MAX_DAY);
        draws.add(now - before);
        before = now;
      }
      expect(draws.size).to.be.greaterThan(1);
    });

    it("keeps each claim private: only the claimer reads what arrived", async function () {
      await (await pantry.connect(alice).claim([A[0]!])).wait();
      const handle = await cCroq.confidentialBalanceOf(alice.address);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, cCroqAddress, bob));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, await pantry.reserveHandle(), pantryAddress, deployer));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, await pantry.stashHandle(A[0]!), pantryAddress, alice));
    });

    it("pays for the days owed, up to the cap, and keeps a started day", async function () {
      await (await pantry.connect(alice).claim([A[0]!])).wait();
      const first = await pantry.lastPurr(A[0]!);

      await time.increase(2 * DAY + 3600);
      let before = await balanceOf(cCroq, alice);
      await (await pantry.connect(alice).claim([A[0]!])).wait();
      expect((await balanceOf(cCroq, alice)) - before).to.be.within(0n, 2n * MAX_DAY);
      expect(await pantry.lastPurr(A[0]!)).to.eq(first + BigInt(2 * DAY));
      expect(await pantry.nextClaimAt(A[0]!)).to.eq(first + BigInt(3 * DAY));

      await time.increase(30 * DAY);
      before = await balanceOf(cCroq, alice);
      await (await pantry.connect(alice).claim([A[0]!])).wait();
      expect((await balanceOf(cCroq, alice)) - before).to.be.within(0n, BigInt(params.purrMaxDays) * MAX_DAY);
      expect(await pantry.lastPurr(A[0]!)).to.eq(BigInt(await time.latest()));
    });

    it("doubles the purr of Vet Certified boxes", async function () {
      let alive = -1;
      const mine = [...A];
      for (const id of mine) if (alive === -1 && stateOfSeed(await peekSeed(dno, id)) === STATE_IDS.alive) alive = id;
      while (alive === -1) {
        const { owned } = await mintBoxes(dno, alice, 5);
        for (const id of owned) if (alive === -1 && stateOfSeed(await peekSeed(dno, id)) === STATE_IDS.alive) alive = id;
      }
      await proveAlive(dno, alive, alice, carol);
      expect(await dno.vetCertified(alive)).to.eq(true);

      await (await pantry.connect(alice).claim([alive])).wait();
      const values = new Set<bigint>();
      for (let i = 0; i < 6; i++) {
        await time.increase(DAY);
        const before = await balanceOf(cCroq, alice);
        await (await pantry.connect(alice).claim([alive])).wait();
        const got = (await balanceOf(cCroq, alice)) - before;
        expect(got % BigInt(params.vetMultiplier)).to.eq(0n);
        expect(got).to.be.within(0n, MAX_DAY * BigInt(params.vetMultiplier));
        values.add(got);
      }
      expect(values.size).to.be.greaterThan(1);
    });

    it("halves the purr every period, and skips the draw once it rounds to zero", async function () {
      await (await pantry.connect(alice).claim([A[0]!])).wait();
      await time.increase(params.halvingPeriod);
      expect(await pantry.halvings()).to.eq(1n);
      for (let i = 0; i < 4; i++) {
        const before = await balanceOf(cCroq, alice);
        await (await pantry.connect(alice).claim([A[0]!])).wait();
        expect((await balanceOf(cCroq, alice)) - before).to.be.within(0n, (MAX_DAY * BigInt(params.purrMaxDays)) / 2n);
        await time.increase(DAY);
      }

      // Max purr 4 x 7 days = 28 < 2^5: after five halvings nothing is left to draw.
      await time.increase(4 * params.halvingPeriod);
      expect(await pantry.halvings()).to.eq(5n);
      const before = await balanceOf(cCroq, alice);
      const used = await hcu(pantry.connect(alice).claim([A[0]!]));
      expect(await balanceOf(cCroq, alice)).to.eq(before);
      // Only the holder check and the payout are left.
      expect(used.globalHCU).to.be.lessThan(1_200_000);
    });

    it("never pays more than the reserve holds", async function () {
      const poor = await deployEconomy(dno, {}, WELCOME + 50n);
      await (await poor.pantry.connect(alice).claim([A[0]!])).wait();
      // 50 left: not enough for a whole bag, so nothing, and the reserve keeps it.
      await (await poor.pantry.connect(bob).claim([B[0]!])).wait();
      expect(await balanceOf(poor.cCroq, alice)).to.eq(WELCOME);
      expect(await balanceOf(poor.cCroq, bob)).to.eq(0n);
      expect(await peek64(await poor.pantry.reserveHandle())).to.eq(50n);

      // Purrs are small enough to be paid from what is left, and never more.
      await time.increase(3 * DAY);
      await (await poor.pantry.connect(alice).claim([A[0]!])).wait();
      const purred = (await balanceOf(poor.cCroq, alice)) - WELCOME;
      expect(purred).to.be.within(0n, 3n * MAX_DAY);
      expect(await peek64(await poor.pantry.reserveHandle())).to.eq(50n - purred);
    });

    it("checks the box count and that the boxes exist", async function () {
      await expect(pantry.connect(alice).claim([])).to.be.revertedWithCustomError(pantry, "InvalidBoxCount");
      const tooMany = Array.from({ length: params.maxBoxesPerClaim + 1 }, () => A[0]!);
      await expect(pantry.connect(alice).claim(tooMany)).to.be.revertedWithCustomError(pantry, "InvalidBoxCount");
      await expect(pantry.connect(alice).claim([9999])).to.be.revertedWithCustomError(dno, "ConfidentialERC721NonexistentToken");
    });

    it("refuses to read ownership unless the collection trusts the Pantry", async function () {
      await (await dno.connect(deployer).setTrustedReader(pantryAddress, false)).wait();
      await expect(pantry.connect(alice).claim([A[0]!])).to.be.revertedWithCustomError(dno, "ConfidentialERC721UnauthorizedReader");
    });

    it("stays within the HCU budget for a full claim", async function () {
      const { owned } = await mintBoxes(dno, carol, params.maxBoxesPerClaim);
      await (await pantry.connect(carol).claim(owned)).wait();
      await time.increase(DAY);
      const used = await hcu(pantry.connect(carol).claim(owned));
      // Protocol limits: 20M HCU per transaction, 5M along the longest dependency chain.
      expect(used.globalHCU).to.be.lessThan(14_000_000);
      expect(used.maxHCUDepth).to.be.lessThan(5_000_000);
      expect(await balanceOf(cCroq, carol)).to.be.greaterThanOrEqual(BigInt(params.maxBoxesPerClaim) * WELCOME);
    });
  });

  describe("feed", function () {
    beforeEach(async function () {
      await giveCroquettes(croq, cCroq, alice, 5_000n);
      await approvePantry(alice);
    });

    it("serves nothing, silently, to someone who does not hold the cat", async function () {
      await giveCroquettes(croq, cCroq, carol, 100n);
      await approvePantry(carol);
      await expect(feed(carol, A[0]!, 10n)).to.emit(pantry, "MealServed").withArgs(A[0], carol.address);
      expect(await weight(A[0]!)).to.eq(0n);
      expect(await balanceOf(cCroq, carol)).to.eq(100n);
      // What the stranger may read back says nothing either.
      expect(await today(A[0]!, carol)).to.deep.eq({ meals: 0n, eaten: 0n });
      await expect(feed(alice, 9999, 10n)).to.be.revertedWithCustomError(dno, "ConfidentialERC721NonexistentToken");
      await open(A[0]!);
      await expect(feed(alice, A[0]!, 10n)).to.be.revertedWithCustomError(pantry, "NotSealed");
    });

    it("eats it all: a fifth to the treasury, a fifth burnt, the rest back to the reserve", async function () {
      await expect(feed(alice, A[0]!, 500n)).to.emit(pantry, "MealServed").withArgs(A[0], alice.address);
      expect(await weight(A[0]!)).to.eq(500n);
      expect(await treasuryShare()).to.eq(100n);
      expect(await burnt()).to.eq(100n);
      expect(await reserve()).to.eq(FUNDED + 300n);
      expect(await balanceOf(cCroq, alice)).to.eq(4_500n);
    });

    it("serves two meals a day, then nothing until the next UTC day", async function () {
      await (await feed(alice, A[0]!, 10n)).wait();
      await (await feed(alice, A[0]!, 10n)).wait();
      expect((await today(A[0]!, alice)).meals).to.eq(2n);
      // A third meal moves nothing, without reverting.
      await (await feed(alice, A[0]!, 10n)).wait();
      expect(await weight(A[0]!)).to.eq(20n);
      expect(await balanceOf(cCroq, alice)).to.eq(4_980n);
      // The limit is the cat's, not the wallet's.
      await (await feed(alice, A[1]!, 10n)).wait();
      await time.increase(DAY);
      expect(await today(A[0]!, alice)).to.deep.eq({ meals: 0n, eaten: 0n });
      await (await feed(alice, A[0]!, 10n)).wait();
      expect(await weight(A[0]!)).to.eq(30n);
    });

    it("caps what a cat eats at 1,000 a day, in one meal or spread, and cuts the rest silently", async function () {
      await (await feed(alice, A[0]!, 700n)).wait();
      await (await feed(alice, A[0]!, 700n)).wait();
      expect(await weight(A[0]!)).to.eq(1_000n);
      expect(await balanceOf(cCroq, alice)).to.eq(4_000n);
      // The feeder can follow their own day, nobody else can.
      expect((await today(A[0]!, alice)).eaten).to.eq(1_000n);
      const [, eaten] = await pantry.todayHandles(A[0]!, alice.address);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, eaten, pantryAddress, bob));

      await time.increase(DAY);
      await (await feed(alice, A[0]!, 2_500n)).wait();
      expect(await weight(A[0]!)).to.eq(2_000n);
      expect(await balanceOf(cCroq, alice)).to.eq(3_000n);
    });

    it("moves nothing, silently, when the feeder holds too little", async function () {
      await (await dno.connect(alice).confidentialTransfer(bob.address, A[0]!)).wait();
      await giveCroquettes(croq, cCroq, bob, 50n);
      await approvePantry(bob);
      await expect(feed(bob, A[0]!, 80n)).to.emit(pantry, "MealServed").withArgs(A[0], bob.address);
      expect(await weight(A[0]!)).to.eq(0n);
      expect(await balanceOf(cCroq, bob)).to.eq(50n);
    });

    it("lets nobody read a weight: not the holder, not the public", async function () {
      await (await feed(alice, A[0]!, 100n)).wait();
      const handle = await pantry.weightHandle(A[0]!);
      for (const who of [alice, bob, deployer]) {
        await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, pantryAddress, who));
      }
      await expectDenied(fhevm.publicDecrypt([handle]));
      await expectDenied(fhevm.publicDecrypt([await pantry.burntHandle()]));
    });

    it("requires the Pantry as operator and an amount made for the caller", async function () {
      await (await cCroq.connect(alice).setOperator(pantryAddress, 0)).wait();
      await expect(feed(alice, A[0]!, 10n)).to.be.revertedWithCustomError(cCroq, "ERC7984UnauthorizedSpender");
      await approvePantry(alice);
      const input = await fhevm.createEncryptedInput(pantryAddress, bob.address).add64(10n).encrypt();
      await expect(pantry.connect(alice).feed(A[0]!, input.handles[0]!, input.inputProof)).to.be.reverted;
    });

    it("stays within the HCU budget", async function () {
      expect((await hcu(feed(alice, A[0]!, 50n))).globalHCU).to.be.lessThan(4_500_000);
      const second = await hcu(feed(alice, A[0]!, 50n));
      expect(second.globalHCU).to.be.lessThan(4_500_000);
      expect(second.maxHCUDepth).to.be.lessThan(5_000_000);
    });
  });

  describe("collect", function () {
    it("pays the treasury its share, which only the treasury can read", async function () {
      await expect(pantry.collect()).to.be.revertedWithCustomError(pantry, "NothingToCollect");
      await giveCroquettes(croq, cCroq, alice, 1_000n);
      await approvePantry(alice);
      await (await feed(alice, A[0]!, 1_000n)).wait();

      const share = await pantry.treasuryShareHandle();
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, share, pantryAddress, deployer)).to.eq(200n);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, share, pantryAddress, alice));

      const before = await balanceOf(cCroq, deployer);
      await expect(pantry.connect(bob).collect()).to.emit(pantry, "Collected").withArgs(deployer.address);
      expect((await balanceOf(cCroq, deployer)) - before).to.eq(200n);
      expect(await treasuryShare()).to.eq(0n);
      expect((await hcu(pantry.collect())).globalHCU).to.be.lessThan(650_000);
      expect((await balanceOf(cCroq, deployer)) - before).to.eq(200n);
    });

    it("keeps the books: the Pantry's balance is always reserve + treasury share + burnt", async function () {
      await giveCroquettes(croq, cCroq, alice, 3_000n);
      await approvePantry(alice);
      await (await feed(alice, A[0]!, 777n)).wait();
      await (await feed(alice, A[1]!, 333n)).wait();
      await (await pantry.connect(alice).claim(A)).wait();
      await (await pantry.collect()).wait();
      await (await feed(alice, A[2]!, 1_001n)).wait();
      const held = await peek64(await cCroq.confidentialBalanceOf(pantryAddress));
      expect(held).to.eq((await reserve()) + (await treasuryShare()) + (await burnt()));
    });
  });

  describe("weigh", function () {
    /** Small builds so a test can cross them all in two days. */
    const SMALL = {
      buildFloors: [1, 100, 300, 600] as [number, number, number, number],
      sickMinWeight: 1_000,
      sickWeightSpread: 500,
    };

    beforeEach(async function () {
      ({ croq, cCroq, pantry, pantryAddress, cCroqAddress } = await deployEconomy(dno, SMALL));
      await giveCroquettes(croq, cCroq, alice, 5_000n);
      await approvePantry(alice);
    });

    const toleranceOf = async (id: number) => {
      const h = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [await peekSeed(dno, id)])));
      return { tolerance: BigInt(SMALL.sickMinWeight) + (h % BigInt(SMALL.sickWeightSpread)), roll: Number((h >> 128n) & 0xffffn) };
    };

    async function weighed(id: number) {
      await open(id);
      const tx = await pantry.connect(carol).weigh(id);
      await tx.wait();
      if ((await pantry.weighIn(id)).status === 1n) {
        const result = await fhevm.publicDecrypt([await pantry.weightHandle(id)]);
        await (await pantry.finalizeWeigh(id, result.abiEncodedClearValues, result.decryptionProof)).wait();
      }
      return pantry.weighIn(id);
    }

    it("weighs a cat that never ate on the spot, as thin", async function () {
      await open(A[0]!);
      expect((await hcu(pantry.weigh(A[0]!))).globalHCU).to.eq(0);
      const w = await pantry.weighIn(A[0]!);
      expect([w.status, w.build, w.sick, w.weight]).to.deep.eq([2n, 0n, false, 0n]);
    });

    it("weighs once, only after the reveal is final", async function () {
      await expect(pantry.weigh(A[0]!)).to.be.revertedWithCustomError(pantry, "NotRevealed");
      // A stranger's opening request settles to nothing: still not revealed.
      await open(A[0]!, carol);
      await expect(pantry.weigh(A[0]!)).to.be.revertedWithCustomError(pantry, "NotRevealed");
      await open(A[0]!);
      await (await pantry.weigh(A[0]!)).wait();
      await expect(pantry.weigh(A[0]!)).to.be.revertedWithCustomError(pantry, "AlreadyWeighed");
      await expect(pantry.finalizeWeigh(A[1]!, "0x", "0x")).to.be.revertedWithCustomError(pantry, "WeighInNotPending");
    });

    it("publishes the weight, and the build it reaches", async function () {
      const cases: [number, bigint, bigint][] = [
        [0, 99n, 1n],
        [1, 300n, 3n],
        [2, 999n, 4n],
      ];
      for (const [i, amount] of cases) await (await feed(alice, A[i]!, amount)).wait();
      for (const [i, amount, build] of cases) {
        const id = A[i]!;
        const w = await weighed(id);
        expect([w.weight, w.build, w.sick], `box ${id}`).to.deep.eq([amount, build, false]);
        expect(w.tolerance).to.eq((await toleranceOf(id)).tolerance);
      }
      expect(await pantry.buildOf(100)).to.eq(2);
    });

    it("makes a cat sick past a tolerance of its own, drawn from its seed", async function () {
      const { tolerance, roll } = await toleranceOf(A[0]!);
      // Two full days put it past any tolerance in [1000, 1500).
      await (await feed(alice, A[0]!, 1_000n)).wait();
      await time.increase(DAY);
      await (await feed(alice, A[0]!, 1_000n)).wait();
      await open(A[0]!);
      await expect(pantry.weigh(A[0]!)).to.emit(pantry, "WeighInRequested");
      const result = await fhevm.publicDecrypt([await pantry.weightHandle(A[0]!)]);
      const disease = roll < params.diseaseRollBelow[0] ? 0 : roll < params.diseaseRollBelow[1] ? 1 : 2;
      await expect(pantry.finalizeWeigh(A[0]!, result.abiEncodedClearValues, result.decryptionProof))
        .to.emit(pantry, "Weighed")
        .withArgs(A[0], 2_000n, 4, true, disease);
      expect((await pantry.weighIn(A[0]!)).tolerance).to.eq(tolerance);

      // Just under its own tolerance, a cat stays huge and well.
      await (await feed(alice, A[1]!, 999n)).wait();
      const w = await weighed(A[1]!);
      expect([w.weight, w.build, w.sick]).to.deep.eq([999n, 4n, false]);
    });

    it("rejects a forged weight", async function () {
      await (await feed(alice, A[0]!, 500n)).wait();
      await open(A[0]!);
      await (await pantry.weigh(A[0]!)).wait();
      const result = await fhevm.publicDecrypt([await pantry.weightHandle(A[0]!)]);
      const forged = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [400_000n]);
      await expect(pantry.finalizeWeigh(A[0]!, forged, result.decryptionProof)).to.be.reverted;
    });
  });
});
