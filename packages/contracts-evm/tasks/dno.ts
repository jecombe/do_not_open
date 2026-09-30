import { FhevmType } from "@fhevm/hardhat-plugin";
import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";
import { buildCatSpec, resolveTrait } from "@dno/generator";
import { loadSpec } from "../lib/specParams";

/**
 * CLI for DO NOT OPEN. Works the same on a local node and on Sepolia.
 *
 * Local:
 *   pnpm chain                      (terminal 1)
 *   pnpm deploy:localhost           (terminal 2)
 *   pnpm demo:localhost
 *
 * Sepolia (needs MNEMONIC or PRIVATE_KEY and SEPOLIA_RPC_URL in .env):
 *   pnpm deploy:sepolia
 *   pnpm demo:sepolia
 *
 * Single steps:
 *   npx hardhat --network <net> dno:mint --quantity 2
 *   npx hardhat --network <net> dno:shake --token 0
 *   npx hardhat --network <net> dno:prove-alive --token 0
 *   npx hardhat --network <net> dno:observe --token 0
 *   npx hardhat --network <net> dno:status --token 0
 */

const STATE_NAMES = ["Alive", "Asleep", "Ghost", "Quantum"];
const ALIVE_CHECK = ["not requested", "pending", "alive (Vet Certified)", "not alive"];
const BOX_STATUS = ["sealed", "observing", "revealed"];

async function connect(hre: HardhatRuntimeEnvironment, args: TaskArguments) {
  const { ethers, deployments, fhevm } = hre;
  await fhevm.initializeCLIApi();
  const address: string = args.address ?? (await deployments.get("DoNotOpen")).address;
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No account configured. Set MNEMONIC or PRIVATE_KEY in .env (see .env.example).");
  const dno = await ethers.getContractAt("DoNotOpen", address, signer);
  return { dno, address, signer };
}

const tokenOf = (args: TaskArguments): number => {
  const id = Number(args.token);
  if (!Number.isInteger(id) || id < 0) throw new Error("--token must be a token id");
  return id;
};

/** Trait key stored at a given bit offset of the seed, per the game spec. */
function traitAtOffset(offset: number): { key: string; name: string } {
  const { spec } = loadSpec();
  const slice = spec.seed.layout.find((l: { offset: number }) => l.offset === offset);
  const trait = spec.traits.find((t: { key: string }) => t.key === slice?.field);
  if (!trait) throw new Error(`no trait at seed offset ${offset}`);
  return trait;
}

async function mint(hre: HardhatRuntimeEnvironment, args: TaskArguments, quantity: number) {
  const { dno, signer } = await connect(hre, args);
  const price = await dno.mintPrice();
  const first = Number(await dno.totalMinted());
  console.log(`Minting ${quantity} box(es) to ${signer.address} for ${hre.ethers.formatEther(price * BigInt(quantity))} ETH...`);
  const tx = await dno.mint(quantity, { value: price * BigInt(quantity) });
  const receipt = await tx.wait();
  const ids = Array.from({ length: quantity }, (_, i) => first + i);
  console.log(`  tx ${tx.hash} (gas ${receipt?.gasUsed})`);
  console.log(`  minted token ids: ${ids.join(", ")}`);
  return ids;
}

async function shake(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number) {
  const { dno, address, signer } = await connect(hre, args);
  console.log(`Shaking box ${tokenId}...`);
  const tx = await dno.shake(tokenId);
  await tx.wait();
  const [pickHandle, rollHandle] = await dno.lastShake(tokenId, signer.address);
  console.log(`  tx ${tx.hash}`);
  console.log(`  decrypting privately as ${signer.address}...`);
  const pick = Number(await hre.fhevm.userDecryptEuint(FhevmType.euint8, pickHandle, address, signer));
  const roll = Number(await hre.fhevm.userDecryptEuint(FhevmType.euint8, rollHandle, address, signer));
  const trait = traitAtOffset(pick);
  const variant = resolveTrait(trait.key as Parameters<typeof resolveTrait>[0], roll);
  console.log(`  you felt something: ${trait.name} = ${variant.name} (roll ${roll})`);
}

