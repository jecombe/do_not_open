import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { Contract, hexlify, type InterfaceAbi, type Signer, type Wallet } from "ethers";
import { ethers, fhevm } from "hardhat";
import { EvmPockets, type EvmPocketsTools, type PocketsDeployment } from "../../chain-adapter/src/evm/EvmPockets";
import { EvmPositions } from "../../chain-adapter/src/evm/EvmPositions";
import { rangeAround } from "../../chain-adapter/src/liquidity";
import type { ChainError } from "../../chain-adapter/src/types";
import { SealedPockets, SealedPositions, TestConfidentialToken, TestERC20 } from "../types";
import { deployUniswap, openPool, seedFullRange, swap, type Uniswap } from "./uniswap";

const PERMIT_DAYS = 1;
const FEE = 3000;
const deployed = (c: { target: unknown; interface: { formatJson(): string } }) => ({ address: String(c.target), abi: JSON.parse(c.interface.formatJson()) as InterfaceAbi });

/**
 * The adapter's positions (`EvmPositions`, what the vault's page runs on Sepolia) against the real
 * contracts on the local FHEVM and Uniswap V3's own bytecode: controllers derived from the pockets'
 * one signature, both encrypted inputs of a funding, the unwraps' proofs, the holder's signed
 * actions, all through a relay that sends from its own wallet.
 */
