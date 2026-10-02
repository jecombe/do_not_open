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
 *   npx hardhat --network <net> dno:mint --quantity 2 --ids 10
 *   npx hardhat --network <net> dno:shake --token 0
 *   npx hardhat --network <net> dno:prove-alive --token 0
 *   npx hardhat --network <net> dno:observe --token 0
 *   npx hardhat --network <net> dno:status --token 0
 *   npx hardhat --network <net> dno:feed --token 0 --times 3
 *   npx hardhat --network <net> dno:paid-shake --token 0        (caller must not hold the box)
 *   npx hardhat --network <net> dno:entangle --a 0 --b 1         (caller must hold both)
 *   npx hardhat --network <net> dno:duel --a 0 --b 1             (caller must hold both)
 *   npx hardhat --network <net> dno:credit-price --zama 0.001 --margin 2   (owner: credits follow Zama's plan)
 *
 * With a second account, use the contract directly: propose/accept and challenge/accept
 * are separate calls, one per holder.
 *
 * Who holds a box is encrypted: the tasks find the signer's boxes in their own transfer
 * receipts, and a step taken on a box the signer does not hold does nothing.
 */

const STATE_NAMES = ["Alive", "Asleep", "Ghost", "Quantum"];
const ALIVE_CHECK = ["not requested", "alive (Vet Certified)", "not alive"];
const BOX_STATUS = ["sealed", "revealed"];
const REQUEST_STATUS = ["none", "pending", "done", "refused: the caller did not hold the box"];

async function connect(hre: HardhatRuntimeEnvironment, args: TaskArguments) {
  const { ethers, deployments, fhevm } = hre;
  await fhevm.initializeCLIApi();
  const address: string = args.address ?? (await deployments.get("DoNotOpen")).address;
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No account configured. Set MNEMONIC or PRIVATE_KEY in .env (see .env.example).");
  const dno = await ethers.getContractAt("DoNotOpen", address, signer);
  return { dno, address, signer };
}

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function mint(address, uint256)",
];
const CUSDC_ABI = [
  "function wrap(address, uint256)",
  "function isOperator(address, address) view returns (bool)",
  "function setOperator(address, uint48)",
];
const usd = (hre: HardhatRuntimeEnvironment, amount: bigint) => `${hre.ethers.formatUnits(amount, 6)} USDC`;

/**
 * Makes sure the signer can pay `amount` in cUSDC: mints test USDC (USDCMock on Sepolia,
 * TestUSDC locally), wraps it, and makes the collection an operator. A balance already there is
 * not read (it is encrypted), so this wraps the whole amount each time.
 */
async function ensureConfidentialUsdc(hre: HardhatRuntimeEnvironment, args: TaskArguments, amount: bigint) {
  const { dno, address, signer } = await connect(hre, args);
  const usdc = new hre.ethers.Contract(await dno.usdc(), USDC_ABI, signer);
  const cUsdcAddress = await dno.confidentialUsdc();
  const cUsdc = new hre.ethers.Contract(cUsdcAddress, CUSDC_ABI, signer);
  const balance: bigint = await usdc.balanceOf!(signer.address);
  if (balance < amount) {
    console.log(`  minting ${usd(hre, amount - balance)} of test USDC...`);
    await (await usdc.mint!(signer.address, amount - balance)).wait();
  }
  console.log(`  wrapping ${usd(hre, amount)} into cUSDC...`);
  await (await usdc.approve!(cUsdcAddress, amount)).wait();
  await (await cUsdc.wrap!(signer.address, amount)).wait();
  if (!(await cUsdc.isOperator!(signer.address, address))) {
    const until = Math.floor(Date.now() / 1000) + 365 * 86_400;
    await (await cUsdc.setOperator!(address, until)).wait();
  }
}

