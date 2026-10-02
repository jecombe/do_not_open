import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import type { ContractTransactionReceipt, Log } from "ethers";
import { ethers, fhevm } from "hardhat";
import {
  configParamsFromSpec,
  economyFromSpec,
  milestonesFromSpec,
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
/** What every test signer starts with, in cUSDC, with the collection already an operator. */
export const STARTING_CUSDC = usd("1000");
export const STATE_IDS = { alive: 0, asleep: 1, ghost: 2, quantum: 3 } as const;
export const TRAIT_KEYS = ["breed", "mood", "accessory", "brokenThing", "room"] as const;
export const NOT_YOURS = 255;
/** RequestStatus in the contract. */
export const REQUEST = { None: 0, Pending: 1, Done: 2, Refused: 3 } as const;

/**
 * DoNotOpen with local USDC and cUSDC. Signers 0-7 each hold `STARTING_CUSDC` and have made the
 * collection their cUSDC operator; signer 9 holds nothing. With a smaller `maxSupply` and no
 * `milestones`, the only milestone is the cap.
 */
export async function deploy(overrides: Partial<ConfigParams> = {}, milestones?: number[]) {
  const [deployer] = await ethers.getSigners();
  const params = configParamsFromSpec(overrides);
  const config = (await (await ethers.getContractFactory("DoNotOpenConfig")).deploy(params)) as unknown as DoNotOpenConfig;
  const usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
  const cUsdc = (await (await ethers.getContractFactory("TestConfidentialUSDC")).deploy(
    await usdc.getAddress(),
  )) as unknown as TestConfidentialUSDC;
  const steps = milestones ?? (overrides.maxSupply ? [overrides.maxSupply] : milestonesFromSpec());
  const dno = (await (await ethers.getContractFactory("DoNotOpen")).deploy(
    await config.getAddress(),
    FEES,
    await usdc.getAddress(),
    await cUsdc.getAddress(),
    steps,
    deployer!.address,
  )) as unknown as DoNotOpen;
  for (const signer of (await ethers.getSigners()).slice(0, 8)) {
    await giveConfidentialUsdc(usdc, cUsdc, dno, signer, STARTING_CUSDC);
  }
  return { config, dno, address: await dno.getAddress(), usdc, cUsdc };
}

/** Wraps `amount` USDC (minted if needed) into `who`'s cUSDC and makes the collection their operator for a year. */
export async function giveConfidentialUsdc(
  usdc: TestUSDC,
  cUsdc: TestConfidentialUSDC,
  dno: DoNotOpen,
  who: HardhatEthersSigner,
  amount: bigint,
) {
  if ((await usdc.balanceOf(who.address)) < amount) await (await usdc.mint(who.address, amount)).wait();
  await (await usdc.connect(who).approve(await cUsdc.getAddress(), amount)).wait();
  await (await cUsdc.connect(who).wrap(who.address, amount)).wait();
  const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * 86_400;
  await (await cUsdc.connect(who).setOperator(await dno.getAddress(), until)).wait();
}

/** `who`'s cUSDC balance, decrypted by its holder. */
export async function confidentialUsdcOf(cUsdc: TestConfidentialUSDC, who: HardhatEthersSigner) {
  const handle = await cUsdc.confidentialBalanceOf(who.address);
  if (handle === ethers.ZeroHash) return 0n;
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, await cUsdc.getAddress(), who);
}

export const parseEvents = (dno: DoNotOpen, logs: readonly Log[], name: string) =>
  logs
    .filter((l) => l.address.toLowerCase() === (dno.target as string).toLowerCase())
    .map((l) => dno.interface.parseLog(l))
    .filter((e) => e?.name === name)
    .map((e) => e!.args);

/**
 * Buys `quantity` boxes the way the app does: the quantity encrypted in the page, hidden among
 * `ids` token ids. Returns the ids the mint created and the ones `who` really got, read from
 * their receipts.
 */
export async function mintBoxes(dno: DoNotOpen, who: HardhatEthersSigner, quantity: number, ids = 10) {
  const address = await dno.getAddress();
  const input = await fhevm.createEncryptedInput(address, who.address).add8(quantity).encrypt();
  const receipt = (await (await dno.connect(who).mint(input.handles[0]!, input.inputProof, ids)).wait())!;
  const [placed] = parseEvents(dno, receipt.logs, "MintPlaced");
  const first = Number(placed!.firstTokenId);
  const created = Array.from({ length: Number(placed!.count) }, (_, i) => first + i);
  const owned: number[] = [];
  for (const t of parseEvents(dno, receipt.logs, "ConfidentialTransfer")) {
    if (await fhevm.userDecryptEbool(t.moved, address, who)) owned.push(Number(t.tokenId));
  }
  const got = Number(await fhevm.userDecryptEuint(FhevmType.euint8, placed!.quantity, address, who));
  return { receipt, first, created, owned, quantity: got };
}

