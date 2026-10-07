/**
 * Throwaway Sepolia wallets for the smoke tests, kept from one run (and one session) to the next
 * in `.test-wallets.json` at the repo root, which git ignores. Each has a name; asking for it again
 * returns the same key, so its test tokens, boxes and rats are reused instead of stranded. They
 * are the team's: every address here belongs in TEAM_WALLETS on the live stack (`/opt/dno/.env`),
 * so none of them ever takes a place on the mainnet list. Never fund one on mainnet.
 *
 *   pnpm --filter @dno/chain-adapter test-wallets     # the addresses, for TEAM_WALLETS
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatEther, parseEther, Wallet, type Provider } from "ethers";

export const TEST_WALLETS_FILE = resolve(__dirname, "../../../.test-wallets.json");

interface Kept {
  address: string;
  privateKey: string;
  /** What the wallet is for. */
  purpose: string;
  createdAt: string;
}

function read(): Record<string, Kept> {
  return existsSync(TEST_WALLETS_FILE) ? (JSON.parse(readFileSync(TEST_WALLETS_FILE, "utf8")) as Record<string, Kept>) : {};
}

/** The test wallet called `name`, made and kept the first time. */
export function testWallet(name: string, purpose: string): Wallet {
  const all = read();
  const kept = all[name];
  if (kept) return new Wallet(kept.privateKey);
  const fresh = Wallet.createRandom();
  all[name] = { address: fresh.address, privateKey: fresh.privateKey, purpose, createdAt: new Date().toISOString() };
  writeFileSync(TEST_WALLETS_FILE, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  console.log(`  new test wallet "${name}" ${fresh.address}: add it to TEAM_WALLETS in /opt/dno/.env (see CLAUDE.md)`);
  return new Wallet(fresh.privateKey);
}

/** Tops `wallet` up from `funder` to `target` ETH when it holds less than `min`: a kept wallet is funded once. */
export async function fundTestWallet(funder: Wallet, wallet: Wallet, provider: Provider, min = "0.002", target = "0.003"): Promise<void> {
  const balance = await provider.getBalance(wallet.address);
  if (balance >= parseEther(min)) return;
  const send = parseEther(target) - balance;
  await (await funder.connect(provider).sendTransaction({ to: wallet.address, value: send })).wait();
  console.log(`  funded ${wallet.address} with ${formatEther(send)} ETH`);
}

if (require.main === module) {
  const all = Object.entries(read());
  if (!all.length) console.log(`no test wallet yet (${TEST_WALLETS_FILE})`);
  for (const [name, w] of all) console.log(`${name.padEnd(24)} ${w.address}  ${w.purpose}`);
  if (all.length) console.log(`\nTEAM_WALLETS additions: ${all.map(([, w]) => w.address).join(",")}`);
}
