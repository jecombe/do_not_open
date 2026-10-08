import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { buildCatSpec, FIXTURE_SEEDS, mulberry32 } from "@dno/generator";
import { configParamsFromSpec, loadSpec } from "../lib/specParams";
import {
  announce,
  confidentialUsdcOf,
  deploy,
  expectDenied,
  FEES,
  finalizeRequest,
  grantedIn,
  holdings,
  mintBoxes,
  NOT_YOURS,
  open,
  ownerOf,
  peekSeed as peek,
  proveAlive,
  REQUEST,
  requestIdOf,
  shakeAndDecrypt as shakeFor,
  STARTING_CUSDC,
  STATE_IDS,
  TRAIT_KEYS,
  withdrawAll,
} from "./helpers";
import { DoNotOpen, DoNotOpenConfig, TestConfidentialUSDC } from "../types";

describe("DoNotOpenConfig", function () {
  let config: DoNotOpenConfig;

  before(async function () {
    ({ config } = await deploy());
  });

  it("records the hash of the spec it was built from", async function () {
    expect(await config.specHash()).to.eq(loadSpec().specHash);
  });

  it("decodes seeds exactly like the TypeScript generator", async function () {
    const rand = mulberry32(2026);
    const seeds = FIXTURE_SEEDS.map((f) => f.seed);
    for (let i = 0; i < 150; i++) {
      seeds.push((BigInt(Math.floor(rand() * 2 ** 32)) << 32n) | BigInt(Math.floor(rand() * 2 ** 32)));
    }
    seeds.push(0n, 2n ** 64n - 1n, 45874n, 45875n, 58982n, 64225n);

    for (const seed of seeds) {
      const cat = buildCatSpec({ seed });
      const [state, rolls, score] = await config.decode(seed);
      expect(Number(state), `state of ${cat.seed}`).to.eq(STATE_IDS[cat.state]);
      expect(rolls.map(Number), `rolls of ${cat.seed}`).to.deep.eq(TRAIT_KEYS.map((k) => cat.traits[k].roll));
      expect(Number(score), `score of ${cat.seed}`).to.eq(cat.rarity.score);
    }
  });

  it("maps rolls to variants like the generator", async function () {
    const cat = buildCatSpec({ seed: FIXTURE_SEEDS[2]!.seed });
    for (let i = 0; i < TRAIT_KEYS.length; i++) {
      const t = cat.traits[TRAIT_KEYS[i]!];
      expect(Number(await config.variantOf(i, t.roll))).to.eq(t.variantIndex);
    }
    await expect(config.variantOf(5, 0)).to.be.revertedWithCustomError(config, "UnknownTrait");
  });

  it("rejects inconsistent parameters", async function () {
    const factory = await ethers.getContractFactory("DoNotOpenConfig");
    await expect(factory.deploy(configParamsFromSpec({ stateRollBelow: [50000, 40000, 60000] }))).to.be.revertedWithCustomError(
      factory,
      "InvalidStateThresholds",
    );
    const widths = configParamsFromSpec().variantWidths;
    widths[1] = "0x4034";
    await expect(factory.deploy(configParamsFromSpec({ variantWidths: widths }))).to.be.revertedWithCustomError(
      factory,
      "InvalidVariantWidths",
    );
    await expect(factory.deploy(configParamsFromSpec({ traitOffset: [8, 24, 32, 40, 48] }))).to.be.revertedWithCustomError(
      factory,
      "InvalidTraitOffset",
    );
    await expect(factory.deploy(configParamsFromSpec({ feedBound: 3 }))).to.be.revertedWithCustomError(factory, "InvalidFeedBound");
    await expect(factory.deploy(configParamsFromSpec({ paidShakeHolderBps: 10001 }))).to.be.revertedWithCustomError(
      factory,
      "InvalidShare",
    );
  });
});

