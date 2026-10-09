import { Contract, isError, NonceManager, Wallet, type Provider } from "ethers";
import { VaultRelayRefused } from "../../application/vaultRelay";
import type { VaultFinalizeTx, VaultRequestTx, VaultSender } from "../../application/ports/vault";
import { normalizeAddress, type Address } from "../../domain/types";

const VAULT_ABI = [
  "function request(uint256 boxId, uint8 action, address to, uint256 price, uint64 endTime, bytes32 ref, bytes32 boundKey, bytes inputProof) returns (uint256)",
  "function finalize(uint256 requestId, bytes abiEncodedCleartexts, bytes decryptionProof)",
  "function finalizeOffer(uint256 requestId, bytes abiEncodedCleartexts, bytes decryptionProof, bytes offer)",
  "error BoxBusy(uint256 boxId)",
  "error WrongState(uint256 boxId, uint8 state)",
  "error NotABox(uint256 boxId)",
  "error BadPrice()",
  "error BadEndTime()",
  "error ZeroAddress()",
  "error RequestNotPending()",
  "error NeedsOrder()",
  "error NotAnOffer()",
  "error WrongOrder()",
  "error OfferShort()",
];

/**
 * The relayer's wallet, sending to the SealedVault. Each call is estimated first, so what the
 * vault would refuse costs nothing. Replicas share the key: a nonce taken by another one is
 * retried with a fresh count.
 */
export class EthersVaultSender implements VaultSender {
  readonly address: Address;
  private readonly signer: NonceManager;
  private readonly vault: Contract;
  private readonly provider: Provider;

  constructor(privateKey: string, vaultAddress: string, provider: Provider) {
    this.provider = provider;
    const wallet = new Wallet(privateKey, provider);
    this.address = normalizeAddress(wallet.address);
    this.signer = new NonceManager(wallet);
    this.vault = new Contract(vaultAddress, VAULT_ABI, this.signer);
  }

  request(tx: VaultRequestTx): Promise<string> {
    return this.send("request", [tx.boxId, tx.action, tx.to, tx.price, tx.endTime, tx.ref, tx.handle, tx.inputProof]);
  }

  finalize(tx: VaultFinalizeTx): Promise<string> {
    if (tx.offer) return this.send("finalizeOffer", [tx.requestId, tx.cleartexts, tx.proof, tx.offer]);
    return this.send("finalize", [tx.requestId, tx.cleartexts, tx.proof]);
  }

  balance(): Promise<bigint> {
    return this.provider.getBalance(this.address);
  }

  private async send(method: "request" | "finalize" | "finalizeOffer", args: unknown[]): Promise<string> {
    const fn = this.vault.getFunction(method);
    try {
      await fn.estimateGas(...args);
    } catch (error) {
      const reason = isError(error, "CALL_EXCEPTION") ? (error.revert?.name ?? error.reason ?? "refused") : (error as Error).message;
      throw new VaultRelayRefused("reverted", `The vault would refuse it: ${reason}.`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return (await fn(...args)).hash as string;
      } catch (error) {
        if (attempt < 2 && (isError(error, "NONCE_EXPIRED") || isError(error, "REPLACEMENT_UNDERPRICED"))) {
          this.signer.reset();
          continue;
        }
        throw error;
      }
    }
  }
}
