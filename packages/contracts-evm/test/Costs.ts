import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ContractTransactionResponse } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers, fhevm } from "hardhat";
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
    const { dno, address } = await deploy();
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
    await measure("shake (holder, free)", dno.connect(alice).shake(A[0]!));
    await measure("paidShake", dno.connect(carol).paidShake(A[0]!));
    await measure("claimEarnings (1 box)", dno.connect(alice).claimEarnings([A[0]!]));
    await measure("feed (affection)", dno.connect(carol).feed(A[0]!));

    let r = await measure("proveAlive, request", dno.connect(alice).proveAlive(A[1]!));
    await measure("proveAlive, finalize", finalizeRequest(dno, requestIdOf(dno, r), carol));

    await measure("challengeDuel (first score)", dno.connect(alice).challengeDuel(A[0]!, B[0]!));
    await measure("acceptDuel (first score)", dno.connect(bob).acceptDuel(0));
    await measure("finalizeDuel", finalizeDuel(dno, 0, carol));

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

    console.table(rows);
  });
});
