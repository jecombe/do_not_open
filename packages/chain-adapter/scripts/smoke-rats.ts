/**
 * End-to-end check of the rats' powers and tricks against the live Sepolia deployment: adopts
 * rats, reads their secret power, sniffs a box, shields one of the account's boxes, and has a
 * second, kept test wallet's box jammed (scripts/testWallets.ts) so that its holder's shakes come back scrambled. Spends
 * testnet ETH for gas (a little goes to the throwaway wallet), and test USDC it mints itself.
 *
 *   pnpm --filter @dno/chain-adapter smoke:rats
 *
 * Needs PRIVATE_KEY (and optionally SEPOLIA_RPC_URL) in the repo-root .env.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";
import { fundTestWallet, testWallet } from "./testWallets";
import { spec } from "@dno/game-spec";
import { ChainError } from "../src";
import { createSepoliaNodeAdapter, type Step } from "../src/evm/node";

config({ path: resolve(__dirname, "../../../.env") });

const trait = (t: { traitIndex: number; roll: number }) => `${spec.traits[t.traitIndex]!.name} roll ${t.roll}`;
const onStep = (s: Step) => console.log(`    … ${s}`);

async function ready(chain: ReturnType<typeof createSepoliaNodeAdapter>, me: string) {
  if ((await chain.usdcBalance(me as `0x${string}`)) < 30_000_000n) await chain.faucetUsdc({ onStep });
  if ((await chain.confidentialUsdcBalance({ onStep })) < 10_000_000n) await chain.shieldUsdc(20_000_000n, { onStep });
}

/** Adopts free rats until one has `wanted` or better, at most `tries`. Returns the best one. */
async function adopt(chain: ReturnType<typeof createSepoliaNodeAdapter>, wanted: number, tries: number) {
  let best = { id: 0, power: 0 };
  for (let i = 0; i < tries && best.power < wanted; i++) {
    const seed = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const id = await chain.mintSeedRat(seed, { onStep });
    const power = await chain.ratPower(id, { onStep });
    console.log(`  rat #${id}: power ${power}`);
    if (power > best.power) best = { id, power };
  }
  return best;
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Set PRIVATE_KEY in .env (see .env.example).");
  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  const chain = createSepoliaNodeAdapter({ privateKey, rpcUrl });
  const me = await chain.connect();
  console.log(`account ${me}`);
  const tricks = await chain.ratTricks();
  if (!tricks) throw new Error("no RatTricks on Sepolia");
  console.log(`tricks: sniff ${tricks.sniffFee}, rebate ${tricks.sniffRebate}, ${tricks.trickSeconds / 86_400} d on, ${tricks.rechargeSeconds / 86_400} d rest`);
  await ready(chain, me);

  console.log("mint 2 boxes");
  const [a, b] = (await chain.mint(2, { onStep, ids: 2 })) as [number, number];
  console.log(`  boxes ${a}, ${b}`);

  console.log("adopt a rat and read its power");
  const sniffer = await adopt(chain, 1, 1);
  console.log(`sniff box ${b} with rat #${sniffer.id}`);
  const before = await chain.confidentialUsdcBalance({ onStep });
  console.log(`  ${trait(await chain.sniffWithRat(sniffer.id, b, { onStep }))}`);
  const paid = before - (await chain.confidentialUsdcBalance({ onStep }));
  console.log(`  paid ${paid} (power ${sniffer.power}: expected ${sniffer.power === 1 ? tricks.sniffFee - tricks.sniffRebate : tricks.sniffFee})`);

  console.log(`shield box ${a} with rat #${sniffer.id}`);
  const played = await chain.playTrick(sniffer.id, a, 1, { onStep });
  console.log(`  until ${new Date(played.until * 1000).toISOString()}, ready ${new Date(played.readyAt * 1000).toISOString()}; readyAt read back ${(await chain.ratReadyAt([sniffer.id]))[0]}`);
  try {
    await chain.playTrick(sniffer.id, b, 0, { onStep });
    console.log("  !! a resting rat played again");
  } catch (error) {
    console.log(`  again: ${(error as ChainError).code} ${(error as ChainError).reason ?? ""}`);
  }
  console.log(`  holder's own shake of ${a}: ${trait(await chain.shake(a, { onStep }))}`);

  console.log("a second wallet holds a box; a power-3 rat of ours jams it");
  // A kept test wallet (.test-wallets.json): the same one every run, topped up only when low.
  const other = testWallet("smoke-rats-victim", "smoke:rats: holds a box that a rat of ours jams");
  const provider = new JsonRpcProvider(rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com");
  await fundTestWallet(new Wallet(privateKey), other, provider);
  const victim = createSepoliaNodeAdapter({ privateKey: other.privateKey, rpcUrl });
  const them = await victim.connect();
  await ready(victim, them);
  const [v] = (await victim.mint(1, { onStep, ids: 1 })) as [number];
  console.log(`  their box ${v}`);
  const jammer = await adopt(chain, 3, 4);
  console.log(`jam box ${v} with rat #${jammer.id} (power ${jammer.power}), trait 0`);
  await chain.playTrick(jammer.id, v, 0, { onStep });
  let scrambled = 0;
  for (let i = 0; i < (jammer.power === 3 ? 2 : 6); i++) {
    try {
      console.log(`  their shake: ${trait(await victim.shake(v, { onStep }))}`);
    } catch (error) {
      if (!(error instanceof ChainError) || error.code !== "scrambled") throw error;
      scrambled++;
      console.log("  their shake: scrambled");
    }
  }
  console.log(jammer.power >= 2 ? (scrambled > 0 ? "OK: the jam scrambles the holder's shakes" : "?? no scrambled shake seen") : "power 1 rat: a bluff, nothing scrambled");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
