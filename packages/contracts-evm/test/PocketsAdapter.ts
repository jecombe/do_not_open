import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { Contract, hexlify, type InterfaceAbi, type Signer, type Wallet } from "ethers";
import { ethers, fhevm } from "hardhat";
import { EvmPockets, type EvmPocketsTools } from "../../chain-adapter/src/evm/EvmPockets";
import type { VaultBox } from "../../chain-adapter/src/vault";
import { PocketDesk, SealedPockets, SealedVault, TestConfidentialUSDC, TestERC721, TestUSDC } from "../types";
import { confidentialUsdcOf, usd } from "./helpers";
import { installDelegateRegistry, installSeaport } from "./seaport";

const STATES: VaultBox["state"][] = ["sealed", "sealed", "listed", "sold", "withdrawn", "claimed"];
const PERMIT_DAYS = 1;

/**
 * The adapter's pockets (`EvmPockets`, what the vault's page runs on Sepolia) against the real
 * contracts on the local FHEVM: the key and viewer from one signature, both inputs of a spend,
 * the sets, the relayer's path and the wallet's, the viewer's user decryption, and a purchase
 * from a pocket through the desk. Only the transport differs from Sepolia: the plugin's mock
 * stands in for Zama's relayer and KMS, and a fake relay sends from its own signer.
 */