describe("DoNotOpen", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dno: DoNotOpen;
  let address: string;
  let cUsdc: TestConfidentialUSDC;
  const maxPerTx = configParamsFromSpec().maxPerTx;

  const peekSeed = (tokenId: number) => peek(dno, tokenId);
  const shakeAndDecrypt = (tokenId: number, who: HardhatEthersSigner) => shakeFor(dno, tokenId, who);
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
    ({ dno, address, cUsdc } = await deploy());
  });

  describe("mint", function () {
    it("creates ten boxes per mint and gives the buyer the first ones, privately", async function () {
      const { created, owned, quantity } = await mintBoxes(dno, alice, 3);
      expect(created).to.deep.eq([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(owned).to.deep.eq([0, 1, 2]);
      expect(quantity).to.eq(3);
      expect(await dno.tokenCount()).to.eq(maxPerTx);
      for (const id of created) expect(await ownerOf(dno, id)).to.eq(id < 3 ? alice.address : ethers.ZeroAddress);
      expect(await holdings(dno, alice)).to.deep.eq([0, 1, 2]);
      // Ten distinct seeds, sold or not: from outside, every box of a mint looks the same.
      const handles = await Promise.all(created.map((id) => dno.seedHandle(id)));
      expect(new Set(handles).size).to.eq(maxPerTx);
      expect(await dno.status(0)).to.eq(0);
    });

    it("charges only the boxes it gives, in cUSDC", async function () {
      await mintBoxes(dno, alice, 4);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(STARTING_CUSDC - 4n * FEES.mint);
      expect(await withdrawAll(dno, cUsdc, carol)).to.eq(4n * FEES.mint);
    });

    it("lets nobody read the revenue, the owner included: it would give away each mint's quantity", async function () {
      const { receipt } = await mintBoxes(dno, alice, 2);
      // The buyer may read their receipts and quantity; the owner gets nothing from a mint.
      expect(grantedIn(receipt)).to.include(alice.address);
      expect(grantedIn(receipt)).to.not.include(deployer.address);
    });

    it("hides the quantity among as many ids as the buyer picks, and never gives more", async function () {
      const three = await mintBoxes(dno, alice, 2, 3);
      expect(three.created).to.deep.eq([0, 1, 2]);
      expect(three.owned).to.deep.eq([0, 1]);
      // Asking for more boxes than ids gets as many boxes as ids.
      const one = await mintBoxes(dno, bob, 4, 1);
      expect([one.created, one.owned]).to.deep.eq([[3], [3]]);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC - FEES.mint);
      const input = await fhevm.createEncryptedInput(address, alice.address).add8(1).encrypt();
      await expect(dno.connect(alice).mint(input.handles[0]!, input.inputProof, 0)).to.be.revertedWithCustomError(dno, "InvalidIdCount");
      await expect(dno.connect(alice).mint(input.handles[0]!, input.inputProof, 11)).to.be.revertedWithCustomError(dno, "InvalidIdCount");
    });

    it("cuts a quantity above the batch size down to it", async function () {
      const { owned } = await mintBoxes(dno, alice, 200);
      expect(owned.length).to.eq(maxPerTx);
    });

    it("gives nothing and charges nothing to a buyer who cannot pay", async function () {
      const broke = (await ethers.getSigners())[9]!;
      const tx = mintBoxes(dno, broke, 1);
      // Never made the collection an operator: the token refuses to move anything.
      await expect(tx).to.be.reverted;

      const poor = (await ethers.getSigners())[8]!;
      const fresh = await deploy();
      await (await fresh.usdc.mint(poor.address, FEES.mint)).wait();
      await (await fresh.usdc.connect(poor).approve(await fresh.cUsdc.getAddress(), FEES.mint)).wait();
      await (await fresh.cUsdc.connect(poor).wrap(poor.address, FEES.mint)).wait();
      await (await fresh.cUsdc.connect(poor).setOperator(fresh.address, 2 ** 40)).wait();
      const { owned } = await mintBoxes(fresh.dno, poor, 2);
      expect(owned).to.deep.eq([]);
      expect(await confidentialUsdcOf(fresh.cUsdc, poor)).to.eq(FEES.mint);
    });

    it("never sells past the cap, and charges nothing for a mint that would", async function () {
      const small = await deploy({ maxSupply: 5 });
      expect((await mintBoxes(small.dno, alice, 3)).owned).to.deep.eq([0, 1, 2]);
      // 3 + 3 > 5: all or nothing, so nothing.
      expect((await mintBoxes(small.dno, bob, 3)).owned).to.deep.eq([]);
      expect(await confidentialUsdcOf(small.cUsdc, bob)).to.eq(STARTING_CUSDC);
      expect((await mintBoxes(small.dno, bob, 2)).owned).to.deep.eq([20, 21]);
      expect((await mintBoxes(small.dno, carol, 1)).owned).to.deep.eq([]);
    });

    it("gives nobody the right to decrypt the seed, not even the holder or the deployer", async function () {
      await mintBoxes(dno, alice, 1);
      const handle = await dno.seedHandle(0);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, address, alice));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, address, deployer));
      await expectDenied(fhevm.publicDecrypt([handle]));
    });

    it("stays within the HCU budget", async function () {
      const input = await fhevm.createEncryptedInput(address, alice.address).add8(10).encrypt();
      const used = await hcu(dno.connect(alice).mint(input.handles[0]!, input.inputProof, 10));
      expect(used.globalHCU).to.be.lessThan(3_500_000);
      expect(used.maxHCUDepth).to.be.lessThan(5_000_000);
    });
  });

  describe("milestones", function () {
    it("announces each milestone once it is reached, and nothing in between", async function () {
      const small = await deploy({ maxSupply: 12 }, [4, 8, 12]);
      expect(await small.config.milestones()).to.deep.eq([4n, 8n, 12n]);
      expect(await small.config.giftBoxes()).to.eq(0);
      await mintBoxes(small.dno, alice, 3);
      expect(await announce(small.dno, carol)).to.eq(false);
      await mintBoxes(small.dno, bob, 2);
      expect(await announce(small.dno, carol)).to.eq(true);
      expect(await small.dno.milestonesReached()).to.eq(1);
      // The bit was used up: nothing to ask until the next mint.
      expect(await small.dno.milestoneHandle()).to.eq(ethers.ZeroHash);
      await mintBoxes(small.dno, carol, 3);
      expect(await announce(small.dno, carol)).to.eq(true);
      await mintBoxes(small.dno, alice, 4);
      expect(await announce(small.dno, carol)).to.eq(true);
      expect(await small.dno.milestonesReached()).to.eq(3);
      // Sold out: no more bits, no more boxes.
      expect(await small.dno.milestoneHandle()).to.eq(ethers.ZeroHash);
      expect((await mintBoxes(small.dno, bob, 1)).owned).to.deep.eq([]);
    });

    it("rejects a forged answer and milestones past the supply or out of order", async function () {
      const small = await deploy({ maxSupply: 12 }, [4, 12]);
      await mintBoxes(small.dno, alice, 1);
      const r = await fhevm.publicDecrypt([await small.dno.milestoneHandle()]);
      const lie = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
      await expect(small.dno.announceMilestone(lie, r.decryptionProof)).to.be.reverted;
      await expect(small.dno.announceMilestone(r.abiEncodedClearValues, r.decryptionProof)).to.be.revertedWithCustomError(
        small.dno,
        "NothingToAnnounce",
      );

      const config = await ethers.getContractFactory("DoNotOpenConfig");
      await expect(deploy({ maxSupply: 12 }, [4, 13])).to.be.revertedWithCustomError(config, "InvalidMilestones");
      await expect(deploy({ maxSupply: 12 }, [8, 4, 12])).to.be.revertedWithCustomError(config, "InvalidMilestones");
      await expect(deploy({ maxSupply: 12 }, [])).to.be.revertedWithCustomError(config, "InvalidMilestones");
    });

    it("stops the sale at the last milestone and keeps the rest of the supply for the gifts", async function () {
      const small = await deploy({ maxSupply: 12 }, [4, 10]);
      expect(await small.config.giftBoxes()).to.eq(2);
      await mintBoxes(small.dno, alice, 10);
      expect((await mintBoxes(small.dno, bob, 1)).owned).to.deep.eq([]);
      await small.dno.setGiver(carol.address);
      const first = await small.dno.connect(carol).gift.staticCall(bob.address);
      await expect(small.dno.connect(carol).gift(bob.address)).to.emit(small.dno, "BoxGifted").withArgs(first, bob.address);
      expect(await ownerOf(small.dno, first)).to.eq(bob.address);
      await small.dno.connect(carol).gift(alice.address);
      await expect(small.dno.connect(carol).gift(alice.address)).to.be.revertedWithCustomError(small.dno, "TooManyBoxes");
      expect(await small.dno.giftsMinted()).to.eq(2);
    });
  });

  describe("shake", function () {
    beforeEach(async function () {
      await mintBoxes(dno, alice, 1);
    });

    it("privately reveals one real trait of the box to its holder", async function () {
      const seed = await peekSeed(0);
      const offsets = (await (await ethers.getContractAt("DoNotOpenConfig", await dno.config())).traitOffsets()).map(Number);
      const seen = new Set<number>();
      for (let i = 0; i < 12; i++) {
        const { pick, roll } = await shakeAndDecrypt(0, alice);
        expect(offsets, "pick must be one of the five trait offsets").to.include(pick);
        expect(roll).to.eq(Number((seed >> BigInt(pick)) & 0xffn));
        seen.add(pick);
      }
      expect(seen.size).to.be.greaterThan(1);
    });

    it("tells anyone else only that the box is not theirs, without reverting", async function () {
      await expect(dno.connect(bob).shake(0)).to.emit(dno, "Shaken").withArgs(0, bob.address, false);
      const { pick, roll } = await shakeAndDecrypt(0, bob);
      expect([pick, roll]).to.deep.eq([NOT_YOURS, 0]);
      // An empty box answers the same to its "buyer".
      expect((await shakeAndDecrypt(5, alice)).pick).to.eq(NOT_YOURS);
    });

    it("keeps the result unreadable for everybody else", async function () {
      const { handles } = await shakeAndDecrypt(0, alice);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, handles.roll, address, bob));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, handles.pick, address, bob));
      await expectDenied(fhevm.publicDecrypt([handles.roll]));
    });

    it("stays within the HCU budget", async function () {
      const used = await hcu(dno.connect(alice).shake(0));
      expect(used.globalHCU).to.be.lessThan(1_000_000);
    });
  });

  describe("transfer", function () {
    beforeEach(async function () {
      await mintBoxes(dno, alice, 1);
    });

    it("hands the box over: the new holder can shake, the previous one cannot", async function () {
      const before = await shakeAndDecrypt(0, alice);
      await (await dno.connect(alice).confidentialTransfer(bob.address, 0)).wait();
      expect((await shakeAndDecrypt(0, alice)).pick).to.eq(NOT_YOURS);

      const seed = await peekSeed(0);
      const after = await shakeAndDecrypt(0, bob);
      expect(after.roll).to.eq(Number((seed >> BigInt(after.pick)) & 0xffn));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, after.handles.roll, address, alice));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, before.handles.roll, address, bob));
      expect(await holdings(dno, alice)).to.deep.eq([]);
      expect(await holdings(dno, bob)).to.deep.eq([0]);
    });
  });

  describe("observe", function () {
    beforeEach(async function () {
      await mintBoxes(dno, alice, 2);
    });

    it("opens the box in two steps and stores what the generator predicts", async function () {
      const seed = await peekSeed(0);
      const cat = buildCatSpec({ seed });
      const id = requestIdOf(dno, await (await dno.connect(alice).observe(0)).wait());
      expect(await dno.status(0)).to.eq(0);

      // Anyone may relay the decryption; here a third party does.
      await expect(finalizeRequest(dno, id, carol))
        .to.emit(dno, "Observed")
        .withArgs(0, alice.address, seed, STATE_IDS[cat.state], cat.rarity.score, false)
        .and.to.emit(dno, "RequestSettled")
        .withArgs(id, REQUEST.Done);

      expect(await dno.status(0)).to.eq(1n);
      const contents = await dno.contentsOf(0);
      expect(contents.seed).to.eq(seed);
      expect(contents.traits.map(Number)).to.deep.eq(TRAIT_KEYS.map((k) => cat.traits[k].roll));
      expect(Number(contents.score)).to.eq(cat.rarity.score);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(STARTING_CUSDC - 2n * FEES.mint - FEES.observe);

      // The other box is untouched.
      expect(await dno.status(1)).to.eq(0);
      await expectDenied(fhevm.publicDecrypt([await dno.seedHandle(1)]));
    });

    it("refuses someone who does not hold the box: nothing opens, nothing is charged, nothing leaks", async function () {
      const id = requestIdOf(dno, await (await dno.connect(bob).observe(0)).wait());
      const [, , , , , handles] = await dno.requestInfo(id);
      const clear = await fhevm.publicDecrypt([...handles]);
      // "No", and a zero where the seed would be. The box was never fed: no affection.
      expect(Object.values(clear.clearValues).map((v) => BigInt(v as bigint | boolean))).to.deep.eq([0n, 0n]);
      await expect(finalizeRequest(dno, id, carol)).to.emit(dno, "RequestSettled").withArgs(id, REQUEST.Refused);
      expect(await dno.status(0)).to.eq(0);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC);
      // The holder can still open it.
      expect(await open(dno, 0, alice, carol)).to.eq(REQUEST.Done);
    });

    it("rejects a forged seed, a proof made for another request, and a second settlement", async function () {
      const a = requestIdOf(dno, await (await dno.connect(alice).observe(0)).wait());
      const b = requestIdOf(dno, await (await dno.connect(alice).observe(1)).wait());
      const realA = await fhevm.publicDecrypt([...(await dno.requestInfo(a))[5]]);
      const realB = await fhevm.publicDecrypt([...(await dno.requestInfo(b))[5]]);

      const dream = ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint64"], [true, FIXTURE_SEEDS[3]!.seed]);
      await expect(dno.finalize(a, dream, realA.decryptionProof)).to.be.reverted;
      await expect(dno.finalize(a, realB.abiEncodedClearValues, realB.decryptionProof)).to.be.reverted;
      expect(await dno.status(0)).to.eq(0n);

      await dno.finalize(a, realA.abiEncodedClearValues, realA.decryptionProof);
      expect(await dno.status(0)).to.eq(1n);
      await expect(dno.finalize(a, realA.abiEncodedClearValues, realA.decryptionProof)).to.be.revertedWithCustomError(dno, "RequestNotPending");
      await expect(dno.connect(alice).observe(0)).to.be.revertedWithCustomError(dno, "NotSealed");
      await expect(dno.connect(alice).shake(0)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("still opens for the holder at the time of the request, even if the box moved since", async function () {
      const id = requestIdOf(dno, await (await dno.connect(alice).observe(0)).wait());
      await (await dno.connect(alice).confidentialTransfer(bob.address, 0)).wait();
      await finalizeRequest(dno, id, carol);
      expect(await dno.status(0)).to.eq(1n);
      expect(await ownerOf(dno, 0)).to.eq(bob.address);
    });
  });

  describe("proveAlive", function () {
    beforeEach(async function () {
      await mintBoxes(dno, alice, 6);
    });

    it("publishes exactly one bit and grants the badge when it is true", async function () {
      const aliveBelow = BigInt(configParamsFromSpec().stateRollBelow[0]);
      for (let tokenId = 0; tokenId < 6; tokenId++) {
        const expected = ((await peekSeed(tokenId)) & 0xffffn) < aliveBelow;
        expect(await proveAlive(dno, tokenId, alice, carol)).to.eq(REQUEST.Done);
        expect(await dno.aliveCheck(tokenId) === 1n).to.eq(expected);
        expect(await dno.aliveCheck(tokenId)).to.eq(expected ? 1 : 2);
        expect(await dno.status(tokenId)).to.eq(0);
        await expectDenied(fhevm.publicDecrypt([await dno.seedHandle(tokenId)]));
      }
    });

    it("refuses a stranger, and is asked once per box", async function () {
      expect(await proveAlive(dno, 0, bob, carol)).to.eq(REQUEST.Refused);
      expect(await dno.aliveCheck(0)).to.eq(0);
      await proveAlive(dno, 0, alice, carol);
      await expect(dno.connect(alice).proveAlive(0)).to.be.revertedWithCustomError(dno, "NotSealed");
      await open(dno, 1, alice, carol);
      await expect(dno.connect(alice).proveAlive(1)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("rejects a forged answer", async function () {
      const id = requestIdOf(dno, await (await dno.connect(alice).proveAlive(0)).wait());
      const real = await fhevm.publicDecrypt([...(await dno.requestInfo(id))[5]]);
      const [holds, alive] = ethers.AbiCoder.defaultAbiCoder().decode(["bool", "bool"], real.abiEncodedClearValues);
      const lie = ethers.AbiCoder.defaultAbiCoder().encode(["bool", "bool"], [holds, !alive]);
      await expect(dno.finalize(id, lie, real.decryptionProof)).to.be.reverted;
      expect(await dno.aliveCheck(0)).to.eq(0);
    });
  });

  describe("revenue", function () {
    it("pays the revenue out at most once a week, so the owner only learns weekly sums", async function () {
      await mintBoxes(dno, alice, 2);
      await expect(dno.withdraw(carol.address)).to.be.revertedWithCustomError(dno, "WithdrawTooSoon");
      expect(await withdrawAll(dno, cUsdc, carol)).to.eq(2n * FEES.mint);
      await mintBoxes(dno, bob, 1);
      await expect(dno.withdraw(carol.address)).to.be.revertedWithCustomError(dno, "WithdrawTooSoon");
      expect(await withdrawAll(dno, cUsdc, carol)).to.eq(FEES.mint);
    });

    it("holds an opening's fee until it settles, and pays a refund without touching the revenue", async function () {
      await mintBoxes(dno, alice, 1);
      const first = requestIdOf(dno, await (await dno.connect(alice).observe(0)).wait());
      const second = requestIdOf(dno, await (await dno.connect(alice).observe(0)).wait());
      // Pending openings are not revenue yet.
      expect(await withdrawAll(dno, cUsdc, carol)).to.eq(FEES.mint);
      await (await finalizeRequest(dno, first, bob)).wait();
      const before = await confidentialUsdcOf(cUsdc, alice);
      // Already open: the second fee goes back. Before the fix this refund came out of a revenue
      // just withdrawn, which wrapped around and lost every later sale.
      await (await finalizeRequest(dno, second, bob)).wait();
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(before + FEES.observe);
      await mintBoxes(dno, bob, 1);
      expect(await withdrawAll(dno, cUsdc, carol)).to.eq(FEES.mint + FEES.observe);
    });
  });

  describe("admin", function () {
    it("lets only the owner withdraw the revenue, trust readers and point the token URIs", async function () {
      await mintBoxes(dno, alice, 2);
      await open(dno, 0, alice, carol);
      await expect(dno.connect(alice).withdraw(alice.address)).to.be.revertedWithCustomError(dno, "OwnableUnauthorizedAccount");
      expect(await withdrawAll(dno, cUsdc, carol)).to.eq(2n * FEES.mint + FEES.observe);

      await expect(dno.connect(alice).setTrustedReader(alice.address, true)).to.be.revertedWithCustomError(dno, "OwnableUnauthorizedAccount");
      expect(await dno.tokenURI(1)).to.eq("");
      const metadata = await (await ethers.getContractFactory("BoxMetadata")).deploy("https://api.test/metadata/", deployer.address);
      await expect(dno.connect(alice).setMetadata(await metadata.getAddress())).to.be.revertedWithCustomError(dno, "OwnableUnauthorizedAccount");
      await dno.connect(deployer).setMetadata(await metadata.getAddress());
      expect(await dno.tokenURI(1)).to.eq("https://api.test/metadata/1");
      await expect(metadata.connect(alice).setBaseURI("ipfs://x/")).to.be.revertedWithCustomError(metadata, "OwnableUnauthorizedAccount");
      await metadata.setBaseURI("ipfs://boxes/");
      expect(await dno.tokenURI(1)).to.eq("ipfs://boxes/1");
      await expect(dno.tokenURI(99)).to.be.revertedWithCustomError(dno, "ConfidentialERC721NonexistentToken");
    });
  });
});
