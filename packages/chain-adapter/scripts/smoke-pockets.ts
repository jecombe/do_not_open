/**
 * End-to-end check of the vault's pockets against the live Sepolia deployment, through the real
 * coprocessor, relayer and KMS: opens two pockets (the deployer's and a kept test wallet's),
 * puts a test token in one, sends part of it to the other, reads both balances as their viewers,
 * and takes some out. Spends testnet ETH for gas and test tokens it mints itself (Zama's mocks).
 *
 *   pnpm --filter @dno/chain-adapter smoke:pockets
 *   POCKET_TOKEN=cZAMA pnpm --filter @dno/chain-adapter smoke:pockets   # cUSDT, cWETH, cZAMA
 *
 * Needs PRIVATE_KEY (and optionally SEPOLIA_RPC_URL) in the repo-root .env.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { JsonRpcProvider, parseEther } from "ethers";
import { createSepoliaNodeAdapter, formatAmount, type Step } from "../src/evm/node";
import { testWallet } from "./testWallets";

config({ path: resolve(__dirname, "../../../.env") });

const units = (v: bigint) => formatAmount(v, 6);

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

  const symbol = process.env.POCKET_TOKEN || undefined;
  const pockets = payer.vault()?.pockets(symbol);
  const theirs = receiver.vault()?.pockets(symbol);
  if (!pockets || !theirs) throw new Error(`No ${symbol ?? "cUSDC"} pockets in sepolia.json: run pnpm export:sepolia.`);
  const token = pockets.token;
  const sym = token.symbol;
  console.log(`${sym} pockets ${(await pockets.info()).address}, ${(await pockets.info()).count} opened; payer ${me}, receiver ${receiverWallet.address}`);

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

  // Three tokens' worth, in the confidential token's units (6 decimals for every wrapper here),
  // or what one faucet call covers (1 WETH); a third of it is sent, a sixth taken out.
  const faucetUnits = token.faucet === null ? null : token.faucet / token.rate;
  const amount = faucetUnits !== null && faucetUnits < 3_000_000n ? faucetUnits : 3_000_000n;
  const sent = amount / 3n;
  const taken = amount / 6n;
  if ((await pockets.plainBalance()) < amount * token.rate) {
    console.log(`faucet ${token.underlying.symbol}`);
    await pockets.faucet({ onStep });
  }
  console.log(`shield ${units(amount)} ${token.underlying.symbol}`);
  await pockets.shield(amount, { onStep });
  console.log(`deposit ${units(amount)} ${sym} into the payer's pocket, among 2 decoys`);
  await pockets.deposit(amount, { onStep, decoys: 2 });
  console.log(`  payer's pocket: ${units(await pockets.balance({ onStep }))} ${sym}`);

  console.log(`send ${units(sent)} ${sym} to P-${other}`);
  await pockets.send(other, sent, { onStep, decoys: 2 });
  console.log(`  payer's pocket: ${units(await pockets.balance({ onStep }))} ${sym}`);
  console.log(`  receiver's pocket: ${units(await theirs.balance({ onStep }))} ${sym}`);

  console.log(`take ${units(taken)} ${sym} out to ${out.address}`);
  await pockets.withdraw(out.address, taken, { onStep });
  console.log(`  payer's pocket: ${units(await pockets.balance({ onStep }))} ${sym}`);
  console.log("done");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
