/**
 * End-to-end check of the croquette calls of EvmFhevmAdapter against the live Sepolia
 * Pantry, cCROQ and Uniswap V2 pool, through the real coprocessor, relayer and KMS.
 * Spends testnet ETH: one mint, a small market buy and gas for about ten transactions.
 *
 *   pnpm --filter @dno/chain-adapter smoke:croq
 *
 * Needs PRIVATE_KEY (and optionally SEPOLIA_RPC_URL) in the repo-root .env.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { spec } from "@dno/game-spec";
import { createSepoliaNodeAdapter, formatAmount, type Step } from "../src/evm/node";

config({ path: resolve(__dirname, "../../../.env") });

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`  ok: ${what}`);
};

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Set PRIVATE_KEY in .env (see .env.example).");
  const chain = createSepoliaNodeAdapter({ privateKey, rpcUrl: process.env.SEPOLIA_RPC_URL });
  const me = await chain.connect();
  const onStep = (s: Step) => console.log(`    … ${s}`);

  const e = await chain.economy();
  console.log(`${e.symbol}: ${e.totalSupply} total, ${e.wrapped} wrapped; pool ${e.market?.croqReserve} CROQ / ${formatAmount(e.market?.nativeReserve ?? 0n, 18)} ETH`);
  check(e.totalSupply === BigInt(spec.economy.token.totalSupply), "total supply matches the spec");

  console.log("mint 1");
  const [box] = (await chain.mint(1, { onStep })) as [number];
  console.log(`  box ${box}`);

  const before = await chain.confidentialBalance({ onStep });
  console.log(`claim the welcome bag of box ${box} (cCROQ before: ${before})`);
  await chain.claimCroquettes([box], { onStep });
  const afterBag = await chain.confidentialBalance({ onStep });
  check(afterBag - before === BigInt(spec.economy.welcomeBag.amount), `welcome bag of ${spec.economy.welcomeBag.amount} arrived`);
  check((await chain.boxPantry(box)).welcomed, "box marked as welcomed");

  console.log(`serve box ${box} 40 cCROQ`);
  await chain.feedCroquettes(box, 40n, { onStep });
  check((await chain.boxPantry(box)).meals === 1, "one meal counted");
  check((await chain.confidentialBalance({ onStep })) === afterBag - 40n, "40 cCROQ left the wallet");

  const ethIn = 10n ** 14n;
  const quoted = await chain.quote("buy", ethIn);
  console.log(`buy CROQ for ${formatAmount(ethIn, 18)} ETH (quote ${quoted})`);
  const plainBefore = await chain.croqBalance(me);
  await chain.trade("buy", ethIn, { onStep });
  const bought = (await chain.croqBalance(me)) - plainBefore;
  check(bought >= (quoted * 99n) / 100n, `bought ${bought} CROQ`);

  console.log(`wrap ${bought}`);
  const hiddenBefore = await chain.confidentialBalance({ onStep });
  await chain.wrap(bought, { onStep });
  check((await chain.confidentialBalance({ onStep })) === hiddenBefore + bought, "wrapped 1:1");

  console.log("unwrap 25");
  const plainMid = await chain.croqBalance(me);
  await chain.unwrap(25n, { onStep });
  check((await chain.croqBalance(me)) === plainMid + 25n, "25 plain CROQ back");

  console.log("send 5 cCROQ to self");
  const hiddenMid = await chain.confidentialBalance({ onStep });
  await chain.sendCroquettes(me, 5n, { onStep });
  check((await chain.confidentialBalance({ onStep })) === hiddenMid, "a transfer to self keeps the balance");

  console.log("sell 25 CROQ");
  await chain.trade("sell", 25n, { onStep });
  check((await chain.croqBalance(me)) === plainMid, "sold");

  console.log("done");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
