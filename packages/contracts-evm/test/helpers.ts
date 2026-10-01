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
import { ConfidentialCroq, Croq, DoNotOpen, DoNotOpenConfig, Pantry, TestConfidentialUSDC, TestUSDC } from "../types";

/** In USDC's smallest unit: 6 decimals. */
export const usd = (amount: string) => ethers.parseUnits(amount, 6);
export const FEES = {
  mint: usd("5"),
  observe: usd("1"),
  feed: usd("0.5"),
  paidShake: usd("2.5"),
};
/** What every test signer starts with, in USDC, already approved to the collection. */
export const STARTING_USDC = usd("1000");
export const STATE_IDS = { alive: 0, asleep: 1, ghost: 2, quantum: 3 } as const;
export const TRAIT_KEYS = ["breed", "mood", "accessory", "brokenThing", "room"] as const;

export async function deploy(overrides: Partial<ConfigParams> = {}) {
  const [deployer] = await ethers.getSigners();
  const config = (await (await ethers.getContractFactory("DoNotOpenConfig")).deploy(
    configParamsFromSpec(overrides),
  )) as unknown as DoNotOpenConfig;
  const usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
  const cUsdc = (await (await ethers.getContractFactory("TestConfidentialUSDC")).deploy(
    await usdc.getAddress(),
  )) as unknown as TestConfidentialUSDC;
  const dno = (await (await ethers.getContractFactory("DoNotOpen")).deploy(
    await config.getAddress(),
    FEES,
    await usdc.getAddress(),
    await cUsdc.getAddress(),
    deployer!.address,
  )) as unknown as DoNotOpen;
  const address = await dno.getAddress();
  // Plain USDC is the default way to pay: everyone is funded and has approved the collection.
  for (const signer of (await ethers.getSigners()).slice(0, 6)) {
    await (await usdc.mint(signer.address, STARTING_USDC)).wait();
    await (await usdc.connect(signer).approve(address, ethers.MaxUint256)).wait();
  }
  return { config, dno, address, usdc, cUsdc };
}

/** Gives `who` `amount` cUSDC (wrapped from their USDC) and makes the collection their operator. */
export async function giveConfidentialUsdc(
  usdc: TestUSDC,
  cUsdc: TestConfidentialUSDC,
  dno: DoNotOpen,
  who: HardhatEthersSigner,
  amount: bigint,
) {
  await (await usdc.connect(who).approve(await cUsdc.getAddress(), amount)).wait();
  await (await cUsdc.connect(who).wrap(who.address, amount)).wait();
  const until = (await ethers.provider.getBlock("latest"))!.timestamp + 86_400;
  await (await cUsdc.connect(who).setOperator(await dno.getAddress(), until)).wait();
}

/** Relays the public decryption of an order's "paid" bit, as any third party could. */
export async function finalizeOrder(dno: DoNotOpen, orderId: number | bigint, sender: HardhatEthersSigner) {
  const [, , , , , paidHandle] = await dno.orderInfo(orderId);
  const result = await fhevm.publicDecrypt([paidHandle]);
  return dno.connect(sender).finalizeOrder(orderId, result.abiEncodedClearValues, result.decryptionProof);
}

/** `who`'s cUSDC balance, decrypted by its holder. */
export async function confidentialUsdcOf(cUsdc: TestConfidentialUSDC, who: HardhatEthersSigner) {
  const handle = await cUsdc.confidentialBalanceOf(who.address);
  if (handle === ethers.ZeroHash) return 0n;
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, await cUsdc.getAddress(), who);
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
  const tx = paid ? await dno.connect(who).paidShake(tokenId) : await dno.connect(who).shake(tokenId);
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
/** The CROQ economy next to `dno`. The deployer is the treasury unless `treasury` says otherwise. */
export async function deployEconomy(dno: DoNotOpen, overrides: Partial<PantryParams> = {}, reserve?: bigint, treasury?: string) {
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
    treasury ?? deployer!.address,
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
