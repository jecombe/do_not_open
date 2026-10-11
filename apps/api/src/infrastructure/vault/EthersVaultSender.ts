import { Contract, NonceManager, Wallet, type Provider } from "ethers";
import { VaultRelayRefused } from "../../application/vaultRelay";
import { revertReason, sendWithFreshNonce } from "./send";
import type { PocketCall, PocketSpendInput, PocketTxs, SavingsSpendInput, VaultFinalizeTx, VaultRequestTx, VaultSender } from "../../application/ports/vault";
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

const SPEND_INPUT = "(bytes32 amount, bytes32 target, bytes inputProof, bytes32 boundKey, bytes keyProof)";
const POCKETS_ABI = [
  "event Withdrawn(uint256[] from, address indexed to)",
  "function open(bytes32 key, bytes inputProof, address viewer) returns (uint256)",
  `function send(uint256[] from, uint256[] to, ${SPEND_INPUT} s)`,
  `function withdraw(uint256[] from, address to, ${SPEND_INPUT} s)`,
  "error ZeroAddress()",
  "error ViewerTaken(address viewer)",
  "error NotAPocket(uint256 pocketId)",
  "error BadSet()",
  "error KeyUsed()",
];
const DESK_ABI = [
  "function ask(uint256 saleId, bytes32 boundKey, bytes keyProof, bytes32 boxKey) returns (uint256)",
  "function buy(uint256 askId, bytes abiEncodedCleartexts, bytes decryptionProof, bytes32 boxKey, bytes boxKeyProof)",
  "error NotForDesk()",
  "error NotReserved()",
  "error KeyUsed()",
  "error AskNotPending()",
  "error WrongBoxKey()",
  "error NotAPocket(uint256 pocketId)",
];

const SAVINGS_INPUT = "(bytes32 amount, bytes inputProof, bytes32 boundKey, bytes keyProof)";
const SAVINGS_ABI = [
  `function save(uint256[] from, ${SAVINGS_INPUT} s)`,
  `function unsave(uint256[] from, ${SAVINGS_INPUT} s)`,
  "error NotAPocket(uint256 pocketId)",
  "error BadSet()",
  "error KeyUsed()",
];

