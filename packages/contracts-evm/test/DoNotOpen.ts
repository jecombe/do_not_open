import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { buildCatSpec, FIXTURE_SEEDS, mulberry32 } from "@dno/generator";
import { configParamsFromSpec, loadSpec, type ConfigParams } from "../lib/specParams";
import { DoNotOpen, DoNotOpenConfig } from "../types";

const MINT_PRICE = ethers.parseEther("0.002");
const OBSERVE_FEE = ethers.parseEther("0.0005");
const STATE_IDS = { alive: 0, asleep: 1, ghost: 2, quantum: 3 } as const;
const TRAIT_KEYS = ["breed", "mood", "accessory", "brokenThing", "room"] as const;

async function deploy(overrides: Partial<ConfigParams> = {}) {
  const [deployer] = await ethers.getSigners();
  const config = (await (await ethers.getContractFactory("DoNotOpenConfig")).deploy(
    configParamsFromSpec(overrides),
  )) as unknown as DoNotOpenConfig;
  const dno = (await (await ethers.getContractFactory("DoNotOpen")).deploy(
    await config.getAddress(),
    MINT_PRICE,
    OBSERVE_FEE,
    deployer!.address,
  )) as unknown as DoNotOpen;
  return { config, dno, address: await dno.getAddress() };
}

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
  });
});

