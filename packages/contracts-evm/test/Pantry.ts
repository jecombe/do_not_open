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

  const stash = async (tokenId: number) => peek64(await pantry.stashHandle(tokenId));
  const burnt = async () => peek64(await pantry.burntHandle());
  const reserve = async () => peek64(await pantry.reserveHandle());
  const approvePantry = async (who: HardhatEthersSigner) =>
    (await cCroq.connect(who).setOperator(pantryAddress, (await time.latest()) + 365 * DAY)).wait();

  async function open(tokenId: number) {
    const holder = await ethers.getSigner(await dno.ownerOf(tokenId));
    await (await dno.connect(holder).observe(tokenId, { value: FEES.observe })).wait();
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
    await dno.connect(alice).mint(3, { value: FEES.mint * 3n });
    await dno.connect(bob).mint(3, { value: FEES.mint * 3n });
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
        { mealBurnBps: 10_001 },
        { payoutBps: [10_000, 10_000, 0, 10_001] as [number, number, number, number] },
        { purrMaxDays: 0 },
        { halvingPeriod: 0 },
        { vetMultiplier: 0 },
        { maxBoxesPerClaim: 0 },
        { purrMaxPerDay: 255 },
      ];
      for (const override of bad) {
        await expect(factory.deploy(await dno.getAddress(), cCroqAddress, pantryParamsFromSpec(override))).to.be.revertedWithCustomError(
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
        await (await dno.connect(alice).mint(5, { value: FEES.mint * 5n })).wait();
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
        await (await dno.connect(carol).mint(10, { value: FEES.mint * 10n })).wait();
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
      await giveCroquettes(croq, cCroq, carol, 1_000n);
      await approvePantry(carol);
    });

    it("burns a tenth and stashes the rest, in hidden amounts", async function () {
      await expect(feed(carol, 3, 50n)).to.emit(pantry, "MealServed").withArgs(3, carol.address, 1);
      await (await feed(carol, 3, 200n)).wait();
      expect(await stash(3)).to.eq(45n + 180n);
      expect(await burnt()).to.eq(5n + 20n);
      expect(await pantry.meals(3)).to.eq(2n);
      expect(await balanceOf(cCroq, carol)).to.eq(750n);
    });

    it("moves nothing, silently, when the feeder holds too little", async function () {
      await (await feed(carol, 3, 600n)).wait();
      await expect(feed(carol, 3, 600n)).to.emit(pantry, "MealServed").withArgs(3, carol.address, 2);
      expect(await stash(3)).to.eq(540n);
      expect(await balanceOf(cCroq, carol)).to.eq(400n);
    });

    it("lets nobody read a stash: not the holder, not the feeder, not the public", async function () {
      await (await feed(carol, 3, 100n)).wait();
      const handle = await pantry.stashHandle(3);
      for (const who of [bob, carol, deployer]) {
        await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, pantryAddress, who));
      }
      await expectDenied(fhevm.publicDecrypt([handle]));
      await expectDenied(fhevm.publicDecrypt([await pantry.burntHandle()]));
    });

    it("requires the Pantry as operator, an existing box and a sealed one", async function () {
      await giveCroquettes(croq, cCroq, bob, 100n);
      await expect(feed(bob, 0, 10n)).to.be.revertedWithCustomError(cCroq, "ERC7984UnauthorizedSpender");
      await expect(feed(carol, 99, 10n)).to.be.revertedWithCustomError(dno, "ERC721NonexistentToken");
      await (await dno.connect(alice).observe(0, { value: FEES.observe })).wait();
      await expect(feed(carol, 0, 10n)).to.be.revertedWithCustomError(pantry, "NotSealed");
    });

    it("rejects an encrypted amount made for someone else", async function () {
      const input = await fhevm.createEncryptedInput(pantryAddress, carol.address).add64(10n).encrypt();
      await expect(pantry.connect(bob).feed(0, input.handles[0]!, input.inputProof)).to.be.reverted;
    });

    it("stays within the documented HCU budget", async function () {
      expect((await hcu(feed(carol, 3, 50n))).globalHCU).to.be.lessThan(2_300_000);
    });
  });

  describe("settle", function () {
    /** One box per state, owned by alice, each fed 100 by carol (90 stashed). */
    async function boxPerState() {
      const found = new Map<number, number>();
      for (let id = 0; id < Number(await dno.totalMinted()); id++) {
        const state = stateOfSeed(await peekSeed(dno, id));
        if (!found.has(state) && (await dno.ownerOf(id)) === alice.address) found.set(state, id);
      }
      while (found.size < 4) {
        const first = Number(await dno.totalMinted());
        await (await dno.connect(alice).mint(10, { value: FEES.mint * 10n })).wait();
        for (let id = first; id < first + 10; id++) {
          const state = stateOfSeed(await peekSeed(dno, id));
          if (!found.has(state)) found.set(state, id);
        }
      }
      for (const id of found.values()) await (await feed(carol, id, 100n)).wait();
      return found;
    }

    beforeEach(async function () {
      await giveCroquettes(croq, cCroq, carol, 10_000n);
      await approvePantry(carol);
    });

    it("pays alive and asleep cats in full, half of a quantum one, nothing for a ghost", async function () {
      const boxes = await boxPerState();
      const expected: Record<number, bigint> = { [STATE_IDS.alive]: 90n, [STATE_IDS.asleep]: 90n, [STATE_IDS.ghost]: 0n, [STATE_IDS.quantum]: 45n };
      const burntAtStart = await burnt();
      let burntBySettling = 0n;

      for (const [state, id] of boxes) {
        await open(id);
        const before = await balanceOf(cCroq, alice);
        await expect(pantry.connect(carol).settle(id))
          .to.emit(pantry, "Settled")
          .withArgs(id, alice.address, state, await pantry.payoutBps(state));
        expect((await balanceOf(cCroq, alice)) - before, `state ${state}`).to.eq(expected[state]);
        burntBySettling += 90n - expected[state]!;
        expect(await pantry.settled(id)).to.eq(true);
      }
      expect((await burnt()) - burntAtStart).to.eq(burntBySettling);
    });

    it("pays whoever holds the box at settlement: the stash follows the token", async function () {
      const boxes = await boxPerState();
      const id = boxes.get(STATE_IDS.alive)!;
      await (await dno.connect(alice).transferFrom(alice.address, bob.address, id)).wait();
      await open(id);
      await (await pantry.connect(carol).settle(id)).wait();
      expect(await balanceOf(cCroq, bob)).to.eq(90n);
      expect(await balanceOf(cCroq, alice)).to.eq(0n);
    });

    it("settles once, only after the reveal is final", async function () {
      await expect(pantry.settle(0)).to.be.revertedWithCustomError(pantry, "NotRevealed");
      await (await dno.connect(alice).observe(0, { value: FEES.observe })).wait();
      await expect(pantry.settle(0)).to.be.revertedWithCustomError(pantry, "NotRevealed");
      await (await finalizeObserve(dno, 0, carol)).wait();
      await (await pantry.settle(0)).wait();
      await expect(pantry.settle(0)).to.be.revertedWithCustomError(pantry, "AlreadySettled");
    });

    it("settles a box that was never fed without moving anything", async function () {
      await open(1);
      const used = await hcu(pantry.settle(1));
      expect(used.globalHCU).to.eq(0);
      expect(await balanceOf(cCroq, alice)).to.eq(0n);
    });

    it("keeps the books: the Pantry's balance is always reserve + stashes + burnt", async function () {
      const boxes = await boxPerState();
      await (await pantry.connect(alice).claim([...boxes.values()].slice(0, 2))).wait();
      for (const id of [...boxes.values()].slice(0, 2)) {
        await open(id);
        await (await pantry.settle(id)).wait();
      }
      let stashes = 0n;
      for (const id of boxes.values()) if (!(await pantry.settled(id))) stashes += await stash(id);
      const held = await peek64(await cCroq.confidentialBalanceOf(pantryAddress));
      expect(held).to.eq((await reserve()) + stashes + (await burnt()));
    });

    it("stays within the documented HCU budget", async function () {
      const boxes = await boxPerState();
      const budget: Record<number, number> = { [STATE_IDS.alive]: 650_000, [STATE_IDS.asleep]: 650_000, [STATE_IDS.ghost]: 200_000, [STATE_IDS.quantum]: 2_100_000 };
      for (const [state, id] of boxes) {
        await open(id);
        expect((await hcu(pantry.settle(id))).globalHCU, `state ${state}`).to.be.lessThan(budget[state]!);
      }
    });
  });
});
