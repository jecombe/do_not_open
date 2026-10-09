import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { testWallet } from "../../chain-adapter/scripts/testWallets";

/**
 * The sealed vault, end to end, on a local node or on Sepolia:
 *
 *   pnpm chain                                              (terminal 1)
 *   pnpm deploy:localhost                                   (terminal 2: the game, then the vault)
 *   npx hardhat --network localhost dno:vault-demo
 *
 *   npx hardhat --network sepolia dno:vault-demo            (after `hardhat deploy --network sepolia --tags Vault`)

 *
 * It mints a test NFT, seals it, lists it on Seaport with the vault as the seller, buys it the
 * way any marketplace buyer would, and sends the ETH to an address with no history; then seals a
 * second NFT and takes it out to another fresh address. Every request is sent with the box key
 * (here a random one), never with the holder's address. On Sepolia the buyer is the same wallet:
 * a demo, not a trade. The two "fresh" addresses are the team's kept test wallets (see CLAUDE.md).
 */

const ACTION = { Withdraw: 0, List: 1, Unlist: 2, Claim: 3 } as const;
const REQUEST_STATUS = ["none", "pending", "done", "refused: wrong key", "stale: the box changed first", "expired: no proof within a day"];
const BOX_STATE = ["none", "sealed", "listed", "sold", "withdrawn", "claimed"];
const ZERO = "0x0000000000000000000000000000000000000000";

const ORDER_PARAMETERS =
  "(address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)";
const SEAPORT_ABI = [
  `function fulfillOrder((${ORDER_PARAMETERS} parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool)`,
  "function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)",
];

async function setup(hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments, fhevm } = hre;
  await fhevm.initializeCLIApi();
  const signers = await ethers.getSigners();
  const holder = signers[0];
  if (!holder) throw new Error("No account configured. Set MNEMONIC or PRIVATE_KEY in .env (see .env.example).");
  const buyer = signers[1] ?? holder;
  const vault = await ethers.getContractAt("SealedVault", (await deployments.get("SealedVault")).address, holder);
  const nft = await ethers.getContractAt("VaultTestNFT", (await deployments.get("VaultTestNFT")).address, holder);
  const seaport = new ethers.Contract(await vault.seaport(), SEAPORT_ABI, buyer);
  return { ethers, fhevm, holder, buyer, vault, nft, seaport, vaultAddress: await vault.getAddress() };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Mints a test NFT to the holder and seals it with `key`. Returns the box id. */
async function seal(c: Ctx, key: bigint) {
  const tokenId = BigInt(c.ethers.hexlify(c.ethers.randomBytes(6)));
  await (await c.nft.mint(c.holder.address, tokenId)).wait();
  await (await c.nft.approve(c.vaultAddress, tokenId)).wait();
  const input = await c.fhevm.createEncryptedInput(c.vaultAddress, c.holder.address).add256(key).encrypt();
  const boxId = await c.vault.tokenCount();
  const tx = await c.vault.deposit(await c.nft.getAddress(), tokenId, input.handles[0]!, [], [], input.inputProof);
  await tx.wait();
  console.log(`  sealed test NFT #${tokenId} in box ${boxId} (tx ${tx.hash})`);
  return boxId;
}

/** Asks for `action` with the key bound to its terms, then relays the proof. Returns the status. */
async function ask(c: Ctx, boxId: bigint, action: number, key: bigint, terms: { to?: string; price?: bigint; endTime?: number } = {}) {
  const [to, price, endTime] = [terms.to ?? ZERO, terms.price ?? 0n, terms.endTime ?? 0];
  const { nonce } = await c.vault.boxInfo(boxId);
  const hash = await c.vault.requestHash(boxId, nonce, action, to, price, endTime);
  const input = await c.fhevm.createEncryptedInput(c.vaultAddress, c.holder.address).add256(key ^ hash).encrypt();
  const requestId = await c.vault.requestCount();
  const tx = await c.vault.request(boxId, action, to, price, endTime, input.handles[0]!, input.inputProof);
  await tx.wait();
  console.log(`  request ${requestId} sent (tx ${tx.hash}); fetching the "key matched" bit and its KMS proof...`);
  const { ok } = await c.vault.requestInfo(requestId);
  const result = await c.fhevm.publicDecrypt([ok]);
  const fin = await c.vault.finalize(requestId, result.abiEncodedClearValues, result.decryptionProof);
  await fin.wait();
  const status = REQUEST_STATUS[Number((await c.vault.requestInfo(requestId)).status)];
  console.log(`  finalised in tx ${fin.hash}: ${status}`);
  return status;
}

