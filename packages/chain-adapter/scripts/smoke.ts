/**
 * End-to-end check of EvmFhevmAdapter against the live Sepolia deployment, through the
 * real coprocessor, relayer and KMS. Spends testnet ETH (three mints and a few fees).
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
  console.log(`${info.chain} ${info.address}: ${info.totalMinted}/${info.maxSupply} minted, mint ${formatAmount(info.fees.mint, 18)} ETH`);
  console.log(`account ${me}`);

  console.log("mint 3");
  const [a, b, c] = (await chain.mint(3, { onStep })) as [number, number, number];
  console.log(`  boxes ${a}, ${b}, ${c}; boxesOf -> ${(await chain.boxesOf(me)).join(", ")}`);

  console.log(`shake ${a} twice (one permit signature)`);
  console.log(`  ${trait(await chain.shake(a, { onStep }))}`);
  console.log(`  ${trait(await chain.shake(a, { onStep }))}`);

  console.log(`feed ${a}`);
  await chain.feed(a, { onStep });
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