async function proveAlive(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number) {
  const { dno } = await connect(hre, args);
  if (Number(await dno.aliveCheck(tokenId)) === 0) {
    console.log(`Requesting the alive check for box ${tokenId}...`);
    const tx = await dno.proveAlive(tokenId);
    await tx.wait();
    console.log(`  tx ${tx.hash}`);
  }
  if (Number(await dno.aliveCheck(tokenId)) === 1) {
    console.log(`  fetching the decrypted bit and its KMS proof...`);
    const result = await hre.fhevm.publicDecrypt([await dno.aliveHandle(tokenId)]);
    const tx = await dno.finalizeProveAlive(tokenId, result.abiEncodedClearValues, result.decryptionProof);
    await tx.wait();
    console.log(`  finalised in tx ${tx.hash}`);
  }
  console.log(`  alive check: ${ALIVE_CHECK[Number(await dno.aliveCheck(tokenId))]}`);
}

async function observe(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number) {
  const { dno } = await connect(hre, args);
  if (Number(await dno.status(tokenId)) === 0) {
    const fee = await dno.observeFee();
    console.log(`Observing box ${tokenId} (irreversible, fee ${hre.ethers.formatEther(fee)} ETH)...`);
    const tx = await dno.observe(tokenId, { value: fee });
    await tx.wait();
    console.log(`  tx ${tx.hash}`);
  }
  if (Number(await dno.status(tokenId)) === 1) {
    console.log(`  fetching the decrypted seed and its KMS proof...`);
    const result = await hre.fhevm.publicDecrypt([await dno.seedHandle(tokenId)]);
    const tx = await dno.finalizeObserve(tokenId, result.abiEncodedClearValues, result.decryptionProof);
    await tx.wait();
    console.log(`  finalised in tx ${tx.hash}`);
  }
  await status(hre, args, tokenId);
}

async function status(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number) {
  const { dno } = await connect(hre, args);
  const boxStatus = Number(await dno.status(tokenId));
  console.log(`Box ${tokenId}`);
  console.log(`  holder      : ${await dno.ownerOf(tokenId)}`);
  console.log(`  status      : ${BOX_STATUS[boxStatus]}`);
  console.log(`  alive check : ${ALIVE_CHECK[Number(await dno.aliveCheck(tokenId))]}`);
  if (boxStatus !== 2) {
    console.log(`  contents    : encrypted (seed handle ${await dno.seedHandle(tokenId)})`);
    return;
  }
  const contents = await dno.contentsOf(tokenId);
  const cat = buildCatSpec({ seed: contents.seed, state: Number(contents.state) });
  console.log(`  seed        : ${cat.seed}`);
  console.log(`  state       : ${STATE_NAMES[Number(contents.state)]}`);
  for (const t of Object.values(cat.traits)) console.log(`  ${t.key.padEnd(12)}: ${t.name} (roll ${t.roll})`);
  console.log(`  rarity      : ${contents.score} (${cat.rarity.tierName})`);
}

const withAddress = (name: string, description: string) =>
  task(name, description).addOptionalParam("address", "DoNotOpen address (defaults to the last deployment)");

withAddress("dno:address", "Prints the deployed DoNotOpen address").setAction(async (args, hre) => {
  const { dno, address } = await connect(hre, args);
  console.log(`DoNotOpen: ${address}  (minted ${await dno.totalMinted()} / ${await dno.maxSupply()})`);
});

withAddress("dno:mint", "Mints sealed boxes")
  .addOptionalParam("quantity", "How many boxes", "1")
  .setAction(async (args, hre) => {
    await mint(hre, args, Number(args.quantity));
  });

withAddress("dno:shake", "Shakes a box and privately decrypts the one trait it reveals")
  .addParam("token", "Token id")
  .setAction(async (args, hre) => shake(hre, args, tokenOf(args)));

withAddress("dno:prove-alive", "Publicly proves whether the cat is alive, revealing nothing else")
  .addParam("token", "Token id")
  .setAction(async (args, hre) => proveAlive(hre, args, tokenOf(args)));

withAddress("dno:observe", "Opens a box for good: request, public decryption, finalise")
  .addParam("token", "Token id")
  .setAction(async (args, hre) => observe(hre, args, tokenOf(args)));

withAddress("dno:status", "Shows what is public about a box")
  .addParam("token", "Token id")
  .setAction(async (args, hre) => status(hre, args, tokenOf(args)));

withAddress("dno:demo", "Full walkthrough: mint, shake twice, prove alive, observe").setAction(async (args, hre) => {
  const [tokenId] = await mint(hre, args, 1);
  console.log("");
  await status(hre, args, tokenId!);
  console.log("");
  await shake(hre, args, tokenId!);
  await shake(hre, args, tokenId!);
  console.log("");
  await proveAlive(hre, args, tokenId!);
  console.log("");
  await observe(hre, args, tokenId!);
});
