/**
 * End-to-end check of the croquette calls of EvmFhevmAdapter against the live Sepolia
 * Pantry, cCROQ and Uniswap V3 pool, through the real coprocessor, relayer and KMS.
 * Spends test USDC (one mint, one opening, a 1 USDC market buy; minted from the faucet when
 * short) and testnet ETH for gas for about fifteen
 * transactions. Needs the Pantry with weigh-ins: redeploy the economy first.
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
  console.log(`${e.symbol}: ${e.totalSupply} total, ${e.wrapped} wrapped; pool holds ${e.market?.croqHeld} CROQ / ${formatAmount(e.market?.quoteHeld ?? 0n, 6)} USDC, sells from ${formatAmount(e.market?.range?.from ?? 0n, 6)} USDC per 1,000`);
  check(e.totalSupply === BigInt(spec.economy.token.totalSupply), "total supply matches the spec");

  const ramp = await chain.quoteUsdc(10n ** 15n);
  console.log(`ramp: 0.001 ETH buys about ${formatAmount(ramp.usdcOut, 6)} USDC, fee ${formatAmount(ramp.fee, 18)} ETH; buying it shielded`);
  const cBefore = await chain.confidentialUsdcBalance({ onStep });
  await chain.buyUsdc(10n ** 15n, true, { onStep });
  const cAfter = await chain.confidentialUsdcBalance({ onStep });
  check(cAfter - cBefore >= (ramp.usdcOut * 99n) / 100n, `received ${formatAmount(cAfter - cBefore, 6)} cUSDC`);
  if ((await chain.usdcBalance(me)) < 10_000_000n) await chain.faucetUsdc({ onStep });
  console.log("mint 1");
  const [box] = (await chain.mint(1, { onStep })) as [number];
  console.log(`  box ${box}`);

  const before = await chain.confidentialBalance({ onStep });
  console.log(`claim the welcome bag of box ${box} (cCROQ before: ${before})`);
  await chain.claimCroquettes([box], { onStep });
  const afterBag = await chain.confidentialBalance({ onStep });
  check(afterBag - before === BigInt(spec.economy.welcomeBag.amount), `welcome bag of ${spec.economy.welcomeBag.amount} arrived`);
  check((await chain.boxPantry(box)).welcomed, "box marked as welcomed");

  console.log(`feed box ${box} 40 cCROQ`);
  await chain.feedCroquettes(box, 40n, { onStep });
  check((await chain.confidentialBalance({ onStep })) === afterBag - 40n, "40 cCROQ left the wallet");
  const day = await chain.pantryDay(box, { onStep });
  check(day.meals === 1 && day.eaten === 40n, "the holder reads one meal, 40 eaten today");

  console.log(`open box ${box} and weigh it`);
  await chain.observe(box, { onStep });
  const w = await chain.weigh(box, { onStep });
  check(w.weight === 40n && w.build === "normal" && !w.sick, "weighed 40, normal build");

  const usdIn = 1_000_000n; // 1 USDC
  const quoted = await chain.quote("buy", usdIn);
  console.log(`buy CROQ for ${formatAmount(usdIn, 6)} USDC (quote ${quoted})`);
  const plainBefore = await chain.croqBalance(me);
  await chain.trade("buy", usdIn, { onStep });
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
