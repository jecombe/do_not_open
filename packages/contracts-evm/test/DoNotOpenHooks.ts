import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { DoNotOpenHooks } from "../types";
import { deploy, finalizeRequest, mintBoxes, open, requestIdOf } from "./helpers";

describe("DoNotOpenHooks", function () {
  let alice: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  before(async function () {
    [, alice, , carol] = (await ethers.getSigners()) as HardhatEthersSigner[] as [
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
    ];
  });

  it("refuses a sale whose box changed in escrow, and other collections", async function () {
    if (!fhevm.isMock) this.skip();
    const { dno, address } = await deploy();
    const hooks = (await (await ethers.getContractFactory("DoNotOpenHooks")).deploy(address)) as unknown as DoNotOpenHooks;
    const [a, b] = (await mintBoxes(dno, alice, 2)).owned as [number, number];

    const snapshot = await hooks.beforeList(address, a, alice.address, carol.address);
    await hooks.beforeSettle(address, a, alice.address, carol.address, snapshot);
    await expect(hooks.beforeList(carol.address, a, alice.address, carol.address)).to.be.revertedWithCustomError(hooks, "WrongCollection");

    // Entangled, then its partner opened: both boxes changed.
    await dno.connect(alice).proposeEntangle(a, b);
    await (await finalizeRequest(dno, requestIdOf(dno, await (await dno.connect(alice).acceptEntangle(a, b)).wait()), carol)).wait();
    await expect(hooks.beforeSettle(address, a, alice.address, carol.address, snapshot)).to.be.revertedWithCustomError(hooks, "StateChanged");
    const linked = await hooks.beforeList(address, a, alice.address, carol.address);
    await open(dno, b, alice, carol);
    await expect(hooks.beforeSettle(address, a, alice.address, carol.address, linked)).to.be.revertedWithCustomError(hooks, "StateChanged");
  });
});
