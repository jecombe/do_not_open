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
 *   npx hardhat --network <net> dno:feed --token 0 --times 3
 *   npx hardhat --network <net> dno:paid-shake --token 0        (caller must not hold the box)
 *   npx hardhat --network <net> dno:entangle --a 0 --b 1         (caller must hold both)
 *   npx hardhat --network <net> dno:duel --a 0 --b 1             (caller must hold both)
 *
 * With a second account, use the contract directly: propose/accept and challenge/accept
 * are separate calls, one per holder.
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

async function shake(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number, paid = false) {
  const { dno, address, signer } = await connect(hre, args);
  console.log(`${paid ? "Paying to shake" : "Shaking"} box ${tokenId}...`);
  const tx = paid ? await dno.paidShake(tokenId, { value: await dno.paidShakeFee() }) : await dno.shake(tokenId);
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
    const result = await hre.fhevm.publicDecrypt([...(await dno.observeHandles(tokenId))]);
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
  console.log(`  duels won   : ${await dno.wins(tokenId)}`);
  const [entangled, partner] = await dno.partnerOf(tokenId);
  if (entangled) console.log(`  entangled   : with box ${partner}`);
  if (boxStatus !== 2) {
    const [mask, rolls] = await dno.publicTraitsOf(tokenId);
    const { spec } = loadSpec();
    spec.traits.forEach((t: { key: string; name: string; index: number }) => {
      if (Number(mask) & (1 << t.index)) {
        const v = resolveTrait(t.key as Parameters<typeof resolveTrait>[0], Number(rolls[t.index]));
        console.log(`  lost a duel : ${t.name} = ${v.name} (roll ${v.roll}) is now public`);
      }
    });
    console.log(`  contents    : encrypted (seed handle ${await dno.seedHandle(tokenId)})`);
    return;
  }
  const contents = await dno.contentsOf(tokenId);
  const cat = buildCatSpec({ seed: contents.seed, state: Number(contents.state) });
  console.log(`  seed        : ${cat.seed}`);
  console.log(`  state       : ${STATE_NAMES[Number(contents.state)]}`);
  for (const t of Object.values(cat.traits)) console.log(`  ${t.key.padEnd(12)}: ${t.name} (roll ${t.roll})`);
  console.log(`  affection   : ${contents.affection}${contents.golden ? " (golden accessory)" : ""}`);
  console.log(`  rarity      : ${contents.score} (${cat.rarity.tierName})`);
}

async function feed(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number, times: number) {
  const { dno } = await connect(hre, args);
  const fee = await dno.feedFee();
  console.log(`Feeding box ${tokenId} ${times} time(s) at ${hre.ethers.formatEther(fee)} ETH each...`);
  for (let i = 0; i < times; i++) {
    const tx = await dno.feed(tokenId, { value: fee });
    await tx.wait();
    console.log(`  tx ${tx.hash}`);
  }
  console.log(`  affection gained: encrypted. Each feed adds a hidden amount, possibly none.`);
}

async function entangle(hre: HardhatRuntimeEnvironment, args: TaskArguments, a: number, b: number) {
  const { dno } = await connect(hre, args);
  console.log(`Entangling boxes ${a} and ${b}...`);
  await (await dno.proposeEntangle(a, b)).wait();
  const tx = await dno.acceptEntangle(a, b);
  await tx.wait();
  console.log(`  tx ${tx.hash}`);
  console.log(`  observing either box now observes both.`);
}

async function duel(hre: HardhatRuntimeEnvironment, args: TaskArguments, a: number, b: number) {
  const { dno } = await connect(hre, args);
  console.log(`Duel: box ${a} challenges box ${b}...`);
  const duelId = await dno.duelCount();
  await (await dno.challengeDuel(a, b)).wait();
  await (await dno.acceptDuel(duelId)).wait();
  console.log(`  accepted; fetching the decrypted outcome and its KMS proof...`);
  const result = await hre.fhevm.publicDecrypt([...(await dno.duelHandles(duelId))]);
  const tx = await dno.finalizeDuel(duelId, result.abiEncodedClearValues, result.decryptionProof);
  const receipt = await tx.wait();
  const resolved = receipt!.logs.map((l) => dno.interface.parseLog(l)).find((e) => e?.name === "DuelResolved")!;
  const [, winner, loser, traitIndex, roll] = resolved.args;
  const { spec } = loadSpec();
  const trait = spec.traits.find((t: { index: number }) => t.index === Number(traitIndex));
  const variant = resolveTrait(trait.key, Number(roll));
  console.log(`  finalised in tx ${tx.hash}`);
  console.log(`  winner: box ${winner}. Box ${loser} lost and must show: ${trait.name} = ${variant.name} (roll ${roll})`);
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

withAddress("dno:feed", "Feeds a sealed box")
  .addParam("token", "Token id")
  .addOptionalParam("times", "How many feeds", "1")
  .setAction(async (args, hre) => feed(hre, args, tokenOf(args), Number(args.times)));

withAddress("dno:paid-shake", "Pays to shake a box you do not hold and privately decrypts the result")
  .addParam("token", "Token id")
  .setAction(async (args, hre) => shake(hre, args, tokenOf(args), true));

withAddress("dno:entangle", "Entangles two boxes held by the caller")
  .addParam("a", "First token id")
  .addParam("b", "Second token id")
  .setAction(async (args, hre) => entangle(hre, args, Number(args.a), Number(args.b)));

withAddress("dno:duel", "Runs a duel between two boxes held by the caller: challenge, accept, finalise")
  .addParam("a", "Challenger token id")
  .addParam("b", "Challenged token id")
  .setAction(async (args, hre) => duel(hre, args, Number(args.a), Number(args.b)));

withAddress("dno:demo2", "Phase 3 walkthrough: mint 3, feed, duel, entangle, observe one and see both open").setAction(
  async (args, hre) => {
    const [a, b, c] = await mint(hre, args, 3);
    console.log("");
    await feed(hre, args, a!, 3);
    console.log("");
    await duel(hre, args, a!, b!);
    console.log("");
    await entangle(hre, args, a!, c!);
    console.log("");
    await observe(hre, args, a!);
    console.log("");
    // The entangled partner is already in "observing"; this only relays its decryption.
    await observe(hre, args, c!);
    console.log("");
    await status(hre, args, b!);
  },
);

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