/** Sends the decrypted values of a request with their proof, and prints how it settled. */
async function finalizeRequest(hre: HardhatRuntimeEnvironment, args: TaskArguments, requestId: bigint) {
  const { dno } = await connect(hre, args);
  console.log(`  fetching the decrypted values and their KMS proof...`);
  const [, , , , , handles] = await dno.requestInfo(requestId);
  const result = await hre.fhevm.publicDecrypt([...handles]);
  const tx = await dno.finalize(requestId, result.abiEncodedClearValues, result.decryptionProof);
  await tx.wait();
  console.log(`  finalised in tx ${tx.hash}: ${REQUEST_STATUS[Number((await dno.requestInfo(requestId))[1])]}`);
}

const requestIdOf = (dno: Awaited<ReturnType<typeof connect>>["dno"], logs: readonly import("ethers").Log[]) =>
  logs.map((l) => dno.interface.parseLog(l)).find((e) => e?.name === "RequestPlaced")!.args.requestId as bigint;

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

async function mint(hre: HardhatRuntimeEnvironment, args: TaskArguments, quantity: number, ids = 10) {
  const { dno, address, signer } = await connect(hre, args);
  const price = await dno.mintPrice();
  console.log(`Minting ${quantity} box(es) among ${ids} ids to ${signer.address} for ${usd(hre, price * BigInt(quantity))}...`);
  await ensureConfidentialUsdc(hre, args, price * BigInt(quantity));
  const input = await hre.fhevm.createEncryptedInput(address, signer.address).add8(quantity).encrypt();
  const tx = await dno.mint(input.handles[0]!, input.inputProof, ids);
  const receipt = await tx.wait();
  console.log(`  tx ${tx.hash} (gas ${receipt?.gasUsed})`);
  // The receipts say which of the new ids are the signer's: only the signer can read them.
  const owned: number[] = [];
  for (const e of receipt!.logs.map((l) => dno.interface.parseLog(l))) {
    if (e?.name !== "ConfidentialTransfer") continue;
    if (await hre.fhevm.userDecryptEbool(e.args.moved, address, signer)) owned.push(Number(e.args.tokenId));
  }
  console.log(`  your boxes: ${owned.join(", ") || "none (sold out, or not enough cUSDC)"}`);
  return owned;
}

async function shake(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number, paid = false) {
  const { dno, address, signer } = await connect(hre, args);
  console.log(`${paid ? "Paying to shake" : "Shaking"} box ${tokenId}...`);
  if (paid) await ensureConfidentialUsdc(hre, args, await dno.paidShakeFee());
  const tx = paid ? await dno.paidShake(tokenId) : await dno.shake(tokenId);
  await tx.wait();
  const [pickHandle, rollHandle] = await dno.lastShake(tokenId, signer.address);
  console.log(`  tx ${tx.hash}`);
  console.log(`  decrypting privately as ${signer.address}...`);
  const pick = Number(await hre.fhevm.userDecryptEuint(FhevmType.euint8, pickHandle, address, signer));
  const roll = Number(await hre.fhevm.userDecryptEuint(FhevmType.euint8, rollHandle, address, signer));
  if (pick === Number(await dno.NOT_YOURS())) {
    console.log(`  nothing: you do not hold this box${paid ? ", or the fee did not go through" : ""}.`);
    return;
  }
  const trait = traitAtOffset(pick);
  const variant = resolveTrait(trait.key as Parameters<typeof resolveTrait>[0], roll);
  console.log(`  you felt something: ${trait.name} = ${variant.name} (roll ${roll})`);
}

async function proveAlive(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number) {
  const { dno } = await connect(hre, args);
  console.log(`Requesting the alive check for box ${tokenId}...`);
  const receipt = await (await dno.proveAlive(tokenId)).wait();
  await finalizeRequest(hre, args, requestIdOf(dno, receipt!.logs));
  console.log(`  alive check: ${ALIVE_CHECK[Number(await dno.aliveCheck(tokenId))]}`);
}

async function observe(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number) {
  const { dno } = await connect(hre, args);
  if (Number(await dno.status(tokenId)) === 0) {
    const fee = await dno.observeFee();
    console.log(`Observing box ${tokenId} (irreversible, fee ${usd(hre, fee)})...`);
    await ensureConfidentialUsdc(hre, args, fee);
    const receipt = await (await dno.observe(tokenId)).wait();
    await finalizeRequest(hre, args, requestIdOf(dno, receipt!.logs));
  }
  await status(hre, args, tokenId);
}

