/**
 * Fills a live OpenSea offer with `VaultOffers` on a local fork of mainnet, through OpenSea's
 * API as the API server uses it: the check that the API side of accepting an OpenSea offer
 * works, with nothing deployed and nothing spent.
 *
 *   pnpm --filter @dno/chain-adapter opensea:fork -- --collection 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D --token 1
 *
 * 1. Reads the live offers on the token from OpenSea (`OpenSeaOffers.offers`, the API's reading).
 * 2. Forks mainnet with anvil at its latest block, deploys `VaultOffers` on it (Seaport 1.6, WETH)
 *    and hands it the NFT, from whoever holds it (impersonated).
 * 3. Asks OpenSea the order that fills the best offer, signed by its zone for the fork's
 *    `VaultOffers` (`OpenSeaOffers.fulfillment`, what `POST /v1/vault/offers/fulfillment` sends).
 * 4. Fills it on the fork, as `finalizeOffer` would: the NFT reaches the buyer, the WETH, less
 *    OpenSea's fee, comes back unwrapped.
 *
 * Needs OPENSEA_API_KEY in the repo-root .env (the API's key: it never goes anywhere but
 * OpenSea), `anvil` (Foundry) on the PATH or `--rpc` to a fork of your own, a mainnet RPC
 * (MAINNET_RPC_URL; eth.drpc.org by default), and the contracts compiled
 * (`pnpm --filter @dno/contracts-evm compile`: the script reads VaultOffers' artifact).
 * OpenSea's signature lasts a few minutes, so the fork is taken right before asking for it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Contract, ContractFactory, formatEther, JsonRpcProvider, Wallet } from "ethers";
import { encodeAdvancedOrder, MAINNET_WETH, OpenSeaOffers, SEAPORT_1_6 } from "../src/opensea";

config({ path: resolve(__dirname, "../../../.env") });

const NFT_ABI = ["function ownerOf(uint256) view returns (address)", "function transferFrom(address,address,uint256)"];
const ARTIFACT = resolve(__dirname, "../../contracts-evm/artifacts/contracts/vault/VaultOffers.sol/VaultOffers.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) throw new Error("Set OPENSEA_API_KEY in .env (see .env.example).");
  const collection = arg("collection");
  const token = arg("token");
  if (!collection || !token) throw new Error("Usage: opensea:fork -- --collection <address> --token <id> [--rpc <anvil fork>]");
  const tokenId = BigInt(token);
  const forkUrl = process.env.MAINNET_RPC_URL || "https://eth.drpc.org";
  const sea = new OpenSeaOffers({ apiKey });

  // 1. The offers, as the API lists them for the page.
  const offers = await sea.offers(collection, tokenId);
  console.log(`OpenSea holds ${offers.length} usable WETH offer(s) on ${collection} #${tokenId}:`);
  for (const o of offers.slice(0, 5)) console.log(`  ${o.orderHash.slice(0, 10)}… ${formatEther(o.amount)} WETH net from ${o.buyer}${o.anyToken ? " (any token)" : ""}, until ${new Date(o.endTime * 1000).toISOString()}`);
  const best = offers[0];
  if (!best) throw new Error("No offer to fill: pick a token with offers on opensea.io.");
  if (best.protocolAddress.toLowerCase() !== SEAPORT_1_6.toLowerCase()) throw new Error(`The offer is on ${best.protocolAddress}, not Seaport 1.6.`);

  // 2. A fork of mainnet, VaultOffers on it, the NFT in its hands.
  let anvil: ChildProcess | undefined;
  const url = arg("rpc") ?? "http://127.0.0.1:8547";
  if (!arg("rpc")) {
    anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", "8547", "--silent"], { stdio: "ignore" });
    anvil.on("error", () => {
      throw new Error("anvil (Foundry) is not on the PATH: install it, or pass --rpc to a fork of your own.");
    });
  }
  const fork = new JsonRpcProvider(url, 1, { staticNetwork: true, cacheTimeout: -1 });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await fork.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const block = await fork.getBlock("latest");
    console.log(`Fork at block ${block!.number} (${url}), its clock at ${new Date(block!.timestamp * 1000).toISOString()}`);
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: unknown[]; bytecode: string };
    const deployer = await fork.getSigner(0);
    const deployed = await (await new ContractFactory(artifact.abi as never, artifact.bytecode, deployer).deploy(SEAPORT_1_6, MAINNET_WETH)).waitForDeployment();
    const fulfiller = await deployed.getAddress();
    const vaultOffers = new Contract(fulfiller, artifact.abi as never, deployer);
    console.log(`VaultOffers deployed at ${fulfiller} (Seaport 1.6, WETH)`);

    const nft = new Contract(collection, NFT_ABI, fork);
    const owner = (await nft.ownerOf!(tokenId)) as string;
    await fork.send("anvil_impersonateAccount", [owner]);
    await fork.send("anvil_setBalance", [owner, "0x" + (10n ** 18n).toString(16)]);
    await (await nft.connect(await fork.getSigner(owner)).getFunction("transferFrom")(owner, fulfiller, tokenId)).wait();
    console.log(`#${tokenId} handed to VaultOffers by its holder ${owner}`);

    // What `acceptOffer` checks before the request: the order as OpenSea lists it, no signature yet.
    const [, buyer, fillable] = (await vaultOffers.inspect!(encodeAdvancedOrder({ parameters: best.parameters, numerator: 1n, denominator: 1n, signature: "0x", extraData: "0x" }), collection, tokenId, 0n)) as [string, string, boolean];
    console.log(`inspect: buyer ${buyer}, fillable ${fillable}`);
    if (!fillable) throw new Error("VaultOffers would not fill this offer (dead, or not WETH for this token).");

    // 3. The order signed for the fork's VaultOffers: what the page asks the API right before finalizeOffer.
    const { offer, expiresAt } = await sea.fulfillment(best.orderHash, best.protocolAddress, fulfiller, collection, tokenId);
    const now = (await fork.getBlock("latest"))!.timestamp;
    console.log(`OpenSea signed the fill for ${fulfiller}: ${offer.length / 2 - 1} bytes, expires ${expiresAt ? `${expiresAt - now}s after the fork's clock` : "unknown"}`);

    // 4. The fill, from a fresh wallet (anvil's accounts are real mainnet addresses, some with code).
    const caller = Wallet.createRandom().connect(fork);
    const callerAddress = await caller.getAddress();
    await fork.send("anvil_setBalance", [callerAddress, "0x" + (10n ** 18n).toString(16)]);
    const before = await fork.getBalance(callerAddress);
    const tx = await vaultOffers.connect(caller).getFunction("fill")(offer, collection, tokenId, { gasLimit: 3_000_000 });
    const r = await tx.wait();
    const got = (await fork.getBalance(callerAddress)) - before + BigInt(r.gasUsed) * BigInt(r.gasPrice);
    const newOwner = (await nft.ownerOf!(tokenId)) as string;
    console.log(`filled in ${r.hash} (${r.gasUsed} gas): #${tokenId} is ${newOwner}'s, ${formatEther(got)} ETH came to the caller (OpenSea listed ${formatEther(best.amount)} WETH net)`);
    if (newOwner.toLowerCase() !== best.buyer.toLowerCase()) throw new Error("The NFT did not reach the buyer.");
    if (got <= 0n) throw new Error("No ETH came back.");
    console.log("OK: a live OpenSea offer, read and signed through OpenSea's API, filled by VaultOffers.");
  } finally {
    fork.destroy();
    anvil?.kill();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
