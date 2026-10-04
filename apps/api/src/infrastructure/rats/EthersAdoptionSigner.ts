import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import type { AdoptionSigner } from "../../application/ports/rats";
import { normalizeAddress, type Address } from "../../domain/types";

const ADOPT_TYPES = {
  Adopt: [
    { name: "minter", type: "address" },
    { name: "job", type: "bytes32" },
    { name: "uri", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
};

/** The attester's key, signing the EIP-712 `Adopt` that `Rats.mintModel` checks. */
export class EthersAdoptionSigner implements AdoptionSigner {
  readonly address: Address;
  private readonly wallet: Wallet;

  constructor(
    privateKey: string,
    private readonly domain: { chainId: number; verifyingContract: string },
  ) {
    this.wallet = new Wallet(privateKey);
    this.address = normalizeAddress(this.wallet.address);
  }

  jobRef(jobId: string): string {
    return keccak256(toUtf8Bytes(jobId));
  }

  sign(minter: Address, jobRef: string, uri: string, deadline: number): Promise<string> {
    return this.wallet.signTypedData(
      { name: "DO NOT OPEN Rats", version: "1", chainId: this.domain.chainId, verifyingContract: this.domain.verifyingContract },
      ADOPT_TYPES,
      { minter, job: jobRef, uri, deadline },
    );
  }
}
