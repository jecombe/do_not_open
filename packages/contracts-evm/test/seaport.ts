import { ethers } from "hardhat";
import { OPENSEA } from "../lib/opensea";
import type { IDelegateRegistry, ISeaport, VaultListings } from "../types";
import registryFixture from "./fixtures/delegate-registry-v2.json";
import fixture from "./fixtures/seaport-1.5.json";
import fixture16 from "./fixtures/seaport-1.6.json";

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
 * Puts the real Seaport 1.6, its ConduitController and OpenSea's conduit on the local network, at
 * their mainnet addresses: the runtime code and the storage they hold there
 * (test/fixtures/seaport-1.6.json, read with eth_getCode and eth_getStorageAt), the conduit with
 * its channel open to Seaport 1.6. This is what OpenSea lists with on mainnet (Sepolia has the
 * same three, but nothing signs for OpenSea's zone there).
 */
async function installSeaport16(): Promise<ISeaport> {
  for (const { address, code, storage } of [fixture16.seaport, fixture16.conduitController, fixture16.conduit] as {
    address: string;
    code: string;
    storage?: Record<string, string>;
  }[]) {
    await ethers.provider.send("hardhat_setCode", [address, code]);
    for (const [slot, value] of Object.entries(storage ?? {})) {
      await ethers.provider.send("hardhat_setStorageAt", [address, slot, value]);
    }
  }
  return (await ethers.getContractAt("ISeaport", fixture16.seaport.address)) as unknown as ISeaport;
}

/**
 * OpenSea as on mainnet: Seaport 1.6 and its conduit (above), a stand-in for its signed zone at
 * the zone's address (mocks/TestZone.sol says yes to every order; the real one wants a signature
 * from OpenSea's server), and VaultListings writing orders for them. Without the zone, it is
 * Sepolia: the same Seaport and conduit, open orders.
 */
export async function installOpenSea(withZone = true): Promise<{ seaport: ISeaport; listings: VaultListings }> {
  const seaport = await installSeaport16();
  const zone = await (await ethers.getContractFactory("TestZone")).deploy();
  await ethers.provider.send("hardhat_setCode", [OPENSEA.zone, await ethers.provider.getCode(await zone.getAddress())]);
  const [owner] = await ethers.getSigners();
  const factory = await ethers.getContractFactory("VaultListings");
  const listings = (await factory.deploy(
    await seaport.getAddress(),
    withZone ? OPENSEA.zone : ethers.ZeroAddress,
    OPENSEA.conduitKey,
    OPENSEA.conduit,
    owner!.address,
  )) as unknown as VaultListings;
  return { seaport, listings };
}

/**
 * Puts delegate.xyz's Delegate Registry v2 on the local network, at its usual address, from its
 * Sepolia runtime code (test/fixtures/delegate-registry-v2.json). It has no constructor state.
 */
export async function installDelegateRegistry(): Promise<IDelegateRegistry> {
  await ethers.provider.send("hardhat_setCode", [registryFixture.address, registryFixture.code]);
  return (await ethers.getContractAt("IDelegateRegistry", registryFixture.address)) as unknown as IDelegateRegistry;
}

/**
 * VaultListings as on Sepolia, where OpenSea is not: open orders, no zone, no conduit, no fees.
 * What the vault's tests list with; `installOpenSea` lists the way OpenSea does on mainnet.
 */
export async function deployOpenListings(seaport: ISeaport): Promise<VaultListings> {
  const [owner] = await ethers.getSigners();
  const factory = await ethers.getContractFactory("VaultListings");
  return (await factory.deploy(await seaport.getAddress(), ethers.ZeroAddress, ethers.ZeroHash, ethers.ZeroAddress, owner!.address)) as unknown as VaultListings;
}
