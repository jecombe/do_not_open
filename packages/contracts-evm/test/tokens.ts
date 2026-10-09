import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { ethers, fhevm } from "hardhat";
import type { TestConfidentialUSDC } from "../types";

/** In USDC's smallest unit: 6 decimals. */
export const usd = (amount: string) => ethers.parseUnits(amount, 6);

/** What `who` holds in cUSDC, decrypted for them. */
export async function confidentialUsdcOf(cUsdc: TestConfidentialUSDC, who: HardhatEthersSigner) {
  const handle = await cUsdc.confidentialBalanceOf(who.address);
  if (handle === ethers.ZeroHash) return 0n;
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, await cUsdc.getAddress(), who);
}
