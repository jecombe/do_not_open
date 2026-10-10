import { spawn, type ChildProcess } from "node:child_process";
import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { OPENSEA, SEAPORT_1_6 } from "../lib/opensea";

/**
 * Replays a real OpenSea offer, one that a contract accepted on mainnet, with VaultOffers in
 * that contract's place, on a local fork of mainnet taken just before the fill:
 *
 *   npx hardhat dno:opensea-replay --tx 0xd49327e0f801e4c9ad58c63096f572b9edbbaafbdf9b471dfd097bd4ff97923f
 *
 * OpenSea's offers live off-chain, and filling one needs a signature from OpenSea's server
 * (its signed zone), made for the one address that fills it: there is no way to make one on a
 * test network. A fill that already happened carries both in its calldata, so the fork puts
 * VaultOffers' code at the address OpenSea signed for, hands it the NFT, and lets it fill the
 * very same order through the real Seaport 1.6, the real zone and the real conduit. Nothing
 * leaves the machine: no key, no gas, no deployment.
 *
 * Needs `anvil` (Foundry) on the PATH, or `--rpc` to an anvil already forked at the block before
 * the fill, and a mainnet RPC with archive state and `debug_traceTransaction`
 * (`MAINNET_RPC_URL`; eth.drpc.org, the default, serves both for free as of 2026-10-10).
 *
 * To find such fills: Seaport 1.6's `OrderFulfilled` logs with OpenSea's zone where the offer
 * item is WETH and the transaction's `to` is a contract other than Seaport.
 */

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ORDER_PARAMETERS =
  "(address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)";
const ADVANCED_ORDER = `(${ORDER_PARAMETERS} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)`;
const CRITERIA_RESOLVER = "(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)";
const SEAPORT_CALLS = [
  `function matchAdvancedOrders(${ADVANCED_ORDER}[] orders,${CRITERIA_RESOLVER}[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient) payable returns (bool)`,
  `function fulfillAdvancedOrder(${ADVANCED_ORDER} advancedOrder,${CRITERIA_RESOLVER}[] criteriaResolvers,bytes32 fulfillerConduitKey,address recipient) payable returns (bool)`,
];
const NFT_ABI = ["function ownerOf(uint256) view returns (address)", "function transferFrom(address,address,uint256)"];

type Call = { from: string; to?: string; input: string; calls?: Call[] };

