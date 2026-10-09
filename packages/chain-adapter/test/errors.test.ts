import { AbstractProvider, FeeData, Interface, makeError, VoidSigner, type PerformActionRequest } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { SEPOLIA, SEPOLIA_DEPLOYMENT } from "../src/evm/chains";
import { EvmFhevmAdapter } from "../src/evm/EvmFhevmAdapter";
import { toChainError } from "../src/evm/errors";
import { ChainError } from "../src";

const iface = new Interface(SEPOLIA_DEPLOYMENT.abi);
const ME = "0x00000000000000000000000000000000000000aa";

describe("toChainError", () => {
  const code = (error: unknown) => toChainError(error, [iface]).code;

  it("knows a refusal in the wallet, however it is wrapped", () => {
    expect(code(makeError("user rejected action", "ACTION_REJECTED", { action: "sendTransaction", reason: "rejected" }))).toBe("rejected");
    expect(code({ code: 4001, message: "MetaMask Tx Signature: User denied transaction signature." })).toBe("rejected");
    expect(code({ info: { error: { code: 4001, message: "denied" } } })).toBe("rejected");
    expect(code({ code: 5000, message: "User rejected." })).toBe("rejected");
  });

  it("tells a busy wallet, a wrong network and a missing account apart", () => {
    expect(code({ code: -32002, message: "Request of type 'wallet_requestPermissions' already pending" })).toBe("wallet-busy");
    expect(code({ code: 4901, message: "Chain disconnected" })).toBe("wrong-network");
    expect(code(makeError("network changed: 1 => 11155111", "NETWORK_ERROR", { event: "changed" }))).toBe("wrong-network");
    expect(code({ code: 4100, message: "Unauthorized" })).toBe("not-connected");
  });

  it("finds missing gas money in a wallet's plain English", () => {
    expect(code(makeError("insufficient funds", "INSUFFICIENT_FUNDS", { transaction: {} }))).toBe("insufficient-funds");
    expect(code({ code: -32603, message: "Internal JSON-RPC error.", data: { code: -32000, message: "insufficient funds for gas * price + value" } })).toBe("insufficient-funds");
    expect(code({ error: { message: "err: insufficient funds for gas * price + value: address 0x… have 0 want 1" } })).toBe("insufficient-funds");
  });

  it("knows a stuck nonce", () => {
    expect(code({ message: "nonce too low: next nonce 12, tx nonce 11" })).toBe("nonce");
    expect(code(makeError("replacement fee too low", "REPLACEMENT_UNDERPRICED", { transaction: {} as never }))).toBe("nonce");
  });

  it("reads the contract's error name wherever the wallet put the revert data", () => {
    const data = iface.encodeErrorResult("DuelExpired", []);
    const nested = toChainError({ code: -32603, message: "Internal JSON-RPC error.", info: { error: { code: 3, message: "execution reverted", data } } }, [iface]);
    expect(nested).toMatchObject({ code: "reverted", reason: "DuelExpired" });
    expect(toChainError({ message: "reverted with custom error 'NotThisBox()'" }, [iface]).reason).toBe("NotThisBox");
    expect(toChainError({ message: "gas required exceeds allowance (30000000)" }, [iface])).toMatchObject({ code: "reverted", reason: "OutOfGas" });
  });

  it("says when a failed transaction made it into a block", () => {
    const e = toChainError(makeError("transaction execution reverted", "CALL_EXCEPTION", { action: "sendTransaction", data: null, reason: null, invocation: null, revert: null, transaction: { to: null, from: ME, data: "" }, receipt: {} as never }), [iface]);
    expect(e).toMatchObject({ code: "reverted", reason: undefined, detail: { mined: true } });
  });

  it("puts a public endpoint that does not answer down to the network", () => {
    expect(code(new TypeError("Failed to fetch"))).toBe("network");
    expect(code({ code: 429, message: "Too Many Requests" })).toBe("network");
    expect(code(makeError("timeout", "TIMEOUT", { operation: "x", reason: "timeout" }))).toBe("network");
    expect(code(new Error("something else entirely"))).toBe("unknown");
  });

  it("leaves a ChainError as it is", () => {
    const e = new ChainError("not-yours", "no");
    expect(toChainError(e, [iface])).toBe(e);
  });
});

