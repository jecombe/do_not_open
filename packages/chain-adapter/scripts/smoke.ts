/**
 * End-to-end check of EvmFhevmAdapter against the live Sepolia deployment, through the
 * real coprocessor, relayer and KMS. Spends testnet ETH for gas, and test USDC it mints itself:
 * two boxes in USDC, one in cUSDC, a feed in cUSDC.
 *
 *   pnpm --filter @dno/chain-adapter smoke:sepolia
 *
 * Needs PRIVATE_KEY (and optionally SEPOLIA_RPC_URL) in the repo-root .env.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { spec } from "@dno/game-spec";
import { buildCatSpec } from "@dno/generator";
import { createSepoliaNodeAdapter, formatAmount, type Step } from "../src/evm/node";

config({ path: resolve(__dirname, "../../../.env") });

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Set PRIVATE_KEY in .env (see .env.example).");
  const chain = createSepoliaNodeAdapter({ privateKey, rpcUrl: process.env.SEPOLIA_RPC_URL });
  const me = await chain.connect();
  const onStep = (s: Step) => console.log(`    … ${s}`);
  const trait = (t: { traitIndex: number; roll: number }) => `${spec.traits[t.traitIndex]!.name} roll ${t.roll}`;

  const info = await chain.collection();
  const usd = (v: bigint) => `${formatAmount(v, info.payment.decimals)}`;
  console.log(`${info.chain} ${info.address}: ${info.totalMinted}/${info.maxSupply} minted, mint ${usd(info.fees.mint)} USDC`);
  console.log(`account ${me}`);

  if ((await chain.usdcBalance(me)) < 50_000_000n) {
    console.log("faucet");
    await chain.faucetUsdc({ onStep });
  }
  const shielded = await chain.confidentialUsdcBalance({ onStep });
  console.log(`  ${usd(await chain.usdcBalance(me))} USDC, ${usd(shielded)} cUSDC`);
  if (shielded < 10_000_000n) {
    console.log("shield 20 USDC");
    await chain.shieldUsdc(20_000_000n, { onStep });
  }

  console.log("mint 2 in USDC");
  const [a, b] = (await chain.mint(2, { onStep })) as [number, number];
  console.log("mint 1 in cUSDC (order, public decryption of the paid bit, settlement)");
  const [c] = (await chain.mint(1, { onStep, pay: "cusdc" })) as [number];
  console.log(`  boxes ${a}, ${b}, ${c}; boxesOf -> ${(await chain.boxesOf(me)).join(", ")}`);
  console.log(`  cUSDC now ${usd(await chain.confidentialUsdcBalance({ onStep }))}; pending orders ${(await chain.pendingOrders(me)).length}`);

  console.log(`shake ${a} twice (one permit signature)`);
  console.log(`  ${trait(await chain.shake(a, { onStep }))}`);
  console.log(`  ${trait(await chain.shake(a, { onStep }))}`);

  console.log(`feed ${a} in cUSDC`);
  await chain.feed(a, { onStep, pay: "cusdc" });
  console.log(`  feeds: ${(await chain.box(a)).feeds}`);

  console.log(`prove alive ${b}`);
  console.log(`  alive: ${await chain.proveAlive(b, { onStep })} -> ${(await chain.box(b)).aliveCheck}`);

  console.log(`duel ${a} vs ${b}`);
  const duelId = await chain.challengeDuel(a, b, { onStep });
  console.log(`  open duel: ${JSON.stringify((await chain.pair(a, b)).openDuel)}`);
  await chain.acceptDuel(duelId, { onStep });
  const duel = await chain.finishDuel(duelId, { onStep });
  console.log(`  winner ${duel.winner}, loser ${duel.loser} shows ${trait(duel.shown)}`);

  console.log(`entangle ${a} and ${c}`);
  await chain.proposeEntangle(a, c, { onStep });
  console.log(`  proposal: ${JSON.stringify((await chain.pair(a, c)).entangleProposal)}`);
  await chain.acceptEntangle(a, c, { onStep });

  console.log(`observe ${a} (opens ${c} too)`);
  for (const box of await chain.observe(a, { onStep })) {
    const r = box.revealed!;
    const cat = buildCatSpec({ seed: r.seed, affection: r.affection, state: r.state });
    const match = cat.rarity.score === r.score && cat.rarity.golden === r.golden ? "matches the generator" : "MISMATCH with the generator";
    console.log(`  box ${box.tokenId}: ${cat.state} ${cat.traits.breed.name}, score ${r.score} (${cat.rarity.tierName}), ${match}`);
  }
  console.log(`box ${b} stays ${(await chain.box(b)).status}, public traits ${JSON.stringify((await chain.box(b)).publicTraits)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