const ANNOUNCER_ABI = ["function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
/** ERC-5564's scheme 1: secp256k1 with view tags. */
const STEALTH_SCHEME = 1;

/** What the relayer gives a side address as gas, and what the address must hold of the plain token to get it unpaid by a pocket. */
export interface FuelPolicy {
  wei: bigint;
  minPlain: bigint;
}

/** The pockets' contracts the relayer sends to, and the two the pockets' doors use. */
export interface PocketsForSender {
  address: string;
  desk: string | null;
  savings?: string | null;
  others?: string[];
  /** ERC-5564's announcer, where stealth payments are announced. */
  announcer?: string | null;
  /** The plain ERC-20 the cUSDC wraps: what an entry address holds before it collects. */
  underlying?: string | null;
}

const spendTuple = (i: PocketSpendInput) => [i.amount, i.target, i.inputProof, i.boundKey, i.keyProof];
const savingsTuple = (i: SavingsSpendInput) => [i.amount, i.inputProof, i.boundKey, i.keyProof];

/**
 * The relayer's wallet, sending to the SealedVault, and to its pockets, their desk and their
 * savings where they are deployed; announcing the pockets' stealth payments on ERC-5564's
 * announcer; and fueling a side address once (`fuel`), when it is one a pocket paid (a
 * `Withdrawn` to it on any of the pockets) or one that holds the plain token (an entry address
 * fed from outside), never sent a transaction and holds less than the fuel: the two checks keep
 * the fuel from being farmed with fresh addresses. Each call is estimated first, so what the
 * vault would refuse costs nothing. Replicas share the key: a nonce taken by another one is
 * retried with a fresh count.
 */
export class EthersVaultSender implements VaultSender {
  readonly address: Address;
  readonly fuel: bigint | null;
  private readonly signer: NonceManager;
  private readonly vault: Contract;
  private readonly pocketsContract: Contract | null;
  /** Every token's pockets by lowercase address, the cUSDC ones included. */
  private readonly pocketsByAddress = new Map<string, Contract>();
  private readonly desk: Contract | null;
  private readonly savings: Contract | null;
  private readonly announcer: Contract | null;
  private readonly underlying: Contract | null;
  private readonly fuelPolicy: FuelPolicy | null;
  private readonly provider: Provider;

  constructor(privateKey: string, vaultAddress: string, provider: Provider, pockets?: PocketsForSender | null, fuel?: FuelPolicy | null) {
    this.provider = provider;
    const wallet = new Wallet(privateKey, provider);
    this.address = normalizeAddress(wallet.address);
    this.signer = new NonceManager(wallet);
    this.vault = new Contract(vaultAddress, VAULT_ABI, this.signer);
    this.pocketsContract = pockets ? new Contract(pockets.address, POCKETS_ABI, this.signer) : null;
    this.desk = pockets?.desk ? new Contract(pockets.desk, DESK_ABI, this.signer) : null;
    this.savings = pockets?.savings ? new Contract(pockets.savings, SAVINGS_ABI, this.signer) : null;
    this.announcer = pockets?.announcer ? new Contract(pockets.announcer, ANNOUNCER_ABI, this.signer) : null;
    this.underlying = pockets?.underlying ? new Contract(pockets.underlying, ERC20_ABI, provider) : null;
    this.fuelPolicy = pockets && fuel && fuel.wei > 0n ? fuel : null;
    this.fuel = this.fuelPolicy?.wei ?? null;
    for (const address of pockets ? [pockets.address, ...(pockets.others ?? [])] : []) {
      this.pocketsByAddress.set(address.toLowerCase(), new Contract(address, POCKETS_ABI, this.signer));
    }
  }

  private theDesk(): Contract {
    if (!this.desk) throw new VaultRelayRefused("reverted", "There is no pocket desk on this network.");
    return this.desk;
  }

  private theSavings(): Contract {
    if (!this.savings) throw new VaultRelayRefused("reverted", "The pockets have no savings on this network.");
    return this.savings;
  }

  /** The pockets a call names: the cUSDC ones when it names none; refused when it names one not deployed here. */
  private pocketsFor(address: string | undefined): Contract {
    const c = address ? this.pocketsByAddress.get(address.toLowerCase()) : this.pocketsContract;
    if (!c) throw new VaultRelayRefused("reverted", "Those are not this vault's pockets.");
    return c;
  }

  async pockets<C extends PocketCall>(call: C, tx: PocketTxs[C]): Promise<string> {
    if (!this.pocketsContract) throw new VaultRelayRefused("reverted", "There are no pockets on this network.");
    switch (call) {
      case "pocketOpen": {
        const t = tx as PocketTxs["pocketOpen"];
        return this.sendTo(this.pocketsFor(t.pockets), "open", [t.handle, t.inputProof, t.viewer]);
      }
      case "pocketSend": {
        const t = tx as PocketTxs["pocketSend"];
        return this.sendTo(this.pocketsFor(t.pockets), "send", [t.from, t.to, spendTuple(t.input)]);
      }
      case "pocketWithdraw": {
        const t = tx as PocketTxs["pocketWithdraw"];
        return this.sendTo(this.pocketsFor(t.pockets), "withdraw", [t.from, t.to, spendTuple(t.input)]);
      }
      case "pocketSave": {
        const t = tx as PocketTxs["pocketSave"];
        return this.sendTo(this.theSavings(), "save", [t.from, savingsTuple(t.input)]);
      }
      case "pocketUnsave": {
        const t = tx as PocketTxs["pocketUnsave"];
        return this.sendTo(this.theSavings(), "unsave", [t.from, savingsTuple(t.input)]);
      }
      case "deskAsk": {
        const t = tx as PocketTxs["deskAsk"];
        return this.sendTo(this.theDesk(), "ask", [t.saleId, t.handle, t.keyProof, t.boxKey]);
      }
      case "stealthAnnounce": {
        const t = tx as PocketTxs["stealthAnnounce"];
        if (!this.announcer) throw new VaultRelayRefused("reverted", "There is no stealth announcer on this network.");
        return this.sendTo(this.announcer, "announce", [STEALTH_SCHEME, t.stealthAddress, t.ephemeralPubKey, t.metadata]);
      }
      case "fuel":
        return this.sendFuel((tx as PocketTxs["fuel"]).to);
      default: {
        const t = tx as PocketTxs["deskBuy"];
        return this.sendTo(this.theDesk(), "buy", [t.askId, t.cleartexts, t.proof, t.boxKey, t.boxKeyProof]);
      }
    }
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

  /** The fuel, once: to an address that never sent a transaction, holds less than the fuel, and was paid by a pocket or holds the plain token. */
  private async sendFuel(to: Address): Promise<string> {
    const policy = this.fuelPolicy;
    if (!policy) throw new VaultRelayRefused("reverted", "The relayer gives no gas on this network.");
    const [nonce, held] = await Promise.all([this.provider.getTransactionCount(to), this.provider.getBalance(to)]);
    if (nonce > 0) throw new VaultRelayRefused("reverted", "That address has sent transactions already: the fuel is for a first one.");
    if (held >= policy.wei) throw new VaultRelayRefused("reverted", "That address holds enough ETH already.");
    if (!(await this.paidByAPocket(to)) && !(await this.holdsPlain(to, policy.minPlain))) {
      throw new VaultRelayRefused("reverted", "The fuel is for an address a pocket paid, or one holding the plain token.");
    }
    return (await sendWithFreshNonce(this.signer, () => this.signer.sendTransaction({ to, value: policy.wei }) as never)).hash;
  }

  private async paidByAPocket(to: Address): Promise<boolean> {
    for (const pockets of this.pocketsByAddress.values()) {
      if ((await pockets.queryFilter(pockets.filters.Withdrawn!(null, to))).length) return true;
    }
    return false;
  }

  private async holdsPlain(to: Address, atLeast: bigint): Promise<boolean> {
    if (!this.underlying) return false;
    return BigInt(await this.underlying.balanceOf!(to)) >= atLeast;
  }

  private send(method: "request" | "finalize" | "finalizeOffer", args: unknown[]): Promise<string> {
    return this.sendTo(this.vault, method, args);
  }

  private async sendTo(contract: Contract, method: string, args: unknown[]): Promise<string> {
    const fn = contract.getFunction(method);
    try {
      await fn.estimateGas(...args);
    } catch (error) {
      throw new VaultRelayRefused("reverted", `The vault would refuse it: ${revertReason(error)}.`);
    }
    return (await sendWithFreshNonce(this.signer, () => fn(...args))).hash;
  }
}
