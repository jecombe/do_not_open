/**
 * End-to-end check of EvmFhevmAdapter against the live Sepolia deployment, through the
 * real coprocessor, relayer and KMS. Spends testnet ETH for gas, and test USDC it mints itself:
 * a hidden mint in cUSDC (two boxes among ten ids), one shielded from USDC (one among three),
 * a feed, a shake by someone who does not hold the box, and the usual game.
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
  console.log(`${info.chain} ${info.address}: ${info.tokenCount} ids, milestones ${info.sale.reached}/${info.sale.milestones.length}, mint ${usd(info.fees.mint)} USDC`);
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

  console.log("mint 2 in cUSDC, hidden among 10 ids");
  const [a, b] = (await chain.mint(2, { onStep })) as [number, number];
  console.log("mint 1, shielded from USDC just before, hidden among 3 ids");
  const [c] = (await chain.mint(1, { onStep, pay: "usdc", ids: 3 })) as [number];
  console.log(`  boxes ${a}, ${b}, ${c}; found in the receipts -> ${(await chain.boxesOf(me)).join(", ")}`);
  console.log(`  cUSDC now ${usd(await chain.confidentialUsdcBalance({ onStep }))}; pending requests ${(await chain.pendingRequests(me)).length}`);

  console.log(`shake ${a} twice (one permit signature)`);
  console.log(`  ${trait(await chain.shake(a, { onStep }))}`);
  console.log(`  ${trait(await chain.shake(a, { onStep }))}`);

  console.log(`feed ${a} in cUSDC`);
  await chain.feed(a, { onStep });

  const empty = c + 1;
  console.log(`shake ${empty}, an empty id of the last mint`);
  try {
    await chain.shake(empty, { onStep });
    console.log("  !! it showed something");
  } catch (error) {
    console.log(`  ${(error as Error).message}`);
  }

  console.log(`prove alive ${b}`);
  console.log(`  alive: ${await chain.proveAlive(b, { onStep })} -> ${(await chain.box(b)).aliveCheck}`);

  console.log(`duel ${a} on the shelf, taken up by ${b}`);
  const posted = await chain.postDuel(a, { onStep });
  console.log(`  on the shelf: ${JSON.stringify(posted)}`);
  const duel = await chain.acceptDuel(posted.duelId, b, { onStep });
  console.log(duel ? `  winner ${duel.winner}, loser ${duel.loser} shows ${trait(duel.shown)}` : "  !! void");

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
