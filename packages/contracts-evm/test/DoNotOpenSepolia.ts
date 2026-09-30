import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { deployments, ethers, fhevm } from "hardhat";
import { DoNotOpen } from "../types";

/**
 * Optional integration test against the real Zama coprocessor and KMS.
 * Run with `pnpm test:sepolia` after `pnpm deploy:sepolia`. Spends a little Sepolia ETH.
 */
describe("DoNotOpen on Sepolia", function () {
  let dno: DoNotOpen;
  let address: string;

  before(async function () {
    if (fhevm.isMock) this.skip();
    try {
      address = (await deployments.get("DoNotOpen")).address;
    } catch (e) {
      (e as Error).message += ". Run 'pnpm deploy:sepolia' first.";
      throw e;
    }
    dno = (await ethers.getContractAt("DoNotOpen", address)) as unknown as DoNotOpen;
  });

  it("mints a box, shakes it and privately decrypts one trait", async function () {
    this.timeout(6 * 60_000);
    const [holder] = await ethers.getSigners();
    const tokenId = await dno.totalMinted();

    await (await dno.mint(1, { value: await dno.mintPrice() })).wait();
    expect(await dno.ownerOf(tokenId)).to.eq(holder!.address);

    await (await dno.shake(tokenId)).wait();
    const [pick, roll] = await dno.lastShake(tokenId, holder!.address);
    const clearPick = Number(await fhevm.userDecryptEuint(FhevmType.euint8, pick, address, holder!));
    const clearRoll = Number(await fhevm.userDecryptEuint(FhevmType.euint8, roll, address, holder!));

    expect([16, 24, 32, 40, 48]).to.include(clearPick);
    expect(clearRoll).to.be.within(0, 255);
  });

  it("proves alive through a real public decryption", async function () {
    this.timeout(6 * 60_000);
    const tokenId = (await dno.totalMinted()) - 1n;

    await (await dno.proveAlive(tokenId)).wait();
    const result = await fhevm.publicDecrypt([await dno.aliveHandle(tokenId)]);
    await (await dno.finalizeProveAlive(tokenId, result.abiEncodedClearValues, result.decryptionProof)).wait();

    expect(Number(await dno.aliveCheck(tokenId))).to.be.oneOf([2, 3]);
    expect(await dno.status(tokenId)).to.eq(0);
  });
});
