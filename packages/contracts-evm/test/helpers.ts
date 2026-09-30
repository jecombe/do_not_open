import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { configParamsFromSpec, type ConfigParams } from "../lib/specParams";
import { DoNotOpen, DoNotOpenConfig } from "../types";

export const FEES = {
  mint: ethers.parseEther("0.002"),
  observe: ethers.parseEther("0.0005"),
  feed: ethers.parseEther("0.0002"),
  paidShake: ethers.parseEther("0.001"),
};
export const STATE_IDS = { alive: 0, asleep: 1, ghost: 2, quantum: 3 } as const;
export const TRAIT_KEYS = ["breed", "mood", "accessory", "brokenThing", "room"] as const;

export async function deploy(overrides: Partial<ConfigParams> = {}) {
  const [deployer] = await ethers.getSigners();
  const config = (await (await ethers.getContractFactory("DoNotOpenConfig")).deploy(
    configParamsFromSpec(overrides),
  )) as unknown as DoNotOpenConfig;
  const dno = (await (await ethers.getContractFactory("DoNotOpen")).deploy(
    await config.getAddress(),
    FEES,
    deployer!.address,
  )) as unknown as DoNotOpen;
  return { config, dno, address: await dno.getAddress() };
}

/** Asserts that a decryption request is refused. */
export async function expectDenied(p: Promise<unknown>) {
  let failed = false;
  try {
    await p;
  } catch {
    failed = true;
  }
  expect(failed, "decryption should have been refused").to.eq(true);
}

/** Mock only: reads a seed straight from the local coprocessor. Impossible on a real network. */
export const peekSeed = async (dno: DoNotOpen, tokenId: number) =>
  fhevm.debugger.decryptEuint(FhevmType.euint64, await dno.seedHandle(tokenId));

export async function shakeAndDecrypt(dno: DoNotOpen, tokenId: number, who: HardhatEthersSigner, paid = false) {
  const address = await dno.getAddress();
  const tx = paid ? await dno.connect(who).paidShake(tokenId, { value: FEES.paidShake }) : await dno.connect(who).shake(tokenId);
  await tx.wait();
  const [pick, roll] = await dno.lastShake(tokenId, who.address);
  return {
    pick: Number(await fhevm.userDecryptEuint(FhevmType.euint8, pick, address, who)),
    roll: Number(await fhevm.userDecryptEuint(FhevmType.euint8, roll, address, who)),
    handles: { pick, roll },
  };
}

/** Relays the public decryption of an observed box, as any third party could. */
export async function finalizeObserve(dno: DoNotOpen, tokenId: number, sender: HardhatEthersSigner) {
  const result = await fhevm.publicDecrypt([...(await dno.observeHandles(tokenId))]);
  return dno.connect(sender).finalizeObserve(tokenId, result.abiEncodedClearValues, result.decryptionProof);
}

export async function finalizeDuel(dno: DoNotOpen, duelId: number | bigint, sender: HardhatEthersSigner) {
  const result = await fhevm.publicDecrypt([...(await dno.duelHandles(duelId))]);
  return dno.connect(sender).finalizeDuel(duelId, result.abiEncodedClearValues, result.decryptionProof);
}

export const traitByte = (seed: bigint, offset: number) => Number((seed >> BigInt(offset)) & 0xffn);
