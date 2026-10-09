import { ethers } from "hardhat";
import type { IDelegateRegistry, ISeaport } from "../types";
import registryFixture from "./fixtures/delegate-registry-v2.json";
import fixture from "./fixtures/seaport-1.5.json";

/**
 * Puts the real Seaport 1.5 on the local network, at its usual address: the runtime code OpenSea
 * deployed on Sepolia (test/fixtures/seaport-1.5.json, read with eth_getCode), so the vault is
 * tested against Seaport itself and not a stand-in. Seaport's constructor only sets its
 * reentrancy guard (storage slot 0) and immutables already in the code; its domain separator
 * follows the chain id on its own.
 */
export async function installSeaport(): Promise<ISeaport> {
  for (const { address, code } of [fixture.seaport, fixture.conduitController]) {
    await ethers.provider.send("hardhat_setCode", [address, code]);
  }
  for (const [slot, value] of Object.entries(fixture.seaport.storage)) {
    await ethers.provider.send("hardhat_setStorageAt", [fixture.seaport.address, slot, value]);
  }
  return (await ethers.getContractAt("ISeaport", fixture.seaport.address)) as unknown as ISeaport;
}

/**
 * Puts delegate.xyz's Delegate Registry v2 on the local network, at its usual address, from its
 * Sepolia runtime code (test/fixtures/delegate-registry-v2.json). It has no constructor state.
 */
export async function installDelegateRegistry(): Promise<IDelegateRegistry> {
  await ethers.provider.send("hardhat_setCode", [registryFixture.address, registryFixture.code]);
  return (await ethers.getContractAt("IDelegateRegistry", registryFixture.address)) as unknown as IDelegateRegistry;
}
