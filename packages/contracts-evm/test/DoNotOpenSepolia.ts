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
  let tokenId: number;

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

  it("buys a hidden box with cUSDC, finds it in its receipts, and shakes it", async function () {
    this.timeout(8 * 60_000);
    const [holder] = await ethers.getSigners();
    const price = await dno.mintPrice();
    const usdc = await ethers.getContractAt("TestUSDC", await dno.usdc());
    const cUsdc = await ethers.getContractAt("TestConfidentialUSDC", await dno.confidentialUsdc());
    if ((await usdc.balanceOf(holder!.address)) < price) await (await usdc.mint(holder!.address, price)).wait();
    await (await usdc.approve(await cUsdc.getAddress(), price)).wait();
    await (await cUsdc.wrap(holder!.address, price)).wait();
    await (await cUsdc.setOperator(address, Math.floor(Date.now() / 1000) + 86_400)).wait();

    const input = await fhevm.createEncryptedInput(address, holder!.address).add8(1).encrypt();
    const receipt = await (await dno.mint(input.handles[0]!, input.inputProof, 3)).wait();
    const transfers = receipt!.logs.map((l) => dno.interface.parseLog(l)).filter((e) => e?.name === "ConfidentialTransfer");
    expect(transfers).to.have.length(3);
    const owned = [];
    for (const t of transfers) if (await fhevm.userDecryptEbool(t!.args.moved, address, holder!)) owned.push(Number(t!.args.tokenId));
    expect(owned).to.have.length(1);
    tokenId = owned[0]!;

    await (await dno.shake(tokenId)).wait();
    const [pick, roll] = await dno.lastShake(tokenId, holder!.address);
    expect([16, 24, 32, 40, 48]).to.include(Number(await fhevm.userDecryptEuint(FhevmType.euint8, pick, address, holder!)));
    expect(Number(await fhevm.userDecryptEuint(FhevmType.euint8, roll, address, holder!))).to.be.within(0, 255);
  });

  it("proves alive through a real public decryption", async function () {
    this.timeout(8 * 60_000);
    const receipt = await (await dno.proveAlive(tokenId)).wait();
    const requestId = receipt!.logs.map((l) => dno.interface.parseLog(l)).find((e) => e?.name === "RequestPlaced")!.args.requestId;
    const [, , , , , handles] = await dno.requestInfo(requestId);
    const result = await fhevm.publicDecrypt([...handles]);
    await (await dno.finalize(requestId, result.abiEncodedClearValues, result.decryptionProof)).wait();
    expect(Number(await dno.aliveCheck(tokenId))).to.be.oneOf([1, 2]);
    expect(await dno.status(tokenId)).to.eq(0);
  });
});