async function status(hre: HardhatRuntimeEnvironment, args: TaskArguments, tokenId: number) {
  const { dno } = await connect(hre, args);
  const boxStatus = Number(await dno.status(tokenId));
  console.log(`Box ${tokenId}`);
  console.log(`  holder      : encrypted`);
  console.log(`  status      : ${BOX_STATUS[boxStatus]}`);
  console.log(`  alive check : ${ALIVE_CHECK[Number(await dno.aliveCheck(tokenId))]}`);
  console.log(`  duels won   : ${await dno.wins(tokenId)}`);
  const [entangled, partner] = await dno.partnerOf(tokenId);
  if (entangled) console.log(`  entangled   : with box ${partner}`);
  if (boxStatus !== 1) {
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
  console.log(`Feeding box ${tokenId} ${times} time(s) at ${usd(hre, fee)} each...`);
  await ensureConfidentialUsdc(hre, args, fee * BigInt(times));
  for (let i = 0; i < times; i++) {
    const tx = await dno.feed(tokenId);
    await tx.wait();
    console.log(`  tx ${tx.hash}`);
  }
  console.log(`  affection gained: encrypted. Each feed adds a hidden amount, possibly none.`);
}

async function entangle(hre: HardhatRuntimeEnvironment, args: TaskArguments, a: number, b: number) {
  const { dno } = await connect(hre, args);
  console.log(`Entangling boxes ${a} and ${b}...`);
  await (await dno.proposeEntangle(a, b)).wait();
  const receipt = await (await dno.acceptEntangle(a, b)).wait();
  await finalizeRequest(hre, args, requestIdOf(dno, receipt!.logs));
  if ((await dno.partnerOf(a))[0]) console.log(`  observing either box now observes both.`);
}

async function duel(hre: HardhatRuntimeEnvironment, args: TaskArguments, a: number, b: number) {
  const { dno } = await connect(hre, args);
  console.log(`Duel: box ${a} goes on the duel shelf, box ${b} takes it up...`);
  const duelId = await dno.duelCount();
  const relay = async () => {
    const result = await hre.fhevm.publicDecrypt([...(await dno.duelHandles(duelId))]);
    const tx = await dno.finalizeDuel(duelId, result.abiEncodedClearValues, result.decryptionProof);
    return { tx, receipt: await tx.wait() };
  };
  await (await dno.postDuel(a, 0, false)).wait();
  console.log(`  posted; proving the box is held...`);
  await relay();
  if ((await dno.duelInfo(duelId)).duelStatus !== 2n) {
    console.log(`  void: the caller does not hold box ${a}.`);
    return;
  }
  await (await dno.acceptDuel(duelId, b)).wait();
  console.log(`  accepted; fetching the decrypted outcome and its KMS proof...`);
  const { tx, receipt } = await relay();
  const resolved = receipt!.logs.map((l) => dno.interface.parseLog(l)).find((e) => e?.name === "DuelResolved");
  if (!resolved) {
    console.log(`  no duel: one side did not hold its box.`);
    return;
  }
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
  const milestones = await dno.milestones();
  const reached = Number(await dno.milestonesReached());
  const sold = reached ? `more than ${milestones[reached - 1]}` : `fewer than ${milestones[0]}`;
  console.log(`DoNotOpen: ${address}  (${await dno.tokenCount()} ids, ${sold} of ${await dno.maxSupply()} boxes sold)`);
});

