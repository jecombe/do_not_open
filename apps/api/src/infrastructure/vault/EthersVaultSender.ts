import { Contract, isError, NonceManager, Wallet, type Provider } from "ethers";
import { VaultRelayRefused } from "../../application/vaultRelay";
import type { PocketCall, PocketSpendInput, PocketTxs, PositionFunds, PositionKeys, PositionOut, VaultFinalizeTx, VaultRequestTx, VaultSender } from "../../application/ports/vault";
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

const RANGE = "(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper)";
const FUNDS = "(uint256[] set0, uint256[] set1, bytes32 amount0, bytes32 amount1, bytes32 target0, bytes32 target1, bytes inputProof, uint256 amount0Min, uint256 amount1Min, uint64 deadline)";
const KEYS = "(bytes32 boundKey0, bytes32 boundKey1, bytes keyProof)";
const OUT = "(uint256[] set0, uint256[] set1, bytes32 target0, bytes32 target1, bytes inputProof)";
const POSITIONS_ABI = [
  `function open(${RANGE} r, address controller, ${FUNDS} f, ${KEYS} k) returns (uint256, uint256)`,
  `function add(uint256 positionId, ${FUNDS} f, ${KEYS} k) returns (uint256)`,
  "function settle(uint256 fundingId, uint64 clear0, bytes proof0, uint64 clear1, bytes proof1)",
  `function collect(uint256 positionId, ${OUT} o, uint64 deadline, bytes signature)`,
  `function decrease(uint256 positionId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, ${OUT} o, uint64 deadline, bytes signature)`,
  "function give(uint256 positionId, address to, uint64 deadline, bytes signature)",
  "function takeOut(uint256 positionId, address to, uint64 deadline, bytes signature)",
  "error ZeroAddress()",
  "error NotATokenHere(address token)",
  "error BadRange()",
  "error ControllerUsed(address controller)",
  "error NotOpen(uint256 positionId)",
  "error NotAPosition(uint256 positionId)",
  "error FundingNotPending(uint256 fundingId)",
  "error NotController()",
  "error Expired()",
  "error KeyUsed()",
  "error NotAPocket(uint256 pocketId)",
  "error BadSet()",
  "error OnlyDesk()",
];

const spendTuple = (i: PocketSpendInput) => [i.amount, i.target, i.inputProof, i.boundKey, i.keyProof];
const fundsTuple = (f: PositionFunds) => [f.set0, f.set1, f.amount0, f.amount1, f.target0, f.target1, f.inputProof, f.amount0Min, f.amount1Min, f.deadline];
const keysTuple = (k: PositionKeys) => [k.boundKey0, k.boundKey1, k.keyProof];
const outTuple = (o: PositionOut) => [o.set0, o.set1, o.target0, o.target1, o.inputProof];

/**
 * The relayer's wallet, sending to the SealedVault, and to its pockets, their desk and the
 * liquidity positions where they are deployed. Each call is estimated first, so what the
 * vault would refuse costs nothing. Replicas share the key: a nonce taken by another one is
 * retried with a fresh count.
 */
export class EthersVaultSender implements VaultSender {
  readonly address: Address;
  private readonly signer: NonceManager;
  private readonly vault: Contract;
  private readonly pocketsContract: Contract | null;
  /** Every token's pockets by lowercase address, the cUSDC ones included. */
  private readonly pocketsByAddress = new Map<string, Contract>();
  private readonly desk: Contract | null;
  private readonly positions: Contract | null;
  private readonly provider: Provider;

  constructor(
    privateKey: string,
    vaultAddress: string,
    provider: Provider,
    pockets?: { address: string; desk: string | null; others?: string[]; positions?: string | null } | null,
  ) {
    this.provider = provider;
    const wallet = new Wallet(privateKey, provider);
    this.address = normalizeAddress(wallet.address);
    this.signer = new NonceManager(wallet);
    this.vault = new Contract(vaultAddress, VAULT_ABI, this.signer);
    this.pocketsContract = pockets ? new Contract(pockets.address, POCKETS_ABI, this.signer) : null;
    this.desk = pockets?.desk ? new Contract(pockets.desk, DESK_ABI, this.signer) : null;
    this.positions = pockets?.positions ? new Contract(pockets.positions, POSITIONS_ABI, this.signer) : null;
    for (const address of pockets ? [pockets.address, ...(pockets.others ?? [])] : []) {
      this.pocketsByAddress.set(address.toLowerCase(), new Contract(address, POCKETS_ABI, this.signer));
    }
  }

  private thePositions(): Contract {
    if (!this.positions) throw new VaultRelayRefused("reverted", "There are no liquidity positions on this network.");
    return this.positions;
  }

  private theDesk(): Contract {
    if (!this.desk) throw new VaultRelayRefused("reverted", "There is no pocket desk on this network.");
    return this.desk;
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
      case "deskAsk": {
        const t = tx as PocketTxs["deskAsk"];
        return this.sendTo(this.theDesk(), "ask", [t.saleId, t.handle, t.keyProof, t.boxKey]);
      }
      case "deskBuy": {
        const t = tx as PocketTxs["deskBuy"];
        return this.sendTo(this.theDesk(), "buy", [t.askId, t.cleartexts, t.proof, t.boxKey, t.boxKeyProof]);
      }
      case "positionOpen": {
        const t = tx as PocketTxs["positionOpen"];
        const r = t.range;
        return this.sendTo(this.thePositions(), "open", [[r.token0, r.token1, r.fee, r.tickLower, r.tickUpper], t.controller, fundsTuple(t.funds), keysTuple(t.keys)]);
      }
      case "positionAdd": {
        const t = tx as PocketTxs["positionAdd"];
        return this.sendTo(this.thePositions(), "add", [t.positionId, fundsTuple(t.funds), keysTuple(t.keys)]);
      }
      case "positionSettle": {
        const t = tx as PocketTxs["positionSettle"];
        return this.sendTo(this.thePositions(), "settle", [t.fundingId, t.clear0, t.proof0, t.clear1, t.proof1]);
      }
      case "positionCollect": {
        const t = tx as PocketTxs["positionCollect"];
        return this.sendTo(this.thePositions(), "collect", [t.positionId, outTuple(t.out), t.deadline, t.signature]);
      }
      case "positionDecrease": {
        const t = tx as PocketTxs["positionDecrease"];
        return this.sendTo(this.thePositions(), "decrease", [t.positionId, t.liquidity, t.amount0Min, t.amount1Min, outTuple(t.out), t.deadline, t.signature]);
      }
      case "positionGive": {
        const t = tx as PocketTxs["positionGive"];
        return this.sendTo(this.thePositions(), "give", [t.positionId, t.to, t.deadline, t.signature]);
      }
      default: {
        const t = tx as PocketTxs["positionTakeOut"];
        return this.sendTo(this.thePositions(), "takeOut", [t.positionId, t.to, t.deadline, t.signature]);
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

  private send(method: "request" | "finalize" | "finalizeOffer", args: unknown[]): Promise<string> {
    return this.sendTo(this.vault, method, args);
  }

  private async sendTo(contract: Contract, method: string, args: unknown[]): Promise<string> {
    const fn = contract.getFunction(method);
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