describe("EvmPositions (the adapter, on the local FHEVM)", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let relaySigner: HardhatEthersSigner;
  let trader: HardhatEthersSigner;
  let u: Uniswap;
  let usd: TestERC20;
  let eth: TestERC20;
  let cUsd: TestConfidentialToken;
  let cEth: TestConfidentialToken;
  let usdPockets: SealedPockets;
  let ethPockets: SealedPockets;
  let positions: SealedPositions;
  let pool: string;
  let token0: string;
  let token1: string;
  let tick: number;
  let chainId: number;

  function tools(wallet: HardhatEthersSigner): EvmPocketsTools {
    const permits = new Map<string, { publicKey: string; privateKey: string; signature: string; start: number }>();
    const contracts = () => [String(usdPockets.target), String(ethPockets.target), String(positions.target)];
    const userDecrypt = async (signer: Signer, handles: string[], contractAddress: string) => {
      const account = await signer.getAddress();
      let p = permits.get(account);
      if (!p) {
        const keypair = fhevm.generateKeypair();
        const start = Math.min(await time.latest(), Math.floor(Date.now() / 1000)) - 60;
        const eip712 = fhevm.createEIP712(keypair.publicKey, contracts(), start, PERMIT_DAYS);
        const signature = await signer.signTypedData(eip712.domain as never, { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification } as never, eip712.message as never);
        p = { publicKey: keypair.publicKey, privateKey: keypair.privateKey, signature, start };
        permits.set(account, p);
      }
      return (await fhevm.userDecrypt(handles.map((handle) => ({ handle, contractAddress })), p.privateKey, p.publicKey, p.signature.replace("0x", ""), contracts(), account, p.start, PERMIT_DAYS)) as Record<string, unknown>;
    };
    // The API's relayer, as `EthersVaultSender` sends: the same calls, from its own wallet.
    const relay = {
      address: relaySigner.address,
      pockets: async (call: string, args: Record<string, never>) => {
        const p = (usdPockets.attach(String(args.pockets ?? usdPockets.target)) as SealedPockets).connect(relaySigner);
        const s = positions.connect(relaySigner);
        const tx =
          call === "pocketOpen"
            ? await p.open(args.handle, args.inputProof, args.viewer)
            : call === "positionOpen"
              ? await s.open(args.range, args.controller, args.funds, args.keys)
              : call === "positionAdd"
                ? await s.add(args.positionId, args.funds, args.keys)
                : call === "positionSettle"
                  ? await s.settle(args.fundingId, args.clear0, args.proof0, args.clear1, args.proof1)
                  : call === "positionCollect"
                    ? await s.collect(args.positionId, args.out, args.deadline, args.signature)
                    : call === "positionDecrease"
                      ? await s.decrease(args.positionId, args.liquidity, args.amount0Min, args.amount1Min, args.out, args.deadline, args.signature)
                      : call === "positionGive"
                        ? await s.give(args.positionId, args.to, args.deadline, args.signature)
                        : await s.takeOut(args.positionId, args.to, args.deadline, args.signature);
        return tx.hash;
      },
    };
    return {
      chainId,
      explorerUrl: null,
      marketplaceUrl: null,
      readProvider: ethers.provider,
      account: async () => wallet.address,
      send: async (opts, call) => {
        opts?.onStep?.("wallet");
        const tx = await call();
        opts?.onStep?.("confirming");
        return (await tx.wait())!;
      },
      writer: (d) => new Contract(d.address, d.abi, wallet),
      reading: (read) => read,
      encrypt: async (contract, account, fill, _what, _opts, inputUser) =>
        (await (fill(fhevm.createEncryptedInput(contract, inputUser ?? account) as never) as never as { encrypt(): Promise<{ handles: Uint8Array[]; inputProof: Uint8Array }> }).encrypt()) as never,
      publicDecrypt: async (handles) => (await fhevm.publicDecrypt(handles)) as never,
      userDecrypt: (handles, contractAddress) => userDecrypt(wallet, handles, contractAddress),
      userDecryptAs: (signer: Wallet, handles, contractAddress) => userDecrypt(signer, handles, contractAddress),
      signText: (message) => wallet.signMessage(message),
      signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value),
      ensureOperator: async (token, account, operator) => {
        const c = new Contract(token.address, token.abi, wallet);
        if (!(await c.isOperator!(account, operator))) await (await c.setOperator!(operator, (await time.latest()) + 86_400)).wait();
      },
      cUsdc: async () => deployed(cUsd),
      faucets: true,
      relay: async () => relay as never,
      relayed: async (_opts, _call, sendIt) => (await ethers.provider.getTransactionReceipt(await sendIt()))! as never,
    };
  }

  /** What `dno:export` writes for a token's pockets: the cUSDC ones carry a desk. */
  async function pocketsDeployment(pockets: SealedPockets, token: TestConfidentialToken, underlying: TestERC20, withDesk: boolean): Promise<PocketsDeployment> {
    return {
      ...deployed(pockets),
      deployBlock: 0,
      desk: withDesk ? { address: ethers.ZeroAddress, abi: [], deployBlock: 0 } : null,
      token: {
        address: String(token.target),
        symbol: await token.symbol(),
        name: await token.name(),
        decimals: Number(await token.decimals()),
        rate: String(await token.rate()),
        underlying: { address: String(underlying.target), symbol: await underlying.symbol(), decimals: Number(await underlying.decimals()) },
      },
    };
  }

  /** One wallet's vault, as the page makes it: both tokens' pockets and the positions, on one signature. */
  async function vaultOf(wallet: HardhatEthersSigner) {
    const t = tools(wallet);
    let signature: Promise<string> | null = null;
    const pocketSignature = () => (signature ??= wallet.signMessage(`pocket key ${String(usdPockets.target)}`));
    const shared = { ...t, pocketSignature };
    const usdSide = new EvmPockets(await pocketsDeployment(usdPockets, cUsd, usd, true), { vault: deployed(positions), box: async () => ({}) as never, keyFor: async () => 0n }, shared);
    const ethSide = new EvmPockets(await pocketsDeployment(ethPockets, cEth, eth, false), { vault: deployed(positions), box: async () => ({}) as never, keyFor: async () => 0n }, shared);
    const sides = [usdSide, ethSide];
    const lp = new EvmPositions(
      {
        ...deployed(positions),
        deployBlock: 0,
        uniswap: { factory: String(u.factory.target), positionManager: String(u.positionManager.target), swapRouter: String(u.router.target) },
        routerVersion: 1,
        pools: [{ address: pool, token0, token1, fee: FEE }],
      },
      {
        pocketTokens: () => sides.map((s) => s.token),
        pocketsOf: (underlying) => sides.find((s) => s.token.underlying.address.toLowerCase() === underlying.toLowerCase()) ?? null,
        pocketSignature,
      },
      shared,
    );
    return { usdSide, ethSide, lp };
  }

  /** Dollars and ethers, in the pockets' confidential units, in Uniswap's order. */
  const amounts = (dollars: string, ethers_: string): [bigint, bigint] => {
    const [d, e] = [ethers.parseUnits(dollars, 6), ethers.parseUnits(ethers_, 6)];
    return BigInt(String(usd.target)) < BigInt(String(eth.target)) ? [d, e] : [e, d];
  };

  async function fill(v: Awaited<ReturnType<typeof vaultOf>>, who: HardhatEthersSigner, dollars: string, ethers_: string) {
    for (const [side, token, wrapper, amount] of [
      [v.usdSide, usd, cUsd, ethers.parseUnits(dollars, 6)],
      [v.ethSide, eth, cEth, ethers.parseUnits(ethers_, 6)],
    ] as const) {
      const plain = amount * BigInt(await wrapper.rate());
      await (await token.mint(who.address, plain)).wait();
      await (await token.connect(who).approve(String(wrapper.target), plain)).wait();
      await (await wrapper.connect(who).wrap(who.address, plain)).wait();
      await side.open();
      await side.deposit(amount, { decoys: 1 });
    }
  }

  beforeEach(async function () {
    [deployer, alice, bob, relaySigner, , trader] = (await ethers.getSigners()) as HardhatEthersSigner[] as HardhatEthersSigner[];
    chainId = Number((await ethers.provider.getNetwork()).chainId);
    u = await deployUniswap(deployer);
    const erc20 = await ethers.getContractFactory("TestERC20");
    usd = (await erc20.deploy("USD Coin (Test)", "USDC", 6)) as unknown as TestERC20;
    eth = (await erc20.deploy("Wrapped Ether (Test)", "WETH", 18)) as unknown as TestERC20;
    const wrapper = await ethers.getContractFactory("TestConfidentialToken");
    cUsd = (await wrapper.deploy(String(usd.target), "Confidential USDC", "cUSDC")) as unknown as TestConfidentialToken;
    cEth = (await wrapper.deploy(String(eth.target), "Confidential WETH", "cWETH")) as unknown as TestConfidentialToken;
    const pocketsFactory = await ethers.getContractFactory("SealedPockets");
    usdPockets = (await pocketsFactory.deploy(String(cUsd.target), deployer.address)) as unknown as SealedPockets;
    ethPockets = (await pocketsFactory.deploy(String(cEth.target), deployer.address)) as unknown as SealedPockets;
    positions = (await (await ethers.getContractFactory("SealedPositions")).deploy(String(u.positionManager.target), deployer.address, deployer.address, 500)) as unknown as SealedPositions;
    for (const p of [usdPockets, ethPockets]) {
      await (await p.addDesk(String(positions.target))).wait();
      await (await positions.addPockets(String(p.target))).wait();
      // Strangers' pockets, for the decoys.
      for (let i = 0; i < 2; i++) {
        const input = await fhevm.createEncryptedInput(String(p.target), deployer.address).add256(BigInt(hexlify(ethers.randomBytes(32)))).encrypt();
        await (await p.open(input.handles[0]!, input.inputProof, ethers.Wallet.createRandom().address)).wait();
      }
    }
    const opened = await openPool(u, String(usd.target), String(eth.target), FEE, 1e18 / 2000e6);
    ({ token0, token1, tick } = opened);
    pool = String(opened.pool.target);
    await (await usd.mint(deployer.address, ethers.parseUnits("4000000", 6))).wait();
    await (await eth.mint(deployer.address, ethers.parseUnits("2000", 18))).wait();
    const [seed0, seed1] = opened.aFirst ? [ethers.parseUnits("4000000", 6), ethers.parseUnits("2000", 18)] : [ethers.parseUnits("2000", 18), ethers.parseUnits("4000000", 6)];
    await seedFullRange(u, deployer, token0, token1, FEE, seed0, seed1);
    await (await usd.mint(trader.address, ethers.parseUnits("1000000", 6))).wait();
    await (await eth.mint(trader.address, ethers.parseUnits("1000", 18))).wait();
  });

  it("opens a position out of both pockets through the relay, finds it from the signature, collects and closes it", async function () {
    const a = await vaultOf(alice);
    await fill(a, alice, "5000", "2");
    const info = await a.lp.info();
    expect(info.pools).to.have.length(1);
    const p = info.pools[0]!;
    const { tickLower, tickUpper } = rangeAround(p.tick, FEE, 10);
    const [a0, a1] = amounts("4000", "2");
    const positionId = await a.lp.open(pool, tickLower, tickUpper, a0, a1, { decoys: 2 });

    // The open and the settle went out from the relay; the position is the contract's on Uniswap.
    const opened = await positions.queryFilter(positions.filters.Opened(positionId));
    expect((await opened[0]!.getTransaction()).from).to.eq(relaySigner.address);
    const mine = await a.lp.mine();
    expect(mine.map((m) => m.positionId)).to.deep.eq([positionId]);
    expect(mine[0]!.status).to.eq("open");
    expect(mine[0]!.inRange).to.eq(true);
    expect(await u.positionManager.ownerOf!(mine[0]!.tokenId!)).to.eq(String(positions.target));
    // A fresh adapter for the same wallet (another device) finds it too.
    expect((await (await vaultOf(alice)).lp.mine()).map((m) => m.positionId)).to.deep.eq([positionId]);
    // Nobody else's.
    expect(await (await vaultOf(bob)).lp.mine()).to.deep.eq([]);

    const usdBefore = await a.usdSide.balance();
    for (let i = 0; i < 3; i++) {
      await swap(u, trader, String(usd.target), String(eth.target), FEE, ethers.parseUnits("20000", 6));
      await swap(u, trader, String(eth.target), String(usd.target), FEE, ethers.parseUnits("10", 18));
    }
    const earned = (await a.lp.mine())[0]!;
    expect(earned.fees0 + earned.fees1).to.be.greaterThan(0n);
    const got = await a.lp.collect(positionId);
    expect(got.amount0).to.be.greaterThan(0n);
    expect(await a.usdSide.balance()).to.be.greaterThan(usdBefore);

    await a.lp.remove(positionId, 5_000);
    expect((await a.lp.mine())[0]!.liquidity).to.be.greaterThan(0n);
    await a.lp.remove(positionId, 10_000);
    expect(await a.lp.mine()).to.deep.eq([]);
    expect((await positions.positionInfo(positionId)).status).to.eq(3n);
  });

  it("says a pocket was short, and nothing moved", async function () {
    const a = await vaultOf(alice);
    await fill(a, alice, "100", "0.01");
    const { tickLower, tickUpper } = rangeAround(tick, FEE, 10);
    const [a0, a1] = amounts("4000", "2");
    const before = await a.usdSide.balance();
    const error = (await a.lp.open(pool, tickLower, tickUpper, a0, a1).catch((e) => e)) as ChainError;
    expect(error.code).to.eq("not-yours");
    expect(await a.usdSide.balance()).to.eq(before);
    expect(await a.lp.mine()).to.deep.eq([]);
  });

  it("gives a position to another wallet's receive address, and lets it come in from a wallet", async function () {
    const a = await vaultOf(alice);
    const b = await vaultOf(bob);
    await fill(a, alice, "5000", "2");
    const { tickLower, tickUpper } = rangeAround(tick, FEE, 10);
    const [a0, a1] = amounts("2000", "1");
    const positionId = await a.lp.open(pool, tickLower, tickUpper, a0, a1);
    const to = await b.lp.receiveAddress();
    await a.lp.give(positionId, to);
    expect(await a.lp.mine()).to.deep.eq([]);
    expect((await b.lp.mine()).map((m) => m.positionId)).to.deep.eq([positionId]);
    // A used receive address is not handed out again.
    expect(await b.lp.receiveAddress()).to.not.eq(to);

    // Bob takes it out to his own wallet, then brings it back in.
    await b.lp.takeOut(positionId, bob.address);
    const held = await b.lp.walletPositions();
    expect(held).to.have.length(1);
    await (await u.positionManager.connect(bob).getFunction("approve")(String(positions.target), held[0]!.tokenId)).wait();
    const back = await b.lp.deposit(held[0]!.tokenId);
    expect((await b.lp.mine()).map((m) => m.positionId)).to.deep.eq([back]);
  });
});