describe("DoNotOpen", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dno: DoNotOpen;
  let address: string;

  /** Mock only: reads the seed straight from the local coprocessor. Impossible on a real network. */
  const peekSeed = async (tokenId: number) => fhevm.debugger.decryptEuint(FhevmType.euint64, await dno.seedHandle(tokenId));

  const shakeAndDecrypt = async (tokenId: number, who: HardhatEthersSigner) => {
    await (await dno.connect(who).shake(tokenId)).wait();
    const [pick, roll] = await dno.lastShake(tokenId, who.address);
    return {
      pick: Number(await fhevm.userDecryptEuint(FhevmType.euint8, pick, address, who)),
      roll: Number(await fhevm.userDecryptEuint(FhevmType.euint8, roll, address, who)),
      handles: { pick, roll },
    };
  };

  const expectDenied = async (p: Promise<unknown>) => {
    let failed = false;
    try {
      await p;
    } catch {
      failed = true;
    }
    expect(failed, "decryption should have been refused").to.eq(true);
  };

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
  });

  describe("mint", function () {
    it("mints sealed boxes with distinct encrypted seeds", async function () {
      const tx = await dno.connect(alice).mint(3, { value: MINT_PRICE * 3n });
      await expect(tx).to.emit(dno, "Minted").withArgs(0, alice.address).and.to.emit(dno, "Minted").withArgs(2, alice.address);

      expect(await dno.totalMinted()).to.eq(3);
      expect(await dno.balanceOf(alice.address)).to.eq(3);
      const handles = await Promise.all([0, 1, 2].map((id) => dno.seedHandle(id)));
      expect(new Set(handles).size).to.eq(3);
      for (const h of handles) expect(h).to.not.eq(ethers.ZeroHash);
      expect(await dno.status(0)).to.eq(0);
      expect(await dno.revealed(0)).to.eq(false);
    });

    it("costs one FHE operation per box", async function () {
      const receipt = await (await dno.connect(alice).mint(4, { value: MINT_PRICE * 4n })).wait();
      const hcu = fhevm.computeTransactionHCU(receipt!);
      expect(hcu.globalHCU).to.eq(4 * 24_000);
    });

    it("enforces price, batch size and supply", async function () {
      await expect(dno.connect(alice).mint(1, { value: MINT_PRICE - 1n })).to.be.revertedWithCustomError(dno, "WrongPayment");
      await expect(dno.connect(alice).mint(1, { value: MINT_PRICE + 1n })).to.be.revertedWithCustomError(dno, "WrongPayment");
      await expect(dno.connect(alice).mint(0)).to.be.revertedWithCustomError(dno, "InvalidQuantity");
      await expect(dno.connect(alice).mint(11, { value: MINT_PRICE * 11n })).to.be.revertedWithCustomError(dno, "InvalidQuantity");

      const small = await deploy({ maxSupply: 3 });
      await small.dno.connect(alice).mint(2, { value: MINT_PRICE * 2n });
      await expect(small.dno.connect(bob).mint(2, { value: MINT_PRICE * 2n })).to.be.revertedWithCustomError(small.dno, "SoldOut");
      await small.dno.connect(bob).mint(1, { value: MINT_PRICE });
      expect(await small.dno.totalMinted()).to.eq(3);
    });

    it("gives nobody the right to decrypt the seed, not even the holder or the deployer", async function () {
      await dno.connect(alice).mint(1, { value: MINT_PRICE });
      const handle = await dno.seedHandle(0);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, address, alice));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, handle, address, deployer));
      await expectDenied(fhevm.publicDecrypt([handle]));
    });
  });

  describe("shake", function () {
    beforeEach(async function () {
      await dno.connect(alice).mint(1, { value: MINT_PRICE });
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
      // Twelve uniform draws over five traits land on a single one with probability 5^-11.
      expect(seen.size).to.be.greaterThan(1);
    });

    it("emits no information about the pick", async function () {
      await expect(dno.connect(alice).shake(0)).to.emit(dno, "Shaken").withArgs(0, alice.address, false);
    });

    it("stays within the documented HCU budget", async function () {
      const receipt = await (await dno.connect(alice).shake(0)).wait();
      const hcu = fhevm.computeTransactionHCU(receipt!);
      expect(hcu.globalHCU).to.be.lessThan(700_000);
      expect(hcu.maxHCUDepth).to.be.lessThan(5_000_000);
    });

    it("is refused to anyone but the holder", async function () {
      await expect(dno.connect(bob).shake(0)).to.be.revertedWithCustomError(dno, "NotHolder");
    });

    it("keeps the result unreadable for everybody else", async function () {
      const { handles } = await shakeAndDecrypt(0, alice);
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, handles.roll, address, bob));
      await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, handles.pick, address, bob));
      await expectDenied(fhevm.publicDecrypt([handles.roll]));
    });
  });

  describe("transfer", function () {
    beforeEach(async function () {
      await dno.connect(alice).mint(1, { value: MINT_PRICE });
    });

    for (const method of ["transferFrom", "safeTransferFrom"] as const) {
      it(`${method}: the new holder can shake, the previous one cannot`, async function () {
        const before = await shakeAndDecrypt(0, alice);

        if (method === "transferFrom") await dno.connect(alice).transferFrom(alice.address, bob.address, 0);
        else await dno.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0);

        await expect(dno.connect(alice).shake(0)).to.be.revertedWithCustomError(dno, "NotHolder");

        const seed = await peekSeed(0);
        const after = await shakeAndDecrypt(0, bob);
        expect(after.roll).to.eq(Number((seed >> BigInt(after.pick)) & 0xffn));

        // The previous holder gets nothing new...
        await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, after.handles.roll, address, alice));
        // ...and the new holder does not inherit what the previous one learned.
        await expectDenied(fhevm.userDecryptEuint(FhevmType.euint8, before.handles.roll, address, bob));
        // Neither of them, at any point, can read the seed.
        await expectDenied(fhevm.userDecryptEuint(FhevmType.euint64, await dno.seedHandle(0), address, bob));
      });
    }
  });

  describe("observe", function () {
    beforeEach(async function () {
      await dno.connect(alice).mint(2, { value: MINT_PRICE * 2n });
    });

    const finalize = async (tokenId: number, sender: HardhatEthersSigner = carol) => {
      const result = await fhevm.publicDecrypt([await dno.seedHandle(tokenId)]);
      return dno.connect(sender).finalizeObserve(tokenId, result.abiEncodedClearValues, result.decryptionProof);
    };

    it("opens the box in two steps and stores what the generator predicts", async function () {
      const seed = await peekSeed(0);
      const cat = buildCatSpec({ seed });

      await expect(dno.connect(alice).observe(0, { value: OBSERVE_FEE }))
        .to.emit(dno, "ObserveRequested")
        .withArgs(0, await dno.seedHandle(0));
      expect(await dno.status(0)).to.eq(1);
      expect(await dno.revealed(0)).to.eq(false);

      // Anyone may relay the decryption; here a third party does.
      await expect(finalize(0))
        .to.emit(dno, "Observed")
        .withArgs(0, seed, STATE_IDS[cat.state], cat.rarity.score, false);

      expect(await dno.revealed(0)).to.eq(true);
      const contents = await dno.contentsOf(0);
      expect(contents.seed).to.eq(seed);
      expect(Number(contents.state)).to.eq(STATE_IDS[cat.state]);
      expect(contents.traits.map(Number)).to.deep.eq(TRAIT_KEYS.map((k) => cat.traits[k].roll));
      expect(Number(contents.score)).to.eq(cat.rarity.score);

      // The other box is untouched.
      expect(await dno.status(1)).to.eq(0);
      await expectDenied(fhevm.publicDecrypt([await dno.seedHandle(1)]));
    });

    it("uses no FHE operation", async function () {
      const receipt = await (await dno.connect(alice).observe(0, { value: OBSERVE_FEE })).wait();
      expect(fhevm.computeTransactionHCU(receipt!).globalHCU).to.eq(0);
    });

    it("requires the holder and the exact fee", async function () {
      await expect(dno.connect(bob).observe(0, { value: OBSERVE_FEE })).to.be.revertedWithCustomError(dno, "NotHolder");
      await expect(dno.connect(alice).observe(0)).to.be.revertedWithCustomError(dno, "WrongPayment");
    });

    it("rejects duplicate requests and out-of-order finalisation", async function () {
      const fake = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [1n]);
      await expect(dno.finalizeObserve(0, fake, "0x")).to.be.revertedWithCustomError(dno, "NotObserving");

      await dno.connect(alice).observe(0, { value: OBSERVE_FEE });
      await expect(dno.connect(alice).observe(0, { value: OBSERVE_FEE })).to.be.revertedWithCustomError(dno, "NotSealed");

      await finalize(0);
      await expect(finalize(0)).to.be.revertedWithCustomError(dno, "NotObserving");
      await expect(dno.connect(alice).observe(0, { value: OBSERVE_FEE })).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("rejects a forged seed and a proof made for another box", async function () {
      await dno.connect(alice).observe(0, { value: OBSERVE_FEE });
      await dno.connect(alice).observe(1, { value: OBSERVE_FEE });
      const real0 = await fhevm.publicDecrypt([await dno.seedHandle(0)]);
      const real1 = await fhevm.publicDecrypt([await dno.seedHandle(1)]);

      // Someone would love box 0 to be a quantum glitch.
      const dream = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [FIXTURE_SEEDS[3]!.seed]);
      await expect(dno.finalizeObserve(0, dream, real0.decryptionProof)).to.be.reverted;
      await expect(dno.finalizeObserve(0, real1.abiEncodedClearValues, real1.decryptionProof)).to.be.reverted;
      expect(await dno.revealed(0)).to.eq(false);

      await dno.finalizeObserve(0, real0.abiEncodedClearValues, real0.decryptionProof);
      expect(await dno.revealed(0)).to.eq(true);
    });

    it("stops shakes once the box is being opened", async function () {
      await dno.connect(alice).observe(0, { value: OBSERVE_FEE });
      await expect(dno.connect(alice).shake(0)).to.be.revertedWithCustomError(dno, "NotSealed");
      await finalize(0);
      await expect(dno.connect(alice).shake(0)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("can still be finalised after the box changes hands", async function () {
      await dno.connect(alice).observe(0, { value: OBSERVE_FEE });
      await dno.connect(alice).transferFrom(alice.address, bob.address, 0);
      await finalize(0);
      expect(await dno.revealed(0)).to.eq(true);
      expect(await dno.ownerOf(0)).to.eq(bob.address);
    });
  });

  describe("proveAlive", function () {
    beforeEach(async function () {
      await dno.connect(alice).mint(6, { value: MINT_PRICE * 6n });
    });

    const finalize = async (tokenId: number) => {
      const result = await fhevm.publicDecrypt([await dno.aliveHandle(tokenId)]);
      return dno.connect(carol).finalizeProveAlive(tokenId, result.abiEncodedClearValues, result.decryptionProof);
    };

    it("publishes exactly one bit and grants the badge when it is true", async function () {
      const aliveBelow = BigInt(configParamsFromSpec().stateRollBelow[0]);
      for (let tokenId = 0; tokenId < 6; tokenId++) {
        const expected = ((await peekSeed(tokenId)) & 0xffffn) < aliveBelow;

        await expect(dno.connect(alice).proveAlive(tokenId)).to.emit(dno, "AliveCheckRequested");
        expect(await dno.aliveCheck(tokenId)).to.eq(1);
        await expect(finalize(tokenId)).to.emit(dno, "AliveProven").withArgs(tokenId, expected);

        expect(await dno.vetCertified(tokenId)).to.eq(expected);
        expect(await dno.aliveCheck(tokenId)).to.eq(expected ? 2 : 3);
        // The box is still sealed and its seed still private.
        expect(await dno.status(tokenId)).to.eq(0);
        await expectDenied(fhevm.publicDecrypt([await dno.seedHandle(tokenId)]));
      }
    });

    it("stays within the documented HCU budget", async function () {
      const receipt = await (await dno.connect(alice).proveAlive(0)).wait();
      expect(fhevm.computeTransactionHCU(receipt!).globalHCU).to.be.lessThan(60_000);
    });

    it("can be requested once, by the holder, on a sealed box", async function () {
      await expect(dno.connect(bob).proveAlive(0)).to.be.revertedWithCustomError(dno, "NotHolder");
      await expect(dno.finalizeProveAlive(0, "0x", "0x")).to.be.revertedWithCustomError(dno, "AliveCheckNotPending");

      await dno.connect(alice).proveAlive(0);
      await expect(dno.connect(alice).proveAlive(0)).to.be.revertedWithCustomError(dno, "AliveCheckAlreadyRequested");
      await finalize(0);
      await expect(finalize(0)).to.be.revertedWithCustomError(dno, "AliveCheckNotPending");
      await expect(dno.connect(alice).proveAlive(0)).to.be.revertedWithCustomError(dno, "AliveCheckAlreadyRequested");

      await dno.connect(alice).observe(1, { value: OBSERVE_FEE });
      await expect(dno.connect(alice).proveAlive(1)).to.be.revertedWithCustomError(dno, "NotSealed");
    });

    it("rejects a forged answer", async function () {
      await dno.connect(alice).proveAlive(0);
      const real = await fhevm.publicDecrypt([await dno.aliveHandle(0)]);
      const truth = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], real.abiEncodedClearValues)[0] as boolean;
      const lie = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [!truth]);
      await expect(dno.finalizeProveAlive(0, lie, real.decryptionProof)).to.be.reverted;
      expect(await dno.aliveCheck(0)).to.eq(1);
    });

    it("keeps the badge when the box is transferred", async function () {
      // Find a box that is alive; with six boxes at 70% this practically always exists.
      let certified = -1;
      for (let tokenId = 0; tokenId < 6 && certified < 0; tokenId++) {
        await dno.connect(alice).proveAlive(tokenId);
        await finalize(tokenId);
        if (await dno.vetCertified(tokenId)) certified = tokenId;
      }
      if (certified < 0) this.skip();
      await dno.connect(alice).transferFrom(alice.address, bob.address, certified);
      expect(await dno.vetCertified(certified)).to.eq(true);
    });
  });

  describe("admin", function () {
    it("lets only the owner withdraw proceeds and set the base URI", async function () {
      await dno.connect(alice).mint(2, { value: MINT_PRICE * 2n });
      await dno.connect(alice).observe(0, { value: OBSERVE_FEE });

      await expect(dno.connect(alice).withdraw(alice.address)).to.be.revertedWithCustomError(dno, "OwnableUnauthorizedAccount");
      await expect(dno.connect(deployer).withdraw(carol.address)).to.changeEtherBalance(carol, MINT_PRICE * 2n + OBSERVE_FEE);

      await expect(dno.connect(alice).setBaseURI("ipfs://x/")).to.be.revertedWithCustomError(dno, "OwnableUnauthorizedAccount");
      await dno.connect(deployer).setBaseURI("ipfs://boxes/");
      expect(await dno.tokenURI(1)).to.eq("ipfs://boxes/1");
    });
  });
});