task("dno:opensea-replay", "Replays a real OpenSea offer a contract accepted on mainnet, with VaultOffers in its place, on a local fork")
  .addParam("tx", "The mainnet transaction that filled the offer")
  .addOptionalParam("rpc", "An anvil already forked at the block before the fill (otherwise one is started on :8546)")
  .setAction(async ({ tx, rpc }: { tx: string; rpc?: string }, hre: HardhatRuntimeEnvironment) => {
    const { ethers } = hre;
    const forkUrl = process.env.MAINNET_RPC_URL || "https://eth.drpc.org";
    const mainnet = new ethers.JsonRpcProvider(forkUrl, 1, { staticNetwork: true });

    // 1. The fill as it happened: the buyer's order, OpenSea's zone signature in its extraData.
    const receipt = await mainnet.getTransactionReceipt(tx);
    if (!receipt) throw new Error(`No transaction ${tx} on mainnet.`);
    const timestamp = (await mainnet.getBlock(receipt.blockNumber))!.timestamp;
    const trace = (await mainnet.send("debug_traceTransaction", [tx, { tracer: "callTracer" }])) as Call;
    const calls: Call[] = [];
    const walk = (c: Call) => {
      calls.push(c);
      c.calls?.forEach(walk);
    };
    walk(trace);
    const seaportCalls = new ethers.Interface(SEAPORT_CALLS);
    let fulfiller = "";
    let offer: { parameters: Record<string, unknown>; numerator: bigint; denominator: bigint; signature: string; extraData: string } | undefined;
    let criteriaProof: string[] = [];
    for (const c of calls) {
      if ((c.to ?? "").toLowerCase() !== SEAPORT_1_6.toLowerCase()) continue;
      const parsed = seaportCalls.parseTransaction({ data: c.input });
      if (!parsed) continue;
      const orders = parsed.name === "matchAdvancedOrders" ? [...parsed.args[0]] : [parsed.args[0]];
      const index = orders.findIndex((o) => o.parameters.offer.some((i: { token: string }) => i.token.toLowerCase() === WETH.toLowerCase()));
      if (index < 0) continue;
      fulfiller = ethers.getAddress(c.from);
      offer = orders[index];
      const resolver = [...parsed.args[1]].find((r) => Number(r.orderIndex) === index);
      criteriaProof = resolver ? [...resolver.criteriaProof] : [];
      break;
    }
    if (!offer) throw new Error(`No Seaport 1.6 fill of a WETH offer in ${tx}.`);
    const nftItem = (offer.parameters.consideration as { itemType: bigint; token: string; identifierOrCriteria: bigint }[]).find((i) => i.itemType === 2n || i.itemType === 4n);
    if (!nftItem) throw new Error("The offer asks for no ERC-721.");
    const collection = nftItem.token;
    const tokenId = nftItem.itemType === 4n ? BigInt((receipt.logs.find((l) => l.address.toLowerCase() === collection.toLowerCase() && l.topics.length === 4)?.topics[3]) ?? 0) : nftItem.identifierOrCriteria;
    const amount = (offer.parameters.offer as { startAmount: bigint }[])[0]!.startAmount;
    console.log(`Mainnet fill ${tx} (block ${receipt.blockNumber}): ${fulfiller} sold ${collection} #${tokenId} to ${offer.parameters.offerer as string}'s offer of ${ethers.formatEther(amount)} WETH`);

    // 2. A fork of mainnet just before it, its clock there too: OpenSea's signature expires.
    let anvil: ChildProcess | undefined;
    const url = rpc ?? "http://127.0.0.1:8546";
    if (!rpc) {
      anvil = spawn("anvil", ["--fork-url", forkUrl, "--fork-block-number", String(receipt.blockNumber - 1), "--port", "8546", "--silent"], { stdio: "ignore" });
      anvil.on("error", () => {
        throw new Error("anvil (Foundry) is not on the PATH: install it, or pass --rpc to a fork of your own.");
      });
    }
    const fork = new ethers.JsonRpcProvider(url, 1, { staticNetwork: true, cacheTimeout: -1 });
    try {
      for (let i = 0; i < 60; i++) {
        try {
          await fork.getBlockNumber();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      console.log(`Fork at block ${await fork.getBlockNumber()} (${url})`);
      await fork.send("evm_setNextBlockTimestamp", [Number(timestamp) - 6]);

      // 3. VaultOffers, its code where OpenSea signed for.
      const deployer = await fork.getSigner(0);
      const artifact = await hre.artifacts.readArtifact("VaultOffers");
      const deployed = await (await new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy(SEAPORT_1_6, WETH)).waitForDeployment();
      await fork.send("anvil_setCode", [fulfiller, await fork.getCode(await deployed.getAddress())]);
      const offers = new ethers.Contract(fulfiller, artifact.abi, deployer);
      console.log(`VaultOffers (Seaport 1.6, zone ${OPENSEA.zone}) put at ${fulfiller}`);

      // 4. The NFT, from whoever holds it (the original fulfiller most often).
      const nft = new ethers.Contract(collection, NFT_ABI, fork);
      const owner = (await nft.ownerOf!(tokenId)) as string;
      if (owner.toLowerCase() !== fulfiller.toLowerCase()) {
        await fork.send("anvil_impersonateAccount", [owner]);
        await fork.send("anvil_setBalance", [owner, "0x" + (10n ** 18n).toString(16)]);
        await (await nft.connect(await fork.getSigner(owner)).getFunction("transferFrom")(owner, fulfiller, tokenId)).wait();
      }

      // 5. The fill, with the order exactly as `finalizeOffer` takes it.
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        [ADVANCED_ORDER, "bytes32[]"],
        [[offer.parameters, offer.numerator, offer.denominator, offer.signature, offer.extraData], criteriaProof],
      );
      const [orderHash, buyer, fillable] = (await offers.inspect!(encoded, collection, tokenId, 1n)) as [string, string, boolean];
      console.log(`inspect: order ${orderHash}, buyer ${buyer}, fillable ${fillable}`);
      // A fresh wallet: anvil's own accounts are real mainnet addresses, some with code of their own.
      const caller = ethers.Wallet.createRandom().connect(fork);
      const callerAddress = await caller.getAddress();
      await fork.send("anvil_setBalance", [callerAddress, "0x" + (10n ** 18n).toString(16)]);
      const before = await fork.getBalance(callerAddress);
      const fill = await offers.connect(caller).getFunction("fill")(encoded, collection, tokenId, { gasLimit: 3_000_000 });
      const r = await fill.wait();
      const got = (await fork.getBalance(callerAddress)) - before + BigInt(r.gasUsed) * BigInt(r.gasPrice);
      const newOwner = (await nft.ownerOf!(tokenId)) as string;
      console.log(`filled in ${r.hash} (${r.gasUsed} gas): the NFT is ${newOwner}'s, ${ethers.formatEther(got)} ETH came to the caller`);
      if (newOwner.toLowerCase() !== (offer.parameters.offerer as string).toLowerCase()) throw new Error("The NFT did not reach the buyer.");
      if (got <= 0n) throw new Error("No ETH came back.");
      console.log("OK: VaultOffers filled a real OpenSea offer through OpenSea's signed zone.");
    } finally {
      fork.destroy();
      anvil?.kill();
    }
  });
