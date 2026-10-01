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
  FEES,
  finalizeObserve,
  giveCroquettes,
  peek64,
  peekSeed,
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

  async function open(tokenId: number) {
    const holder = await ethers.getSigner(await dno.ownerOf(tokenId));
    await (await dno.connect(holder).observe(tokenId)).wait();
    await (await finalizeObserve(dno, tokenId, carol)).wait();
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
    // Boxes 0-2 belong to alice, 3-5 to bob.
    await dno.connect(alice).mint(3);
    await dno.connect(bob).mint(3);
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
    it("pays one welcome bag per box on its first claim", async function () {
      await expect(pantry.connect(alice).claim([0, 1, 2]))
        .to.emit(pantry, "WelcomeBag")
        .withArgs(0, alice.address)
        .and.not.to.emit(pantry, "Purred");
      expect(await balanceOf(cCroq, alice)).to.eq(3n * WELCOME);
      expect(await reserve()).to.eq(FUNDED - 3n * WELCOME);
    });

    it("pays the bag to the box, not the wallet: a box that changes hands gets no second bag", async function () {
      await (await pantry.connect(alice).claim([0])).wait();
      await (await dno.connect(alice).transferFrom(alice.address, carol.address, 0)).wait();
      await expect(pantry.connect(carol).claim([0])).to.be.revertedWithCustomError(pantry, "NothingToClaim");
      expect(await balanceOf(cCroq, carol)).to.eq(0n);
    });

    it("purrs a hidden 0 to max per day, then nothing until the next whole day", async function () {
      await (await pantry.connect(alice).claim([0, 1, 2])).wait();
      await expect(pantry.connect(alice).claim([0])).to.be.revertedWithCustomError(pantry, "NothingToClaim");

      const draws = new Set<bigint>();
      let before = await balanceOf(cCroq, alice);
      for (let day = 0; day < 8; day++) {
        await time.increase(DAY);
        await expect(pantry.connect(alice).claim([0, 1, 2])).to.emit(pantry, "Purred").withArgs(alice.address, 3);
        const now = await balanceOf(cCroq, alice);
        expect(now - before).to.be.within(0n, 3n * MAX_DAY);
        draws.add(now - before);
        before = now;
      }
      // Eight identical sums of three draws would be a remarkable coincidence.
      expect(draws.size).to.be.greaterThan(1);
    });

    it("keeps each claim private: only the claimer reads what arrived", async function () {
      await (await pantry.connect(alice).claim([0])).wait();
      const handle = await cCroq.confidentialBalanceOf(alice.address);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, cCroqAddress, bob));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, await pantry.reserveHandle(), pantryAddress, deployer));
    });

    it("pays for the days owed, up to the cap, and keeps a started day", async function () {
      await (await pantry.connect(alice).claim([0])).wait();
      const first = await pantry.lastPurr(0);

      await time.increase(2 * DAY + 3600);
      let before = await balanceOf(cCroq, alice);
      await (await pantry.connect(alice).claim([0])).wait();
      expect((await balanceOf(cCroq, alice)) - before).to.be.within(0n, 2n * MAX_DAY);
      expect(await pantry.lastPurr(0)).to.eq(first + BigInt(2 * DAY));
      expect(await pantry.nextClaimAt(0)).to.eq(first + BigInt(3 * DAY));

      await time.increase(30 * DAY);
      before = await balanceOf(cCroq, alice);
      await (await pantry.connect(alice).claim([0])).wait();
      expect((await balanceOf(cCroq, alice)) - before).to.be.within(0n, BigInt(params.purrMaxDays) * MAX_DAY);
      expect(await pantry.lastPurr(0)).to.eq(BigInt(await time.latest()));
    });

    it("doubles the purr of Vet Certified boxes", async function () {
      // Find an alive box among alice's and certify it.
      let alive = -1;
      for (let id = 0; id < 3 && alive === -1; id++) if (stateOfSeed(await peekSeed(dno, id)) === STATE_IDS.alive) alive = id;
      while (alive === -1) {
        const first = Number(await dno.totalMinted());
        await (await dno.connect(alice).mint(5)).wait();
        for (let id = first; id < first + 5 && alive === -1; id++) if (stateOfSeed(await peekSeed(dno, id)) === 0) alive = id;
      }
      await (await dno.connect(alice).proveAlive(alive)).wait();
      const result = await fhevm.publicDecrypt([await dno.aliveHandle(alive)]);
      await (await dno.finalizeProveAlive(alive, result.abiEncodedClearValues, result.decryptionProof)).wait();
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

    it("halves the purr every period, and stops the FHE work once it rounds to zero", async function () {
      await (await pantry.connect(alice).claim([0])).wait();
      await time.increase(params.halvingPeriod);
      expect(await pantry.halvings()).to.eq(1n);
      for (let i = 0; i < 4; i++) {
        const before = await balanceOf(cCroq, alice);
        await (await pantry.connect(alice).claim([0])).wait();
        expect((await balanceOf(cCroq, alice)) - before).to.be.within(0n, MAX_DAY * BigInt(params.purrMaxDays) / 2n);
        await time.increase(DAY);
      }

      // Max purr 4 x 7 days = 28 < 2^5: after five halvings nothing is left.
      await time.increase(4 * params.halvingPeriod);
      expect(await pantry.halvings()).to.eq(5n);
      const before = await balanceOf(cCroq, alice);
      const used = await hcu(pantry.connect(alice).claim([0]));
      expect(await balanceOf(cCroq, alice)).to.eq(before);
      expect(used.globalHCU).to.eq(0);
    });

    it("never pays more than the reserve holds", async function () {
      const poor = await deployEconomy(dno, {}, 150n);
      await (await poor.pantry.connect(alice).claim([0])).wait();
      await (await poor.pantry.connect(bob).claim([3])).wait();
      expect(await balanceOf(poor.cCroq, alice)).to.eq(100n);
      expect(await balanceOf(poor.cCroq, bob)).to.eq(50n);
      expect(await peek64(await poor.pantry.reserveHandle())).to.eq(0n);

      await time.increase(3 * DAY);
      await (await poor.pantry.connect(alice).claim([0])).wait();
      expect(await balanceOf(poor.cCroq, alice)).to.eq(100n);
    });

    it("checks holders and the box count", async function () {
      await expect(pantry.connect(bob).claim([0])).to.be.revertedWithCustomError(pantry, "NotHolder");
      await expect(pantry.connect(alice).claim([])).to.be.revertedWithCustomError(pantry, "InvalidBoxCount");
      const tooMany = Array.from({ length: params.maxBoxesPerClaim + 1 }, () => 0);
      await expect(pantry.connect(alice).claim(tooMany)).to.be.revertedWithCustomError(pantry, "InvalidBoxCount");
      await expect(pantry.connect(alice).claim([99])).to.be.revertedWithCustomError(dno, "ERC721NonexistentToken");
    });

    it("stays within the HCU budget for a full claim", async function () {
      const ids = Array.from({ length: params.maxBoxesPerClaim }, (_, i) => i);
      const first = Number(await dno.totalMinted());
      for (let minted = first; minted < params.maxBoxesPerClaim; minted += 10) {
        await (await dno.connect(carol).mint(10)).wait();
      }
      for (const id of ids) {
        const owner = await ethers.getSigner(await dno.ownerOf(id));
        if (owner.address !== carol.address) await (await dno.connect(owner).transferFrom(owner.address, carol.address, id)).wait();
      }
      await (await pantry.connect(carol).claim(ids)).wait();
      await time.increase(DAY);
      const used = await hcu(pantry.connect(carol).claim(ids));
      // Protocol limits: 20M HCU per transaction, 5M along the longest dependency chain.
      expect(used.globalHCU).to.be.lessThan(7_500_000);
      expect(used.maxHCUDepth).to.be.lessThan(3_000_000);
    });
  });

  describe("feed", function () {
    beforeEach(async function () {
      await giveCroquettes(croq, cCroq, alice, 5_000n);
      await approvePantry(alice);
    });

    it("lets only the holder feed a sealed cat", async function () {
      await giveCroquettes(croq, cCroq, carol, 100n);
      await approvePantry(carol);
      await expect(feed(carol, 0, 10n)).to.be.revertedWithCustomError(pantry, "NotHolder");
      await expect(feed(alice, 99, 10n)).to.be.revertedWithCustomError(dno, "ERC721NonexistentToken");
      await (await dno.connect(alice).observe(0)).wait();
      await expect(feed(alice, 0, 10n)).to.be.revertedWithCustomError(pantry, "NotSealed");
    });

    it("eats it all: a fifth to the treasury, a fifth burnt, the rest back to the reserve", async function () {
      await expect(feed(alice, 0, 500n)).to.emit(pantry, "MealServed").withArgs(0, alice.address, 1);
      expect(await weight(0)).to.eq(500n);
      expect(await treasuryShare()).to.eq(100n);
      expect(await burnt()).to.eq(100n);
      expect(await reserve()).to.eq(FUNDED + 300n);
      expect(await balanceOf(cCroq, alice)).to.eq(4_500n);
    });

    it("serves two meals a day, then none until the next UTC day", async function () {
      await (await feed(alice, 0, 10n)).wait();
      await (await feed(alice, 0, 10n)).wait();
      expect(await pantry.mealsToday(0)).to.eq(2);
      await expect(feed(alice, 0, 10n)).to.be.revertedWithCustomError(pantry, "NoMoreMealsToday");
      // The limit is the cat's, not the wallet's, nor the day of the week.
      await (await feed(alice, 1, 10n)).wait();
      await time.increase(DAY);
      expect(await pantry.mealsToday(0)).to.eq(0);
      await (await feed(alice, 0, 10n)).wait();
      expect(await pantry.meals(0)).to.eq(3n);
      expect(await weight(0)).to.eq(30n);
    });

    it("caps what a cat eats at 1,000 a day, in one meal or spread, and cuts the rest silently", async function () {
      await (await feed(alice, 0, 700n)).wait();
      await expect(feed(alice, 0, 700n)).to.emit(pantry, "MealServed");
      expect(await weight(0)).to.eq(1_000n);
      expect(await balanceOf(cCroq, alice)).to.eq(4_000n);
      // The feeder can follow their own day, nobody else can.
      const today = await pantry.eatenTodayHandle(0);
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, today, pantryAddress, alice)).to.eq(1_000n);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, today, pantryAddress, bob));

      await time.increase(DAY);
      await (await feed(alice, 0, 2_500n)).wait();
      expect(await weight(0)).to.eq(2_000n);
      expect(await balanceOf(cCroq, alice)).to.eq(3_000n);
    });

    it("moves nothing, silently, when the feeder holds too little", async function () {
      await (await dno.connect(alice).transferFrom(alice.address, bob.address, 0)).wait();
      await giveCroquettes(croq, cCroq, bob, 50n);
      await approvePantry(bob);
      await expect(feed(bob, 0, 80n)).to.emit(pantry, "MealServed").withArgs(0, bob.address, 1);
      expect(await weight(0)).to.eq(0n);
      expect(await balanceOf(cCroq, bob)).to.eq(50n);
    });

    it("lets nobody read a weight: not the holder, not the public", async function () {
      await (await feed(alice, 0, 100n)).wait();
      const handle = await pantry.weightHandle(0);
      for (const who of [alice, bob, deployer]) {
        await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, pantryAddress, who));
      }
      await expectDenied(fhevm.publicDecrypt([handle]));
      await expectDenied(fhevm.publicDecrypt([await pantry.burntHandle()]));
    });

    it("requires the Pantry as operator and an amount made for the caller", async function () {
      await (await cCroq.connect(alice).setOperator(pantryAddress, 0)).wait();
      await expect(feed(alice, 0, 10n)).to.be.revertedWithCustomError(cCroq, "ERC7984UnauthorizedSpender");
      await approvePantry(alice);
      const input = await fhevm.createEncryptedInput(pantryAddress, bob.address).add64(10n).encrypt();
      await expect(pantry.connect(alice).feed(0, input.handles[0]!, input.inputProof)).to.be.reverted;
    });

    it("stays within the documented HCU budget", async function () {
      // The first meal of the day skips the subtraction from what was already eaten.
      expect((await hcu(feed(alice, 0, 50n))).globalHCU).to.be.lessThan(2_900_000);
      expect((await hcu(feed(alice, 0, 50n))).globalHCU).to.be.lessThan(3_300_000);
    });
  });

  describe("collect", function () {
    it("pays the treasury its share, which only the treasury can read", async function () {
      await expect(pantry.collect()).to.be.revertedWithCustomError(pantry, "NothingToCollect");
      await giveCroquettes(croq, cCroq, alice, 1_000n);
      await approvePantry(alice);
      await (await feed(alice, 0, 1_000n)).wait();

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
      await (await feed(alice, 0, 777n)).wait();
      await (await feed(alice, 1, 333n)).wait();
      await (await pantry.connect(alice).claim([0, 1, 2])).wait();
      await (await pantry.collect()).wait();
      await (await feed(alice, 2, 1_001n)).wait();
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
      await open(0);
      expect((await hcu(pantry.weigh(0))).globalHCU).to.eq(0);
      const w = await pantry.weighIn(0);
      expect([w.status, w.build, w.sick, w.weight]).to.deep.eq([2n, 0n, false, 0n]);
    });

    it("weighs once, only after the reveal is final", async function () {
      await expect(pantry.weigh(0)).to.be.revertedWithCustomError(pantry, "NotRevealed");
      await (await dno.connect(alice).observe(0)).wait();
      await expect(pantry.weigh(0)).to.be.revertedWithCustomError(pantry, "NotRevealed");
      await (await finalizeObserve(dno, 0, carol)).wait();
      await (await pantry.weigh(0)).wait();
      await expect(pantry.weigh(0)).to.be.revertedWithCustomError(pantry, "AlreadyWeighed");
      await expect(pantry.finalizeWeigh(1, "0x", "0x")).to.be.revertedWithCustomError(pantry, "WeighInNotPending");
    });

    it("publishes the weight, and the build it reaches", async function () {
      const cases: [number, bigint, bigint][] = [
        [0, 99n, 1n],
        [1, 300n, 3n],
        [2, 999n, 4n],
      ];
      for (const [id, amount] of cases) await (await feed(alice, id, amount)).wait();
      for (const [id, amount, build] of cases) {
        const w = await weighed(id);
        expect([w.weight, w.build, w.sick], `box ${id}`).to.deep.eq([amount, build, false]);
        expect(w.tolerance).to.eq((await toleranceOf(id)).tolerance);
      }
      expect(await pantry.buildOf(100)).to.eq(2);
    });

    it("makes a cat sick past a tolerance of its own, drawn from its seed", async function () {
      const { tolerance, roll } = await toleranceOf(0);
      // Two full days put it past any tolerance in [1000, 1500).
      await (await feed(alice, 0, 1_000n)).wait();
      await time.increase(DAY);
      await (await feed(alice, 0, 1_000n)).wait();
      await open(0);
      await expect(pantry.weigh(0)).to.emit(pantry, "WeighInRequested");
      const result = await fhevm.publicDecrypt([await pantry.weightHandle(0)]);
      const disease = roll < params.diseaseRollBelow[0] ? 0 : roll < params.diseaseRollBelow[1] ? 1 : 2;
      await expect(pantry.finalizeWeigh(0, result.abiEncodedClearValues, result.decryptionProof))
        .to.emit(pantry, "Weighed")
        .withArgs(0, 2_000n, 4, true, disease);
      expect((await pantry.weighIn(0)).tolerance).to.eq(tolerance);

      // Just under its own tolerance, a cat stays huge and well.
      await (await feed(alice, 1, 999n)).wait();
      const w = await weighed(1);
      expect([w.weight, w.build, w.sick]).to.deep.eq([999n, 4n, false]);
    });

    it("rejects a forged weight", async function () {
      await (await feed(alice, 0, 500n)).wait();
      await open(0);
      await (await pantry.weigh(0)).wait();
      const result = await fhevm.publicDecrypt([await pantry.weightHandle(0)]);
      const forged = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [400_000n]);
      await expect(pantry.finalizeWeigh(0, forged, result.decryptionProof)).to.be.reverted;
    });
  });
});
