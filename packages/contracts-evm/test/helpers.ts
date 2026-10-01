import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import {
  configParamsFromSpec,
  economyFromSpec,
  pantryParamsFromSpec,
  type ConfigParams,
  type PantryParams,
} from "../lib/specParams";
import { ConfidentialCroq, Croq, DoNotOpen, DoNotOpenConfig, Pantry } from "../types";

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

/** Croq, its confidential wrapper and a Pantry around `dno`, with the reserve funded. */
export async function deployEconomy(dno: DoNotOpen, overrides: Partial<PantryParams> = {}, reserve?: bigint) {
  const [deployer] = await ethers.getSigners();
  const { totalSupply, allocation } = economyFromSpec();
  const croq = (await (await ethers.getContractFactory("Croq")).deploy(totalSupply, deployer!.address)) as unknown as Croq;
  const cCroq = (await (await ethers.getContractFactory("ConfidentialCroq")).deploy(
    await croq.getAddress(),
    "",
  )) as unknown as ConfidentialCroq;
  const pantry = (await (await ethers.getContractFactory("Pantry")).deploy(
    await dno.getAddress(),
    await cCroq.getAddress(),
    pantryParamsFromSpec(overrides),
  )) as unknown as Pantry;
  const funded = reserve ?? allocation.gameReserve + allocation.welcomeBags;
  if (funded > 0n) {
    await (await croq.approve(await pantry.getAddress(), funded)).wait();
    await (await pantry.fund(funded)).wait();
  }
  return {
    croq,
    cCroq,
    pantry,
    croqAddress: await croq.getAddress(),
    cCroqAddress: await cCroq.getAddress(),
    pantryAddress: await pantry.getAddress(),
  };
}

/** Gives `who` `amount` cCROQ: plain CROQ from the deployer, wrapped by `who`. */
export async function giveCroquettes(croq: Croq, cCroq: ConfidentialCroq, who: HardhatEthersSigner, amount: bigint) {
  await (await croq.transfer(who.address, amount)).wait();
  await (await croq.connect(who).approve(await cCroq.getAddress(), amount)).wait();
  await (await cCroq.connect(who).wrap(who.address, amount)).wait();
}

/** `who`'s cCROQ balance, decrypted the way the app does it: by the holder, for the holder. */
export async function balanceOf(cCroq: ConfidentialCroq, who: HardhatEthersSigner) {
  const handle = await cCroq.confidentialBalanceOf(who.address);
  if (handle === ethers.ZeroHash) return 0n;
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, await cCroq.getAddress(), who);
}

/** Mock only: reads any euint64 straight from the local coprocessor. */
export const peek64 = async (handle: string) =>
  handle === ethers.ZeroHash ? 0n : fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