task("dno:vault-demo", "Seals a test NFT, sells it on Seaport from the vault, and takes another out to a fresh address").setAction(async (_args, hre) => {
  const c = await setup(hre);
  const key = BigInt(c.ethers.hexlify(c.ethers.randomBytes(32)));
  const fmt = (wei: bigint) => `${c.ethers.formatEther(wei)} ETH`;
  console.log(`Vault ${c.vaultAddress}, Seaport ${await c.vault.seaport()}, holder ${c.holder.address}, buyer ${c.buyer.address}`);

  console.log("\n1. Seal an NFT and list it on Seaport (the vault is the seller)");
  const boxId = await seal(c, key);
  const price = c.ethers.parseEther("0.0001");
  const endTime = Math.floor(Date.now() / 1000) + 86_400;
  await ask(c, boxId, ACTION.List, key, { price, endTime });
  const listingId = (await c.vault.boxInfo(boxId)).listing - 1n;
  const listing = await c.vault.listingInfo(listingId);
  console.log(`  listed for ${fmt(price)}: Seaport order ${listing.orderHash}`);

  console.log("\n2. A buyer fills the Seaport order, as on any Seaport marketplace");
  const parameters = plain(await c.vault.seaportOrder(listingId));
  const fill = await c.seaport.fulfillOrder!({ parameters, signature: "0x" }, c.ethers.ZeroHash, { value: price });
  await fill.wait();
  console.log(`  filled in tx ${fill.hash}; the NFT is now ${await c.nft.ownerOf((await c.vault.boxInfo(boxId)).tokenId)}`);
  await (await c.vault.sync(boxId)).wait();
  const sold = await c.vault.boxInfo(boxId);
  console.log(`  box ${boxId} is ${BOX_STATE[Number(sold.state)]}: ${fmt(sold.proceeds)} wait for the key's holder`);

  console.log("\n3. The ETH goes to an address with no history");
  const fresh = testWallet("vault-proceeds", "receives the vault demo's Seaport sale ETH").address;
  await ask(c, boxId, ACTION.Claim, key, { to: fresh });
  console.log(`  ${fresh} holds ${fmt(await c.ethers.provider.getBalance(fresh))}`);

  console.log("\n4. A wrong key is refused, without a revert");
  const other = await seal(c, key);
  await ask(c, other, ACTION.Withdraw, key ^ 1n, { to: c.holder.address });

  console.log("\n5. The right key takes the NFT out to another fresh address");
  const out = testWallet("vault-withdrawals", "receives the NFTs the vault demo takes out").address;
  await ask(c, other, ACTION.Withdraw, key, { to: out });
  console.log(`  NFT #${(await c.vault.boxInfo(other)).tokenId} is now held by ${await c.nft.ownerOf((await c.vault.boxInfo(other)).tokenId)}`);
});

/** An ethers Result as plain objects and arrays, the way a contract call takes it back. */
function plain(value: unknown): unknown {
  if (!(value instanceof Array)) return value;
  const r = value as unknown[] & { toObject?: () => Record<string, unknown> };
  const items = [...r].map(plain);
  const keys = r.toObject ? Object.keys(r.toObject()).filter((k) => !/^\d+$/.test(k)) : [];
  if (!keys.length || keys[0]!.startsWith("_")) return items;
  return Object.fromEntries(keys.map((k, i) => [k, items[i]]));
}
