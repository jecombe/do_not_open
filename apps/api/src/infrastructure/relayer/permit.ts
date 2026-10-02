import { verifyTypedData } from "ethers";
import type { PermitVerifier, UserDecryptPermit } from "../../application/ports/relayer";
import { normalizeAddress } from "../../domain/types";

const TYPES = {
  UserDecryptRequestVerification: [
    { name: "publicKey", type: "bytes" },
    { name: "contractAddresses", type: "address[]" },
    { name: "startTimestamp", type: "uint256" },
    { name: "durationDays", type: "uint256" },
    { name: "extraData", type: "bytes" },
  ],
};

const prefixed = (h: string) => (h.startsWith("0x") ? h : `0x${h}`);

/**
 * Recovers who signed a user-decryption permit, with the EIP-712 domain the Relayer SDK's
 * `createEIP712` builds: the host chain's id and the decryption contract.
 */
export function eip712PermitVerifier(domain: { chainId: number; verifyingContract: string }): PermitVerifier {
  const d = { name: "Decryption", version: "1", chainId: domain.chainId, verifyingContract: domain.verifyingContract };
  return {
    signer: (p: UserDecryptPermit) =>
      normalizeAddress(
        verifyTypedData(
          d,
          TYPES,
          {
            publicKey: prefixed(p.publicKey),
            contractAddresses: p.contractAddresses,
            startTimestamp: p.startTimestamp,
            durationDays: p.durationDays,
            extraData: prefixed(p.extraData),
          },
          prefixed(p.signature),
        ),
      ),
  };
}
