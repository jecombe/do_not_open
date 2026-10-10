/**
 * End-to-end check of the vault's liquidity positions against the live Sepolia deployment, through
 * the real coprocessor, relayer and KMS and the real Uniswap V3: fills the deployer's cUSDC and
 * cWETH pockets with test tokens it mints itself (Zama's mocks), opens a position in the WETH/USDC
 * pool out of them (both bound keys, the unwraps' proofs, the mint), finds it again from the
 * signature, makes the pool trade both ways, collects the fees into the pockets and closes it.
 * Spends testnet ETH for gas.
 *
 *   pnpm --filter @dno/chain-adapter smoke:positions
 *
 * Needs PRIVATE_KEY (and optionally SEPOLIA_RPC_URL) in the repo-root .env.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { rangeAround } from "../src/liquidity";
import { createSepoliaNodeAdapter, formatAmount, type Step } from "../src/evm/node";

config({ path: resolve(__dirname, "../../../.env") });

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Set PRIVATE_KEY in .env (see .env.example).");
  const onStep = (s: Step) => console.log(`    … ${s}`);
  const chain = createSepoliaNodeAdapter({ privateKey, rpcUrl: process.env.SEPOLIA_RPC_URL || undefined });
  const me = await chain.connect();
  const vault = chain.vault();
  const lp = vault?.positions();
  if (!vault || !lp) throw new Error("No positions in sepolia.json: run pnpm export:sepolia.");
  const info = await lp.info();
  const pool = info.pools.find((p) => [p.token0.symbol, p.token1.symbol].includes("cWETH"));
  if (!pool) throw new Error("No WETH/USDC pool here.");
  console.log(`positions ${info.address}, ${info.count} opened; pool ${pool.address} (${pool.token0.symbol}/${pool.token1.symbol}, ${pool.fee / 10_000}%); wallet ${me}`);

  // A small position: 0.01 WETH and the USDC it needs at today's price, in the pockets' units.
  const usdc = vault.pockets("cUSDC")!;
  const weth = vault.pockets("cWETH")!;
  const wethUnits = 10_000n;
  const usdcUnits = 60_000_000n;
  for (const [pockets, amount] of [[usdc, usdcUnits], [weth, wethUnits]] as const) {
    const t = pockets.token;
    await pockets.open({ onStep });
    if ((await pockets.plainBalance()) < amount * t.rate) {
      console.log(`faucet ${t.underlying.symbol}`);
      await pockets.faucet({ onStep });
    }
    console.log(`shield and deposit ${formatAmount(amount, 6)} ${t.symbol}`);
    await pockets.shield(amount, { onStep });
    await pockets.deposit(amount, { onStep, decoys: 2 });
  }

  const { tickLower, tickUpper } = rangeAround(pool.tick, pool.fee, 15);
  const wethIs0 = pool.token0.symbol === "cWETH";
  console.log(`open a position on [${tickLower}, ${tickUpper}]`);
  const id = await lp.open(pool.address, tickLower, tickUpper, wethIs0 ? wethUnits : usdcUnits, wethIs0 ? usdcUnits : wethUnits, { onStep, decoys: 2 });
  const [found] = (await lp.mine()).filter((p) => p.positionId === id);
  if (!found) throw new Error(`position #${id} not found from the signature`);
  console.log(`  position #${id}: Uniswap #${found.tokenId}, liquidity ${found.liquidity}, in range ${found.inRange}`);

  console.log("make the pool trade both ways");
  await lp.trade!(pool.address, { onStep });
  const earned = (await lp.mine()).find((p) => p.positionId === id)!;
  console.log(`  fees earned: ${earned.fees0} / ${earned.fees1}`);
  console.log("collect the fees");
  console.log(`  into the pockets: ${JSON.stringify(await lp.collect(id, { onStep }), (_, v) => (typeof v === "bigint" ? String(v) : v))}`);
  console.log("close it");
  await lp.remove(id, 10_000, { onStep });
  console.log(`  cUSDC pocket: ${formatAmount(await usdc.balance({ onStep }), 6)}, cWETH pocket: ${formatAmount(await weth.balance({ onStep }), 6)}`);
  console.log("done");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