/** A node that refuses or prices whatever is sent to it, as `estimateGas` says. */
class Node extends AbstractProvider {
  constructor(private readonly estimate: () => bigint, private readonly balance: bigint) {
    super(SEPOLIA.chainId, { staticNetwork: true } as never);
  }
  override async _perform<T>(req: PerformActionRequest): Promise<T> {
    switch (req.method) {
      case "chainId":
        return BigInt(SEPOLIA.chainId) as T;
      case "getBlockNumber":
        return 1000 as T;
      case "getTransactionCount":
        return 7 as T;
      case "getBalance":
        return this.balance as T;
      case "estimateGas":
        return this.estimate() as T;
      default:
        throw new Error(`unexpected ${req.method}`);
    }
  }
  override async _detectNetwork() {
    return { chainId: BigInt(SEPOLIA.chainId), name: "sepolia" } as never;
  }
  override async getFeeData() {
    return new FeeData(1_000_000_000n, null, null);
  }
}

function withNode(node: Node) {
  const wallet = new VoidSigner(ME, node);
  const sent = vi.spyOn(wallet, "sendTransaction").mockRejectedValue(new Error("the wallet was reached"));
  const adapter = new EvmFhevmAdapter({
    chain: SEPOLIA,
    address: SEPOLIA_DEPLOYMENT.address,
    abi: SEPOLIA_DEPLOYMENT.abi,
    readProvider: node,
    wallet: { current: () => wallet, options: () => [], connect: async () => wallet, disconnect: async () => {}, onChange: () => () => {} },
    loadRelayer: async () => Promise.reject(new Error("no relayer in tests")),
  });
  return { adapter, sent };
}

describe("EvmFhevmAdapter dry run", () => {
  it("stops a refused transaction before the wallet, with the contract's reason", async () => {
    const node = new Node(() => {
      throw makeError("execution reverted", "CALL_EXCEPTION", { action: "estimateGas", data: iface.encodeErrorResult("NotChallenger", []), reason: null, invocation: null, revert: null, transaction: { to: null, data: "" } });
    }, 10n ** 18n);
    const { adapter, sent } = withNode(node);
    await expect(adapter.cancelDuel(3)).rejects.toMatchObject({ code: "reverted", reason: "NotChallenger" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("says how much gas money is missing before the wallet asks", async () => {
    const { adapter, sent } = withNode(new Node(() => 2_000_000n, 10n ** 14n));
    const error: ChainError = await adapter.cancelDuel(3).catch((e) => e);
    expect(error).toMatchObject({ code: "insufficient-funds", detail: { held: 10n ** 14n, needed: 2_000_000n * 1_000_000_000n } });
    expect(sent).not.toHaveBeenCalled();
  });

  it("hands a transaction that would go through to the wallet", async () => {
    const { adapter, sent } = withNode(new Node(() => 100_000n, 10n ** 18n));
    await expect(adapter.cancelDuel(3)).rejects.toMatchObject({ code: "unknown" });
    expect(sent).toHaveBeenCalledOnce();
  });
});

describe("EvmFhevmAdapter allowance meter", () => {
  const fake = {
    generateKeypair: () => ({ publicKey: "", privateKey: "" }),
    createEIP712: () => ({}),
    userDecrypt: async () => ({}),
    publicDecrypt: async () => Promise.reject(new Error("refused")),
    createEncryptedInput: () => ({ add64() { return this; }, encrypt: async () => ({ handles: [], inputProof: new Uint8Array() }) }),
  };
  const make = (metered: boolean) =>
    new EvmFhevmAdapter({
      chain: SEPOLIA,
      address: SEPOLIA_DEPLOYMENT.address,
      abi: SEPOLIA_DEPLOYMENT.abi,
      readProvider: new Node(() => 0n, 0n),
      wallet: { current: () => null, options: () => [], connect: async () => { throw new Error("no wallet"); }, disconnect: async () => {}, onChange: () => () => {} },
      loadRelayer: async () => fake as never,
      metered,
    });
  // The relayer as the adapter's own calls see it.
  const relayerOf = (a: EvmFhevmAdapter) => (a as unknown as { loadRelayer(): Promise<typeof fake> }).loadRelayer();

  it("tells the meters once each counted call settles, refused ones too", async () => {
    const adapter = make(true);
    const spent = vi.fn();
    const stop = adapter.onAllowanceSpent(spent);
    const relayer = await relayerOf(adapter);
    await relayer.userDecrypt();
    await relayer.publicDecrypt().catch(() => undefined);
    await relayer.createEncryptedInput().add64().encrypt();
    expect(spent).toHaveBeenCalledTimes(3);
    stop();
    await relayer.userDecrypt();
    expect(spent).toHaveBeenCalledTimes(3);
  });

  it("stays quiet where nobody counts the decryptions", async () => {
    const adapter = make(false);
    const spent = vi.fn();
    adapter.onAllowanceSpent(spent);
    await (await relayerOf(adapter)).userDecrypt();
    expect(spent).not.toHaveBeenCalled();
  });
});
