/**
 * End-to-end check of the vault's pockets against the live Sepolia deployment, through the real
 * coprocessor, relayer and KMS: opens two pockets (the deployer's and a kept test wallet's),
 * puts test cUSDC in one, sends part of it to the other, reads both balances as their viewers,
 * and takes some out. Spends testnet ETH for gas and test USDC it mints itself.
 *
 *   pnpm --filter @dno/chain-adapter smoke:pockets
 *
 * Needs PRIVATE_KEY (and optionally SEPOLIA_RPC_URL) in the repo-root .env.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { JsonRpcProvider, parseEther } from "ethers";
import { createSepoliaNodeAdapter, formatAmount, type Step } from "../src/evm/node";
import { testWallet } from "./testWallets";

config({ path: resolve(__dirname, "../../../.env") });

const usd = (v: bigint) => formatAmount(v, 6);

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Set PRIVATE_KEY in .env (see .env.example).");
  const rpcUrl = process.env.SEPOLIA_RPC_URL || undefined;
  const onStep = (s: Step) => console.log(`    … ${s}`);

  const payer = createSepoliaNodeAdapter({ privateKey, rpcUrl });
  const me = await payer.connect();
  const receiverWallet = testWallet("pockets-receiver", "receives a pocket payment in smoke:pockets");
  const receiver = createSepoliaNodeAdapter({ privateKey: receiverWallet.privateKey, rpcUrl });
  await receiver.connect();
  const out = testWallet("pockets-withdrawals", "where smoke:pockets takes cUSDC out of a pocket");

  const pockets = payer.vault()?.pockets();
  const theirs = receiver.vault()?.pockets();
  if (!pockets || !theirs) throw new Error("No pockets in sepolia.json: run pnpm export:sepolia.");
  console.log(`pockets ${(await pockets.info()).address}, ${(await pockets.info()).count} opened; payer ${me}, receiver ${receiverWallet.address}`);

  // The receiver opens its own pocket from its own wallet: a little ETH for gas.
  const provider = new JsonRpcProvider(rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com");
  if ((await provider.getBalance(receiverWallet.address)) < parseEther("0.002")) {
    console.log("fund the receiver");
    const { Wallet } = await import("ethers");
    await (await new Wallet(privateKey, provider).sendTransaction({ to: receiverWallet.address, value: parseEther("0.005") })).wait();
  }

  console.log("open the payer's pocket");
  const mine = await pockets.open({ onStep });
  console.log("open the receiver's pocket");
  const other = await theirs.open({ onStep });
  console.log(`  pockets P-${mine} and P-${other}`);

  if ((await payer.usdcBalance(me)) < 5_000_000n) {
    console.log("faucet");
    await payer.faucetUsdc({ onStep });
  }
  console.log("shield 3 USDC");
  await payer.shieldUsdc(3_000_000n, { onStep });
  console.log("deposit 3 cUSDC into the payer's pocket, among 2 decoys");
  await pockets.deposit(3_000_000n, { onStep, decoys: 2 });
  console.log(`  payer's pocket: ${usd(await pockets.balance({ onStep }))} cUSDC`);

  console.log(`send 1 cUSDC to P-${other}`);
  await pockets.send(other, 1_000_000n, { onStep, decoys: 2 });
  console.log(`  payer's pocket: ${usd(await pockets.balance({ onStep }))} cUSDC`);
  console.log(`  receiver's pocket: ${usd(await theirs.balance({ onStep }))} cUSDC`);

  console.log(`take 0.5 cUSDC out to ${out.address}`);
  await pockets.withdraw(out.address, 500_000n, { onStep });
  console.log(`  payer's pocket: ${usd(await pockets.balance({ onStep }))} cUSDC`);
  console.log("done");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
