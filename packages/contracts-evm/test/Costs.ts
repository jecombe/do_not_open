import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ContractTransactionResponse } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { ethers, fhevm } from "hardhat";
import { whitelistParamsFromSpec } from "../lib/specParams";
import {
  deploy,
  deployEconomy,
  finalizeDuel,
  finalizeRequest,
  giveCroquettes,
  mintBoxes,
  requestIdOf,
} from "./helpers";

/**
 * Gas and HCU of every player action, measured on the local FHEVM, which runs the same host
 * contracts as Sepolia and mainnet. `REPORT_COSTS=1 pnpm test test/Costs.ts` prints the table
 * the docs quote.
 */
describe("Costs", function () {
  before(function () {
    if (!fhevm.isMock || !process.env.REPORT_COSTS) this.skip();
  });

  it("prints gas and HCU per action", async function () {
    const [, alice, bob, carol] = (await ethers.getSigners()) as HardhatEthersSigner[] as [
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
    ];
    const { dno, address, usdc, cUsdc } = await deploy();
    const { croq, cCroq, pantry, pantryAddress } = await deployEconomy(dno);
    const rows: { action: string; gas: number; hcu: number; depth: number }[] = [];
    const measure = async (action: string, tx: Promise<ContractTransactionResponse>) => {
      const receipt = (await (await tx).wait())!;
      const hcu = fhevm.computeTransactionHCU(receipt);
      rows.push({ action, gas: Number(receipt.gasUsed), hcu: hcu.globalHCU, depth: hcu.maxHCUDepth });
      return receipt;
    };

    const buy = async (who: HardhatEthersSigner, n: number, ids: number) => {
      const input = await fhevm.createEncryptedInput(address, who.address).add8(n).encrypt();
      return measure(`mint (${n} box${n > 1 ? "es" : ""} among ${ids} ids)`, dno.connect(who).mint(input.handles[0]!, input.inputProof, ids));
    };
    await buy(alice, 1, 1);
    await buy(alice, 1, 3);
    await buy(alice, 3, 5);
    await buy(alice, 10, 10);
    const A = (await mintBoxes(dno, alice, 3)).owned;
    const B = (await mintBoxes(dno, bob, 3)).owned;

    await measure("confidentialTransfer", dno.connect(alice).confidentialTransfer(bob.address, A[2]!));
    const decoy = await fhevm.createEncryptedInput(address, bob.address).addBool(false).encrypt();
    await measure("confidentialTransferIf (decoy)", dno.connect(bob).confidentialTransferIf(carol.address, A[2]!, decoy.handles[0]!, decoy.inputProof));
    await measure("shake (holder, free)", dno.connect(alice).shake(A[0]!));
    await measure("paidShake", dno.connect(carol).paidShake(A[0]!));
    await measure("claimEarnings (1 box)", dno.connect(alice).claimEarnings([A[0]!]));
    await measure("feed (affection)", dno.connect(carol).feed(A[0]!));

    let r = await measure("proveAlive, request", dno.connect(alice).proveAlive(A[1]!));
    await measure("proveAlive, finalize", finalizeRequest(dno, requestIdOf(dno, r), carol));

    await measure("postDuel (first score)", dno.connect(alice).postDuel(A[0]!, 0, false));
    await measure("finalizeDuel, holding proof", finalizeDuel(dno, 0, carol));
    await measure("acceptDuel (first score)", dno.connect(bob).acceptDuel(0, B[0]!));
    await measure("finalizeDuel, outcome", finalizeDuel(dno, 0, carol));

    await measure("proposeEntangle", dno.connect(alice).proposeEntangle(A[0]!, B[1]!));
    r = await measure("acceptEntangle", dno.connect(bob).acceptEntangle(A[0]!, B[1]!));
    await measure("finalize entangle", finalizeRequest(dno, requestIdOf(dno, r), carol));

    r = await measure("observe (+ entangled partner)", dno.connect(alice).observe(A[0]!));
    await measure("finalize opening (2 boxes)", finalizeRequest(dno, requestIdOf(dno, r), carol));
    r = await measure("observe (single box)", dno.connect(bob).observe(B[0]!));
    await measure("finalize opening (1 box)", finalizeRequest(dno, requestIdOf(dno, r), carol));

    await giveCroquettes(croq, cCroq, bob, 1_000n);
    await (await cCroq.connect(bob).setOperator(pantryAddress, (await time.latest()) + 86_400 * 365)).wait();
    const meal = await fhevm.createEncryptedInput(pantryAddress, bob.address).add64(100n).encrypt();
    await measure("Pantry.feed", pantry.connect(bob).feed(B[2]!, meal.handles[0]!, meal.inputProof));
    await measure("Pantry.claim (3 boxes, welcome)", pantry.connect(bob).claim(B));
    await time.increase(86_400);
    await measure("Pantry.claim (3 boxes, purr)", pantry.connect(bob).claim(B));

    // The flea market: a box listed by alice, bought by carol; a rat sold to a secret offer.
    const hooks = await (await ethers.getContractFactory("DoNotOpenHooks")).deploy(address);
    const rats = await (await ethers.getContractFactory("Rats")).deploy(
      await usdc.getAddress(), alice.address, alice.address, alice.address, 1_000_000, 3_000_000, "", 10, 10, 5, 10,
    );
    const market = await (await ethers.getContractFactory("FleaMarket")).deploy(
      address, await hooks.getAddress(), await rats.getAddress(), await cUsdc.getAddress(), alice.address, alice.address, 250,
    );
    const marketAddress = await market.getAddress();
    const nextYear = (await time.latest()) + 86_400 * 365;
    for (const who of [alice, bob, carol]) {
      await (await cUsdc.connect(who).setOperator(marketAddress, nextYear)).wait();
      await (await dno.connect(who).setOperator(marketAddress, nextYear)).wait();
      await (await rats.connect(who).setApprovalForAll(marketAddress, true)).wait();
    }
    await measure("FleaMarket.list (box)", market.connect(alice).list(0, A[1]!, 25_000_000));
    let proof = await fhevm.publicDecrypt([(await market.listingInfo(0)).arrived]);
    await measure("FleaMarket.finalizeListing", market.connect(carol).finalizeListing(0, proof.abiEncodedClearValues, proof.decryptionProof));
    await measure("FleaMarket.buy", market.connect(carol).buy(0));
    proof = await fhevm.publicDecrypt([(await market.purchaseInfo(0)).ok]);
    await measure("FleaMarket.finalizePurchase (box)", market.connect(bob).finalizePurchase(0, proof.abiEncodedClearValues, proof.decryptionProof));
    await (await usdc.mint(bob.address, 1_000_000)).wait();
    await (await usdc.connect(bob).approve(await rats.getAddress(), 1_000_000)).wait();
    await (await rats.connect(bob).mintSeed(1, 1_000_000)).wait();
    await measure("FleaMarket.list (rat)", market.connect(bob).list(1, 1, 5_000_000));
    const offer = await fhevm.createEncryptedInput(marketAddress, carol.address).add64(4_000_000n).encrypt();
    await measure("FleaMarket.makeOffer", market.connect(carol).makeOffer(1, offer.handles[0]!, offer.inputProof));
    await measure("FleaMarket.acceptOffer (rat)", market.connect(bob).acceptOffer(0));

    // The whitelist's gifts: first class (croquettes, a box, a rat) and economy (croquettes, a rat).
    const gifts = await (await ethers.getContractFactory("WhitelistGifts")).deploy(
      address, await rats.getAddress(), await cCroq.getAddress(), await cUsdc.getAddress(), whitelistParamsFromSpec().tiers, alice.address,
    );
    const giftsAddress = await gifts.getAddress();
    await (await rats.connect(alice).setGiver(giftsAddress)).wait();
    await (await croq.approve(await cCroq.getAddress(), 1_000)).wait();
    await (await cCroq.wrap(giftsAddress, 1_000)).wait();
    await (await usdc.mint(alice.address, 10_000_000)).wait();
    await (await usdc.connect(alice).approve(await cUsdc.getAddress(), 10_000_000)).wait();
    await (await cUsdc.connect(alice).wrap(giftsAddress, 10_000_000)).wait();
    const tree = StandardMerkleTree.of<[string, number]>([[bob.address, 0], [carol.address, 2]], ["address", "uint8"]);
    await (await gifts.connect(alice).setRoot(tree.root, (await time.latest()) + 86_400)).wait();
    const box = await fhevm.createEncryptedInput(address, giftsAddress).add8(1).encrypt();
    await measure("WhitelistGifts.claim (first class)", gifts.connect(bob).claim(0, tree.getProof(0), box.handles[0]!, box.inputProof, 77n));
    await measure("WhitelistGifts.claim (economy)", gifts.connect(carol).claim(2, tree.getProof(1), ethers.ZeroHash, "0x", 78n));

    console.table(rows);
  });
});