/** Mock only: who really holds a box, read straight from the local coprocessor. */
export async function ownerOf(dno: DoNotOpen, tokenId: number | bigint) {
  return ethers.getAddress(await fhevm.debugger.decryptEaddress(await dno.confidentialOwnerOf(tokenId)));
}

/**
 * What the app does to find an account's boxes: read the transfers where it is `from` or `to`,
 * decrypt each "moved" bit (only the two sides can), and replay them in order.
 */
export async function holdings(nft: DoNotOpen, who: HardhatEthersSigner) {
  const address = await nft.getAddress();
  const filter = nft.filters.ConfidentialTransfer;
  const logs = [
    ...(await nft.queryFilter(filter(undefined, who.address, undefined))),
    ...(await nft.queryFilter(filter(undefined, undefined, who.address))),
  ].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  const seen = new Set<string>();
  const held = new Set<number>();
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { tokenId, from, to, moved } = log.args;
    if (!(await fhevm.userDecryptEbool(moved, address, who))) continue;
    if (from.toLowerCase() === who.address.toLowerCase()) held.delete(Number(tokenId));
    if (to.toLowerCase() === who.address.toLowerCase()) held.add(Number(tokenId));
  }
  return [...held].sort((a, b) => a - b);
}

/** The id of the request a transaction placed. */
export function requestIdOf(dno: DoNotOpen, receipt: ContractTransactionReceipt | null) {
  return parseEvents(dno, receipt!.logs, "RequestPlaced")[0]!.requestId as bigint;
}

/** Relays the public decryption of a request, as any third party could. */
export async function finalizeRequest(dno: DoNotOpen, requestId: bigint, sender: HardhatEthersSigner) {
  const [, , , , , handles] = await dno.requestInfo(requestId);
  const result = await fhevm.publicDecrypt([...handles]);
  return dno.connect(sender).finalize(requestId, result.abiEncodedClearValues, result.decryptionProof);
}

/** Opens a box in its two steps. Returns the request's final status. */
export async function open(dno: DoNotOpen, tokenId: number, holder: HardhatEthersSigner, relay: HardhatEthersSigner) {
  const id = requestIdOf(dno, await (await dno.connect(holder).observe(tokenId)).wait());
  await (await finalizeRequest(dno, id, relay)).wait();
  return Number((await dno.requestInfo(id))[1]);
}

/** Asks for an alive check and relays it. Returns the request's final status. */
export async function proveAlive(dno: DoNotOpen, tokenId: number, holder: HardhatEthersSigner, relay: HardhatEthersSigner) {
  const id = requestIdOf(dno, await (await dno.connect(holder).proveAlive(tokenId)).wait());
  await (await finalizeRequest(dno, id, relay)).wait();
  return Number((await dno.requestInfo(id))[1]);
}

/** Relays the current step of a duel: the holding proof after posting, the outcome after acceptance. */
export async function finalizeDuel(dno: DoNotOpen, duelId: number | bigint, sender: HardhatEthersSigner) {
  const result = await fhevm.publicDecrypt([...(await dno.duelHandles(duelId))]);
  return dno.connect(sender).finalizeDuel(duelId, result.abiEncodedClearValues, result.decryptionProof);
}

/** DuelStatus in the contract. */
export const DUEL = { None: 0n, Posted: 1n, Open: 2n, Pending: 3n, Resolved: 4n, Cancelled: 5n, Void: 6n } as const;

/** Puts `tokenId` up for a duel, open to all or reserved for `forTokenId`, and relays the holding proof. Returns the duel id. */
export async function postDuel(dno: DoNotOpen, tokenId: number, challenger: HardhatEthersSigner, relay: HardhatEthersSigner, forTokenId?: number) {
  const duelId = await dno.duelCount();
  await (await dno.connect(challenger).postDuel(tokenId, forTokenId ?? 0, forTokenId !== undefined)).wait();
  await (await finalizeDuel(dno, duelId, relay)).wait();
  return duelId;
}

/** Announces the next milestone if the last mint reached it. Returns whether it did. */
export async function announce(dno: DoNotOpen, sender: HardhatEthersSigner) {
  const handle = await dno.milestoneHandle();
  if (handle === ethers.ZeroHash) return false;
  const result = await fhevm.publicDecrypt([handle]);
  const [reached] = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], result.abiEncodedClearValues);
  if (!reached) return false;
  await (await dno.connect(sender).announceMilestone(result.abiEncodedClearValues, result.decryptionProof)).wait();
  return true;
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

export const traitByte = (seed: bigint, offset: number) => Number((seed >> BigInt(offset)) & 0xffn);

/** The CROQ economy next to `dno`, trusted to read ownership. The deployer is the treasury unless `treasury` says otherwise. */
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
  await (await dno.connect(deployer).setTrustedReader(await pantry.getAddress(), true)).wait();
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