describe("EvmPockets (the adapter, on the local FHEVM)", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let relaySigner: HardhatEthersSigner;
  let fresh: HardhatEthersSigner;
  let cUsdc: TestConfidentialUSDC;
  let pockets: SealedPockets;
  let desk: PocketDesk;
  let vault: SealedVault;
  let nft: TestERC721;

  const deployed = (c: { target: unknown; interface: { formatJson(): string } }) => ({ address: String(c.target), abi: JSON.parse(c.interface.formatJson()) as InterfaceAbi });

  /** What the page's adapter is given, for one connected wallet; with `relayed`, a relay that sends from its own wallet. */
  function tools(wallet: HardhatEthersSigner, relayed: boolean): EvmPocketsTools {
    const permits = new Map<string, { publicKey: string; privateKey: string; signature: string; start: number }>();
    const userDecrypt = async (signer: Signer, handles: string[], contractAddress: string) => {
      const account = await signer.getAddress();
      let p = permits.get(account);
      const contracts = [String(pockets.target), String(desk.target), String(vault.target), String(cUsdc.target), ...extraPermit];
      if (!p) {
        const keypair = fhevm.generateKeypair();
        // The mock checks the permit against the wall clock, which the chain may run ahead of.
        const start = Math.min(await time.latest(), Math.floor(Date.now() / 1000)) - 60;
        const eip712 = fhevm.createEIP712(keypair.publicKey, contracts, start, PERMIT_DAYS);
        const signature = await signer.signTypedData(eip712.domain as never, { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification } as never, eip712.message as never);
        p = { publicKey: keypair.publicKey, privateKey: keypair.privateKey, signature, start };
        permits.set(account, p);
      }
      return (await fhevm.userDecrypt(
        handles.map((handle) => ({ handle, contractAddress })),
        p.privateKey,
        p.publicKey,
        p.signature.replace("0x", ""),
        contracts,
        account,
        p.start,
        PERMIT_DAYS,
      )) as Record<string, unknown>;
    };
    // The API's relayer, as `EthersVaultSender` sends: the same calls, from its own wallet.
    const relay = {
      address: relaySigner.address,
      pockets: async (call: string, args: Record<string, unknown>) => {
        // Another token's pockets, when the call names them.
        const p = (args.pockets ? (pockets.attach(String(args.pockets)) as SealedPockets) : pockets).connect(relaySigner);
        const d = desk.connect(relaySigner);
        const a = args as never as Record<string, never>;
        const input = a.input as never as Record<string, string>;
        const spend = input && { amount: input.amount, target: input.target, inputProof: input.inputProof, boundKey: input.boundKey, keyProof: input.keyProof };
        const tx =
          call === "pocketOpen"
            ? await p.open(a.handle, a.inputProof, a.viewer)
            : call === "pocketSend"
              ? await p.send(a.from, a.to, spend!)
              : call === "pocketWithdraw"
                ? await p.withdraw(a.from, a.to, spend!)
                : call === "deskAsk"
                  ? await d.ask(a.saleId, a.handle, a.keyProof, a.boxKey)
                  : await d.buy(a.askId, a.cleartexts, a.proof, a.boxKey, a.boxKeyProof);
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
      cUsdc: async () => deployed(cUsdc),
      relay: async () => (relayed ? (relay as never) : null),
      relayed: async (_opts, _call, sendIt) => (await ethers.provider.getTransactionReceipt(await sendIt()))! as never,
    };
  }
  let chainId: number;
  /** Contracts the test's permits also name: another token's pockets. */
  let extraPermit: string[] = [];

  /** One wallet's pockets adapter, as the page makes it. The box key is a fixed secret per NFT, as `keyFor` derives one. */
  function adapter(wallet: HardhatEthersSigner, relayed = true) {
    return new EvmPockets(
      { ...deployed(pockets), deployBlock: 0, desk: { ...deployed(desk), deployBlock: 0 } },
      {
        vault: deployed(vault),
        box: async (boxId) => {
          const b = await vault.boxInfo(boxId);
          return {
            boxId,
            collection: b.collection,
            tokenId: b.tokenId,
            state: STATES[Number(b.state)]!,
            depositor: wallet.address,
            listing: null,
            proceeds: b.proceeds,
            delegate: null,
            busy: b.pending > 0n,
            tokenUri: "",
          };
        },
        keyFor: async (collection, tokenId) => BigInt(ethers.solidityPackedKeccak256(["address", "address", "uint256"], [wallet.address, collection, tokenId])),
      },
      tools(wallet, relayed),
    );
  }

  beforeEach(async function () {
    [deployer, alice, bob, relaySigner, fresh] = (await ethers.getSigners()) as HardhatEthersSigner[] as [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];
    chainId = Number((await ethers.provider.getNetwork()).chainId);
    const usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    cUsdc = (await (await ethers.getContractFactory("TestConfidentialUSDC")).deploy(await usdc.getAddress())) as unknown as TestConfidentialUSDC;
    const seaport = await installSeaport();
    const registry = await installDelegateRegistry();
    const weth = await (await ethers.getContractFactory("TestWETH")).deploy();
    const offers = await (await ethers.getContractFactory("VaultOffers")).deploy(await seaport.getAddress(), await weth.getAddress());
    nft = (await (await ethers.getContractFactory("TestERC721")).deploy()) as unknown as TestERC721;
    vault = (await (await ethers.getContractFactory("SealedVault")).deploy(
      await seaport.getAddress(), await cUsdc.getAddress(), await offers.getAddress(), await registry.getAddress(), deployer.address, deployer.address, 250,
    )) as unknown as SealedVault;
    await (await vault.setCollection(await nft.getAddress(), true)).wait();
    pockets = (await (await ethers.getContractFactory("SealedPockets")).deploy(await cUsdc.getAddress(), deployer.address)) as unknown as SealedPockets;
    desk = (await (await ethers.getContractFactory("PocketDesk")).deploy(await pockets.getAddress(), await vault.getAddress())) as unknown as PocketDesk;
    await (await pockets.setDesk(await desk.getAddress())).wait();
    for (const who of [alice, bob]) {
      await (await usdc.mint(who.address, usd("100"))).wait();
      await (await usdc.connect(who).approve(await cUsdc.getAddress(), usd("100"))).wait();
      await (await cUsdc.connect(who).wrap(who.address, usd("100"))).wait();
    }
    // Strangers' pockets, for the decoys.
    for (let i = 0; i < 3; i++) {
      const input = await fhevm.createEncryptedInput(await pockets.getAddress(), deployer.address).add256(BigInt(hexlify(ethers.randomBytes(32)))).encrypt();
      await (await pockets.open(input.handles[0]!, input.inputProof, ethers.Wallet.createRandom().address)).wait();
    }
  });

  it("opens a pocket from one signature, puts cUSDC in, sends it to another pocket and takes it out, through the relay", async function () {
    const a = adapter(alice);
    const b = adapter(bob);
    expect(await a.mine()).to.eq(null);
    const pa = await a.open();
    const pb = await b.open();
    expect(await a.mine()).to.eq(pa);
    // The open went out from the relay: alice's address is on none of it.
    const opened = await pockets.queryFilter(pockets.filters.Opened(pa));
    expect((await opened[0]!.getTransaction()).from).to.eq(relaySigner.address);

    await a.deposit(usd("40"), { decoys: 2 });
    expect(await a.balance()).to.eq(usd("40"));
    expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(usd("60"));

    await a.send(pb, usd("15"), { decoys: 3 });
    expect(await a.balance()).to.eq(usd("25"));
    expect(await b.balance()).to.eq(usd("15"));
    const sent = await pockets.queryFilter(pockets.filters.Sent());
    expect((await sent[0]!.getTransaction()).from).to.eq(relaySigner.address);

    await b.withdraw(fresh.address, usd("5"));
    expect(await b.balance()).to.eq(usd("10"));
    expect(await confidentialUsdcOf(cUsdc, fresh)).to.eq(usd("5"));

    // A short balance moves nothing, and says nothing.
    await a.send(pb, usd("26"));
    expect(await a.balance()).to.eq(usd("25"));
  });

  it("works from the wallet when there is no relayer", async function () {
    const a = adapter(alice, false);
    const pa = await a.open();
    await a.deposit(usd("10"));
    await a.withdraw(fresh.address, usd("4"));
    expect(await a.balance()).to.eq(usd("6"));
    expect(await confidentialUsdcOf(cUsdc, fresh)).to.eq(usd("4"));
    expect(pa).to.be.greaterThan(2);
  });

  it("finds the same pocket again from a fresh page, and another wallet's key opens nothing", async function () {
    const pa = await adapter(alice).open();
    await adapter(alice).deposit(usd("10"));
    expect(await adapter(alice).mine()).to.eq(pa);
    expect(await adapter(alice).balance()).to.eq(usd("10"));
    // Bob cannot spend alice's pocket: his page sends with his own key, which matches none.
    const b = adapter(bob);
    await b.open();
    await b.withdraw(bob.address, 1n).catch(() => undefined);
    expect(await adapter(alice).balance()).to.eq(usd("10"));
  });

  it("sells a box to a pocket, and the pocket's page reads the price, buys it and finds the box", async function () {
    const buyer = adapter(alice);
    const pa = await buyer.open();
    await buyer.deposit(usd("50"));

    // Bob seals an NFT and offers it to alice's pocket.
    await (await nft.mint(bob.address, 9)).wait();
    await (await nft.connect(bob).approve(await vault.getAddress(), 9)).wait();
    const key = await fhevm.createEncryptedInput(await vault.getAddress(), bob.address).add256(1n).encrypt();
    await (await vault.connect(bob).deposit(await nft.getAddress(), 9, key.handles[0]!, [], [], key.inputProof)).wait();
    const seller = adapter(bob);
    const saleId = await seller.offerSale(0, pa, usd("20"));

    const [sale] = await buyer.sales();
    expect(sale).to.include({ saleId, boxId: 0, status: "open", pocketId: pa });
    expect(await buyer.salePrices([saleId])).to.deep.eq({ [saleId]: usd("20") });
    expect(await buyer.buy(saleId)).to.eq(true);
    expect(await buyer.balance()).to.eq(usd("30"));
    expect(await buyer.boxes()).to.deep.eq([0]);
    expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(usd("100") + usd("20") - usd("0.5"));
  });

  it("says not-yours when the pocket cannot cover the price, and the sale stays open", async function () {
    const buyer = adapter(alice);
    const pa = await buyer.open();
    await buyer.deposit(usd("5"));
    await (await nft.mint(bob.address, 9)).wait();
    await (await nft.connect(bob).approve(await vault.getAddress(), 9)).wait();
    const key = await fhevm.createEncryptedInput(await vault.getAddress(), bob.address).add256(1n).encrypt();
    await (await vault.connect(bob).deposit(await nft.getAddress(), 9, key.handles[0]!, [], [], key.inputProof)).wait();
    const saleId = await adapter(bob).offerSale(0, pa, usd("20"));
    let code = "";
    await buyer.buy(saleId).catch((e: { code?: string }) => (code = e.code ?? ""));
    expect(code).to.eq("not-yours");
    expect((await vault.saleInfo(saleId)).status).to.eq(1n);
    expect(await buyer.balance()).to.eq(usd("5"));
  });
  it("opens another token's pockets (no desk) from the same signature, with their own pocket and viewer", async function () {
    // A second confidential token and its pockets, as cUSDT's on Sepolia: the same contract, no desk.
    const usdt = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    const cUsdt = (await (await ethers.getContractFactory("TestConfidentialUSDC")).deploy(await usdt.getAddress())) as unknown as TestConfidentialUSDC;
    const other = (await (await ethers.getContractFactory("SealedPockets")).deploy(await cUsdt.getAddress(), deployer.address)) as unknown as SealedPockets;
    extraPermit = [String(other.target), String(cUsdt.target)];
    const input = await fhevm.createEncryptedInput(await other.getAddress(), deployer.address).add256(BigInt(hexlify(ethers.randomBytes(32)))).encrypt();
    await (await other.open(input.handles[0]!, input.inputProof, ethers.Wallet.createRandom().address)).wait();

    // One signature for both, as the vault's page asks it.
    let signatures = 0;
    const base = tools(alice, true);
    const shared: EvmPocketsTools = {
      ...base,
      cUsdc: async () => deployed(cUsdt),
      pocketSignature: async () => {
        signatures++;
        return alice.signMessage("one signature");
      },
    };
    const token = { address: String(cUsdt.target), symbol: "cUSDT", name: "Confidential USDT", decimals: 6, rate: "1", underlying: { address: String(usdt.target), symbol: "USDT", decimals: 6 } };
    const theirs = new EvmPockets({ ...deployed(other), deployBlock: 0, token }, { vault: deployed(vault), box: async () => ({}) as never, keyFor: async () => 0n }, shared);
    const mine = new EvmPockets({ ...deployed(pockets), deployBlock: 0, desk: { ...deployed(desk), deployBlock: 0 } }, { vault: deployed(vault), box: async () => ({}) as never, keyFor: async () => 0n }, shared);
    expect(theirs.token.symbol).to.eq("cUSDT");
    expect((await theirs.info()).desk).to.eq(null);

    const id = await theirs.open();
    await mine.open();
    expect(signatures).to.eq(2);
    // Their viewers differ: nothing on-chain ties the two pockets together.
    const viewerOther = await other.viewerOf(id);
    const viewerMine = await pockets.viewerOf((await mine.mine())!);
    expect(viewerOther).to.not.eq(viewerMine);

    await (await usdt.mint(alice.address, usd("30"))).wait();
    expect(await theirs.plainBalance()).to.eq(usd("30"));
    await theirs.shield(usd("20"));
    await theirs.deposit(usd("20"), { decoys: 1 });
    expect(await theirs.balance()).to.eq(usd("20"));
    await theirs.withdraw(fresh.address, usd("8"));
    expect(await theirs.balance()).to.eq(usd("12"));
    expect(await confidentialUsdcOf(cUsdt, fresh)).to.eq(usd("8"));
    // The withdrawal went out from the relay, to the cUSDT pockets.
    const out = await other.queryFilter(other.filters.Withdrawn());
    expect((await out[0]!.getTransaction()).from).to.eq(relaySigner.address);
    expect(await theirs.sales()).to.deep.eq([]);
    extraPermit = [];
  });
});