withAddress("dno:mint", "Buys sealed boxes, the quantity encrypted")
  .addOptionalParam("quantity", "How many boxes", "1")
  .addOptionalParam("ids", "How many token ids to hide the quantity among (1-10)", "10")
  .setAction(async (args, hre) => {
    await mint(hre, args, Number(args.quantity), Number(args.ids));
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

withAddress("dno:duel", "Runs a duel between two boxes held by the caller: post, prove, accept, finalise")
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
    // The entangled partner opened along with it.
    await status(hre, args, c!);
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

task("dno:credit-price", "Sets the decryption credit's USDC price from Zama's dollar price for one decryption")
  .addOptionalParam("zama", "Zama's price for one decryption on the collection's plan, in US dollars (0.001 to 0.1)")
  .addOptionalParam("margin", "Times Zama's price: covers the free allowance and the public decryptions", "2")
  .addOptionalParam("usdc", "Or the price itself, in USDC")
  .setAction(async (args: TaskArguments, hre) => {
    const { creditPrice } = await import("../lib/creditPrice");
    const deployment = await hre.deployments.get("DecryptionCredits");
    const credits = await hre.ethers.getContractAt("DecryptionCredits", deployment.address);
    const before: bigint = await credits.price();
    if (!args.zama && !args.usdc) {
      console.log(`DecryptionCredits ${deployment.address}: ${hre.ethers.formatUnits(before, 6)} USDC a credit`);
      return;
    }
    const price = args.usdc ? hre.ethers.parseUnits(String(args.usdc), 6) : creditPrice(String(args.zama), String(args.margin));
    await (await credits.setPrice(price)).wait();
    console.log(`DecryptionCredits ${deployment.address}: ${hre.ethers.formatUnits(before, 6)} -> ${hre.ethers.formatUnits(price, 6)} USDC a credit`);
  });

task("dno:export", "Writes the address and ABI of this network's deployment where the chain adapter reads them").setAction(
  async (_args, hre) => {
    const { writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const deployment = await hre.deployments.get("DoNotOpen");
    const out = resolve(__dirname, `../../chain-adapter/src/evm/deployments/${hre.network.name}.json`);
    const slim = {
      chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
      address: deployment.address,
      deployBlock: deployment.receipt?.blockNumber ?? 0,
      abi: deployment.abi,
      // ETH in, USDC or cUSDC out, when a ramp was deployed on this network.
      ramp: await hre.deployments.getOrNull("UsdcRamp").then((r) => (r ? { address: r.address, abi: r.abi } : null)),
      // Bought in USDC once a wallet's free decryptions of the day are spent.
      credits: await hre.deployments
        .getOrNull("DecryptionCredits")
        .then((r) => (r ? { address: r.address, abi: r.abi, deployBlock: r.receipt?.blockNumber ?? null } : null)),
    };
    writeFileSync(out, JSON.stringify(slim, null, 2) + "\n");
    console.log(`wrote ${out}`);

    // The CROQ economy, when it was deployed on this network.
    const pantry = await hre.deployments.getOrNull("Pantry");
    if (!pantry) return;
    const croq = await hre.deployments.get("Croq");
    const cCroq = await hre.deployments.get("ConfidentialCroq");
    const pool = await hre.deployments.getOrNull("CroqUsdcPool");
    const locker = await hre.deployments.getOrNull("LiquidityLocker");
    const { UNISWAP_V3 } = await import("../deploy/economy");
    const { PAYMENT_TOKENS } = await import("../deploy/deploy");
    const uniswap = UNISWAP_V3[hre.network.name];
    const usdc = PAYMENT_TOKENS[hre.network.name]?.usdc;
    const economyOut = resolve(__dirname, `../../chain-adapter/src/evm/deployments/${hre.network.name}-economy.json`);
    const economy = {
      croq: { address: croq.address, abi: croq.abi },
      cCroq: { address: cCroq.address, abi: cCroq.abi },
      pantry: { address: pantry.address, abi: pantry.abi },
      // A Uniswap V3 pool where CROQ is sold from one locked position, when one was opened here.
      market:
        pool && locker && uniswap && usdc
          ? {
              pool: pool.address,
              fee: pool.linkedData.fee,
              positionId: pool.linkedData.positionId,
              tickLower: pool.linkedData.tickLower,
              tickUpper: pool.linkedData.tickUpper,
              locker: locker.address,
              positionManager: uniswap.positionManager,
              swapRouter: uniswap.swapRouter,
              quoter: uniswap.quoter,
              usdc,
            }
          : null,
    };
    writeFileSync(economyOut, JSON.stringify(economy, null, 2) + "\n");
    console.log(`wrote ${economyOut}`);
  },
);
