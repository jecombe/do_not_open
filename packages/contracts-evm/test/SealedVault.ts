import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import type { ContractTransactionReceipt } from "ethers";
import { ethers, fhevm } from "hardhat";
import { IDelegateRegistry, ISeaport, SealedVault, TestConfidentialUSDC, TestERC721, TestUSDC, TestWETH, VaultListings, VaultOffers } from "../types";
import { confidentialUsdcOf, usd } from "./tokens";
import { OPENSEA } from "../lib/opensea";
import { deployOpenListings, installDelegateRegistry, installOpenSea, installSeaport } from "./seaport";

const BOX = { None: 0n, Sealed: 1n, Listed: 2n, Sold: 3n, Withdrawn: 4n, Claimed: 5n } as const;
const ACTION = { Withdraw: 0, List: 1, Unlist: 2, Claim: 3, AcceptOffer: 4, Delegate: 5 } as const;
const REQUEST = { None: 0n, Pending: 1n, Done: 2n, Refused: 3n, Stale: 4n, Expired: 5n } as const;
const DAY = 86_400;
/** Seaport 1.5's EIP-712 types, for an order a buyer signs. */
const SEAPORT_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};
const SALE = { None: 0n, Open: 1n, Settled: 2n, Cancelled: 3n } as const;
const FEE_BPS = 250n;
const feeOf = (price: bigint) => (price * FEE_BPS) / 10_000n;
const ETH = (amount: string) => ethers.parseEther(amount);

/** An ethers Result as plain objects and arrays, the way a contract call takes it back. */
const plain = (value: unknown): unknown => {
  if (!(value instanceof ethers.Result)) return value;
  let keys: string[];
  try {
    keys = Object.keys(value.toObject()).filter((k) => !/^\d+$/.test(k));
  } catch {
    // A list (of fees, say) has no names: ethers refuses to name its items.
    keys = [];
  }
  const items = [...value].map(plain);
  if (!keys.length || keys[0]!.startsWith("_")) return items;
  return Object.fromEntries(keys.map((k, i) => [k, items[i]]));
};

/** `n` decoy sends to fresh random addresses, as the app makes them. */
const decoys = (n: number) => Array.from({ length: n }, () => ({ to: ethers.Wallet.createRandom().address, really: false }));

/** A box key, as the app derives one: any 256-bit secret. */
const randomKey = () => BigInt(ethers.hexlify(ethers.randomBytes(32)));

describe("SealedVault", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  /** Sends requests and proofs for others: holds no box. */
  let relay: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  /** An address with no history, where a withdrawal lands. */
  let fresh: HardhatEthersSigner;
  let usdc: TestUSDC;
  let cUsdc: TestConfidentialUSDC;
  let nft: TestERC721;
  let seaport: ISeaport;
  let listings: VaultListings;
  let weth: TestWETH;
  let registry: IDelegateRegistry;
  let offers: VaultOffers;
  let vault: SealedVault;
  let vaultAddress: string;

  const keyInput = (sender: HardhatEthersSigner, key: bigint) =>
    fhevm.createEncryptedInput(vaultAddress, sender.address).add256(key).encrypt();

  type Send = { to: string; really: boolean };

  /** The deposit's arguments: the key, then each send's encrypted "really", under one proof. */
  async function depositInput(who: HardhatEthersSigner, key: bigint, sends: Send[] = []) {
    const builder = fhevm.createEncryptedInput(vaultAddress, who.address).add256(key);
    for (const s of sends) builder.addBool(s.really);
    const input = await builder.encrypt();
    return { key: input.handles[0]!, to: sends.map((s) => s.to), really: input.handles.slice(1), proof: input.inputProof };
  }

  /** Mints NFT `tokenId` to `who` and puts it in a box with `key`, sent on to `sends`. Returns the box id. */
  async function deposit(who: HardhatEthersSigner, tokenId: number, key: bigint, sends: Send[] = []) {
    await (await nft.mint(who.address, tokenId)).wait();
    await (await nft.connect(who).approve(vaultAddress, tokenId)).wait();
    const i = await depositInput(who, key, sends);
    const boxId = await vault.tokenCount();
    const receipt = await (await vault.connect(who).deposit(await nft.getAddress(), tokenId, i.key, i.to, i.really, i.proof)).wait();
    lastDeposit = receipt!;
    return boxId;
  }
  let lastDeposit: ContractTransactionReceipt;

  type Terms = { to?: string; price?: bigint; endTime?: number; ref?: string };

  /** What the holder's page encrypts for a request: the key bound to the request's terms. */
  async function boundKey(boxId: bigint, action: number, key: bigint, terms: Terms, sender: HardhatEthersSigner) {
    const { nonce } = await vault.boxInfo(boxId);
    const hash = await vault.requestHash(boxId, nonce, action, terms.to ?? ethers.ZeroAddress, terms.price ?? 0n, terms.endTime ?? 0, terms.ref ?? ethers.ZeroHash);
    return keyInput(sender, key ^ hash);
  }

  /** Step 1 of an action, sent by `sender` (the relay unless said otherwise) with `key`. */
  async function placeRequest(boxId: bigint, action: number, key: bigint, opts: Terms & { sender?: HardhatEthersSigner } = {}) {
    const sender = opts.sender ?? relay;
    const input = await boundKey(boxId, action, key, opts, sender);
    const id = await vault.requestCount();
    await (
      await vault
        .connect(sender)
        .request(boxId, action, opts.to ?? ethers.ZeroAddress, opts.price ?? 0n, opts.endTime ?? 0, opts.ref ?? ethers.ZeroHash, input.handles[0]!, input.inputProof)
    ).wait();
    return id;
  }

  async function finalize(requestId: bigint) {
    const { ok } = await vault.requestInfo(requestId);
    const result = await fhevm.publicDecrypt([ok]);
    await (await vault.connect(relay).finalize(requestId, result.abiEncodedClearValues, result.decryptionProof)).wait();
    return (await vault.requestInfo(requestId)).status;
  }

  async function act(boxId: bigint, action: number, key: bigint, opts: Parameters<typeof placeRequest>[3] = {}) {
    return finalize(await placeRequest(boxId, action, key, opts));
  }

  const inAWeek = async () => (await time.latest()) + 7 * 86_400;

  /** Lists a box on Seaport and returns the listing id. */
  async function list(boxId: bigint, key: bigint, price: bigint, endTime?: number) {
    const status = await act(boxId, ACTION.List, key, { price, endTime: endTime ?? (await inAWeek()) });
    expect(status).to.eq(REQUEST.Done);
    return (await vault.boxInfo(boxId)).listing - 1n;
  }

  /** What any Seaport buyer (OpenSea's included) sends: the vault's order, no signature. */
  async function fill(listingId: bigint, buyer: HardhatEthersSigner) {
    const { price, orderHash } = await vault.listingInfo(listingId);
    const parameters = plain(await listings.orderOf(orderHash)) as Awaited<ReturnType<VaultListings["orderOf"]>>;
    return seaport.connect(buyer).fulfillOrder({ parameters, signature: "0x" }, ethers.ZeroHash, { value: price });
  }

  /** Who really holds a box, read straight from the local coprocessor (mock only). */
  const holderOf = async (boxId: bigint) =>
    ethers.getAddress(await fhevm.debugger.decryptEaddress(await vault.confidentialOwnerOf(boxId)));

  async function giveCusdc(who: HardhatEthersSigner, amount: bigint) {
    await (await usdc.mint(who.address, amount)).wait();
    await (await usdc.connect(who).approve(await cUsdc.getAddress(), amount)).wait();
    await (await cUsdc.connect(who).wrap(who.address, amount)).wait();
    await (await cUsdc.connect(who).setOperator(vaultAddress, (await time.latest()) + 365 * 86_400)).wait();
  }

  async function offerSale(seller: HardhatEthersSigner, boxId: bigint, buyer: HardhatEthersSigner, price: bigint) {
    const input = await fhevm.createEncryptedInput(vaultAddress, seller.address).add64(price).encrypt();
    const id = await vault.saleCount();
    await (await vault.connect(seller).offerSale(boxId, buyer.address, input.handles[0]!, input.inputProof)).wait();
    return id;
  }

  async function acceptSale(saleId: bigint, buyer: HardhatEthersSigner, key: bigint) {
    const input = await keyInput(buyer, key);
    await (await vault.connect(buyer).acceptSale(saleId, input.handles[0]!, input.inputProof)).wait();
  }


  type Fee = { to: string; amount: bigint };
  type OfferOpts = {
    /** The token the offer asks for, or none: any token of the collection (criteria root 0). */
    tokenId?: number;
    /** Tokens the offer is for: a collection offer may take several, one share each. */
    units?: bigint;
    /** The order's own fees (a marketplace's, royalties), paid in WETH out of the price. */
    fees?: Fee[];
    /** Signed by the buyer (as on a marketplace) rather than validated on-chain by them. */
    signed?: boolean;
    /** Signed, and posted to the vault's offer board by someone else (the relay), as the vault's page does. */
    posted?: boolean;
    /** Asks for this NFT instead of the vault's collection's (an order trying to take another). */
    collection?: string;
    endTime?: number;
    /** Leaves the buyer's WETH unapproved: Seaport cannot take it. */
    noAllowance?: boolean;
    /** As OpenSea makes its offers: through OpenSea's conduit and behind its signed zone. */
    opensea?: boolean;
  };

  /** A buyer's Seaport offer: `price` WETH for one or more NFTs, as a marketplace makes one. */
  async function makeOffer(buyer: HardhatEthersSigner, price: bigint, opts: OfferOpts = {}) {
    await (await weth.connect(buyer).deposit({ value: price })).wait();
    const spender = opts.opensea ? OPENSEA.conduit : await seaport.getAddress();
    if (!opts.noAllowance) await (await weth.connect(buyer).approve(spender, price)).wait();
    const units = opts.units ?? 1n;
    const nftItem = {
      itemType: opts.tokenId === undefined ? 4 : 2, // ERC721_WITH_CRITERIA : ERC721
      token: opts.collection ?? (await nft.getAddress()),
      identifierOrCriteria: BigInt(opts.tokenId ?? 0),
      startAmount: units,
      endAmount: units,
      recipient: buyer.address,
    };
    const fees = (opts.fees ?? []).map((f) => ({
      itemType: 1,
      token: wethAddress,
      identifierOrCriteria: 0n,
      startAmount: f.amount,
      endAmount: f.amount,
      recipient: f.to,
    }));
    const components = {
      offerer: buyer.address,
      zone: opts.opensea ? OPENSEA.zone : ethers.ZeroAddress,
      offer: [{ itemType: 1, token: wethAddress, identifierOrCriteria: 0n, startAmount: price, endAmount: price }],
      consideration: [nftItem, ...fees],
      // PARTIAL_OPEN : FULL_OPEN; behind a zone, their RESTRICTED kinds.
      orderType: (units > 1n ? 1 : 0) + (opts.opensea ? 2 : 0),
      startTime: BigInt((await time.latest()) - 1),
      endTime: BigInt(opts.endTime ?? (await inAWeek())),
      zoneHash: ethers.ZeroHash,
      salt: BigInt(ethers.hexlify(ethers.randomBytes(32))),
      conduitKey: opts.opensea ? OPENSEA.conduitKey : ethers.ZeroHash,
      counter: await seaport.getCounter(buyer.address),
    };
    const orderHash = await seaport.getOrderHash(components);
    const { counter: _, ...rest } = components;
    const parameters = { ...rest, totalOriginalConsiderationItems: BigInt(components.consideration.length) };
    let signature = "0x";
    if (opts.signed || opts.posted) {
      // The signed domain names Seaport's version: 1.5 here, 1.6 as on Sepolia and mainnet.
      const [version] = await seaport.information();
      const domain = { name: "Seaport", version, chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await seaport.getAddress() };
      signature = await buyer.signTypedData(domain, SEAPORT_TYPES, components);
      if (opts.posted) {
        await (await offers.connect(relay).post(parameters, signature)).wait();
        // Validated: it fills with no signature from now on.
        signature = "0x";
      }
    } else {
      await (await seaport.connect(buyer).validate([{ parameters, signature: "0x" }])).wait();
    }
    return { parameters, signature, orderHash, components };
  }
  let wethAddress: string;

  type Offer = Awaited<ReturnType<typeof makeOffer>>;

  /** What `finalizeOffer` takes: abi.encode(AdvancedOrder, bytes32[] criteriaProof). */
  function encodeOffer(offer: Offer, criteriaProof: string[] = []) {
    const orderType = seaport.interface.getFunction("fulfillAdvancedOrder")!.inputs[0]!;
    const order = { parameters: offer.parameters, numerator: 1n, denominator: 1n, signature: offer.signature, extraData: "0x" };
    return ethers.AbiCoder.defaultAbiCoder().encode([orderType, "bytes32[]"], [order, criteriaProof]);
  }

  /** Step 2 of accepting an offer, as the relay sends it. */
  async function finalizeOffer(requestId: bigint, offer: Offer) {
    const { ok } = await vault.requestInfo(requestId);
    const result = await fhevm.publicDecrypt([ok]);
    return vault.connect(relay).finalizeOffer(requestId, result.abiEncodedClearValues, result.decryptionProof, encodeOffer(offer));
  }

  /** The holder accepts `offer` for at least `least` wei, paid to `to`. */
  async function acceptOffer(boxId: bigint, key: bigint, offer: Offer, least: bigint, to: string) {
    const id = await placeRequest(boxId, ACTION.AcceptOffer, key, { to, price: least, ref: offer.orderHash });
    await (await finalizeOffer(id, offer)).wait();
    return { id, status: (await vault.requestInfo(id)).status };
  }

  /** Whether `delegate` may act for the vault on `tokenId`, in delegate.xyz's registry. */
  const delegated = async (delegate: string, tokenId: number) =>
    registry.checkDelegateForERC721(delegate, vaultAddress, await nft.getAddress(), tokenId, ethers.ZeroHash);

  beforeEach(async function () {
    [deployer, alice, bob, carol, relay, treasury, fresh] = (await ethers.getSigners()) as HardhatEthersSigner[] as [
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
    ];
    seaport = await installSeaport();
    registry = await installDelegateRegistry();
    weth = (await (await ethers.getContractFactory("TestWETH")).deploy()) as unknown as TestWETH;
    wethAddress = await weth.getAddress();
    offers = (await (await ethers.getContractFactory("VaultOffers")).deploy(await seaport.getAddress(), await weth.getAddress())) as unknown as VaultOffers;
    usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    cUsdc = (await (await ethers.getContractFactory("TestConfidentialUSDC")).deploy(await usdc.getAddress())) as unknown as TestConfidentialUSDC;
    nft = (await (await ethers.getContractFactory("TestERC721")).deploy()) as unknown as TestERC721;
    // As on Sepolia: no OpenSea there, so no zone, no conduit, no fees.
    listings = await deployOpenListings(seaport);
    vault = (await (await ethers.getContractFactory("SealedVault")).deploy(
      await listings.getAddress(),
      await cUsdc.getAddress(),
      await offers.getAddress(),
      await registry.getAddress(),
      treasury.address,
      deployer.address,
      FEE_BPS,
    )) as unknown as SealedVault;
    vaultAddress = await vault.getAddress();
  });

  describe("deposit", function () {
    it("seals any NFT in a box only its depositor holds", async function () {
      const boxId = await deposit(alice, 7, randomKey());
      expect(await nft.ownerOf(7)).to.eq(vaultAddress);
      expect(await holderOf(boxId)).to.eq(alice.address);
      const box = await vault.boxInfo(boxId);
      expect(box.state).to.eq(BOX.Sealed);
      expect(box.tokenId).to.eq(7n);
      expect(await vault.boxOf(await nft.getAddress(), 7)).to.eq(boxId + 1n);
    });

    it("refuses a collection the owner shut out, and lets it back in", async function () {
      await (await vault.banCollection(await nft.getAddress(), true)).wait();
      await (await nft.mint(alice.address, 1)).wait();
      await (await nft.connect(alice).approve(vaultAddress, 1)).wait();
      const i = await depositInput(alice, 1n);
      await expect(vault.connect(alice).deposit(await nft.getAddress(), 1, i.key, i.to, i.really, i.proof)).to.be.revertedWithCustomError(
        vault,
        "CollectionBanned",
      );
      await (await vault.banCollection(await nft.getAddress(), false)).wait();
      await (await vault.connect(alice).deposit(await nft.getAddress(), 1, i.key, i.to, i.really, i.proof)).wait();
      expect(await nft.ownerOf(1)).to.eq(vaultAddress);
    });

    it("refuses a collection whose transfer moves nothing: the NFT must be here", async function () {
      const fake = await (await ethers.getContractFactory("TestFakeNFT")).deploy();
      const i = await depositInput(alice, 1n);
      await expect(vault.connect(alice).deposit(await fake.getAddress(), 1, i.key, i.to, i.really, i.proof)).to.be.revertedWithCustomError(vault, "NotReceived");
    });

    it("refuses an NFT the caller does not hold", async function () {
      await (await nft.mint(alice.address, 2)).wait();
      const i = await depositInput(bob, 1n);
      await expect(vault.connect(bob).deposit(await nft.getAddress(), 2, i.key, i.to, i.really, i.proof)).to.be.reverted;
    });

    it("shows the NFT's own metadata for the box", async function () {
      const boxId = await deposit(alice, 3, randomKey());
      expect(await vault.tokenURI(boxId)).to.eq(await nft.tokenURI(3));
    });
  });

  describe("withdraw", function () {
    it("sends the NFT wherever the key's holder says, from any wallet", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      // The relay sends the request: alice's address appears nowhere.
      expect(await act(boxId, ACTION.Withdraw, key, { to: fresh.address })).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(1)).to.eq(fresh.address);
      expect((await vault.boxInfo(boxId)).state).to.eq(BOX.Withdrawn);
      expect(await vault.boxOf(await nft.getAddress(), 1)).to.eq(0n);
    });

    it("refuses a wrong key without reverting", async function () {
      const boxId = await deposit(alice, 1, randomKey());
      expect(await act(boxId, ACTION.Withdraw, randomKey(), { to: bob.address })).to.eq(REQUEST.Refused);
      expect(await nft.ownerOf(1)).to.eq(vaultAddress);
      expect((await vault.boxInfo(boxId)).state).to.eq(BOX.Sealed);
    });

    it("a relay cannot change a request's terms or replay it", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      // Alice's page binds the key to "withdraw to fresh"; the relay sends it to itself instead.
      const input = await boundKey(boxId, ACTION.Withdraw, key, { to: fresh.address }, relay);
      let id = await vault.requestCount();
      await (await vault.connect(relay).request(boxId, ACTION.Withdraw, relay.address, 0, 0, ethers.ZeroHash, input.handles[0]!, input.inputProof)).wait();
      expect(await finalize(id)).to.eq(REQUEST.Refused);
      expect(await nft.ownerOf(1)).to.eq(vaultAddress);
      // A wrong key spoils nothing: the same input, with the terms alice signed for, still works.
      id = await vault.requestCount();
      await (await vault.connect(relay).request(boxId, ACTION.Withdraw, fresh.address, 0, 0, ethers.ZeroHash, input.handles[0]!, input.inputProof)).wait();
      expect(await finalize(id)).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(1)).to.eq(fresh.address);
    });

    it("an input that worked once is refused the second time: the nonce moved on", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      const endTime = await inAWeek();
      const input = await boundKey(boxId, ACTION.List, key, { price: ETH("1"), endTime }, relay);
      const send = () => vault.connect(relay).request(boxId, ACTION.List, ethers.ZeroAddress, ETH("1"), endTime, ethers.ZeroHash, input.handles[0]!, input.inputProof);
      let id = await vault.requestCount();
      await (await send()).wait();
      expect(await finalize(id)).to.eq(REQUEST.Done);
      expect(await act(boxId, ACTION.Unlist, key)).to.eq(REQUEST.Done);
      // The relay keeps alice's old listing input and sends it again: refused.
      id = await vault.requestCount();
      await (await send()).wait();
      expect(await finalize(id)).to.eq(REQUEST.Refused);
      expect((await vault.boxInfo(boxId)).state).to.eq(BOX.Sealed);
    });

    it("cannot withdraw a box twice", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      await act(boxId, ACTION.Withdraw, key, { to: alice.address });
      const input = await keyInput(relay, key);
      await expect(
        vault.connect(relay).request(boxId, ACTION.Withdraw, alice.address, 0, 0, ethers.ZeroHash, input.handles[0]!, input.inputProof),
      ).to.be.revertedWithCustomError(vault, "WrongState");
    });

    it("holds the box still while a request waits, then lets it move", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      const id = await placeRequest(boxId, ACTION.Withdraw, randomKey(), { to: carol.address });
      expect((await vault.boxInfo(boxId)).pending).to.eq(1n);
      await expect(vault.connect(alice).confidentialTransfer(bob.address, boxId)).to.be.revertedWithCustomError(vault, "BoxBusy");
      expect(await finalize(id)).to.eq(REQUEST.Refused);
      expect((await vault.boxInfo(boxId)).pending).to.eq(0n);
      await (await vault.connect(alice).confidentialTransfer(bob.address, boxId)).wait();
      expect(await holderOf(boxId)).to.eq(bob.address);
    });
  });

  describe("keys", function () {
    it("a box that moves loses its key, and the new holder sets theirs", async function () {
      const aliceKey = randomKey();
      const boxId = await deposit(alice, 1, aliceKey);
      await (await vault.connect(alice).confidentialTransfer(bob.address, boxId)).wait();
      expect(await holderOf(boxId)).to.eq(bob.address);
      // Alice's key no longer opens it.
      expect(await act(boxId, ACTION.Withdraw, aliceKey, { to: alice.address })).to.eq(REQUEST.Refused);

      const bobKey = randomKey();
      const input = await keyInput(bob, bobKey);
      await (await vault.connect(bob).setKey(boxId, input.handles[0]!, input.inputProof)).wait();
      expect(await act(boxId, ACTION.Withdraw, bobKey, { to: fresh.address })).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(1)).to.eq(fresh.address);
    });

    it("a transfer that moves nothing keeps the key", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      // Carol does not hold the box: her transfer is a "maybe" that moved nothing.
      await (await vault.connect(carol).confidentialTransfer(bob.address, boxId)).wait();
      expect(await holderOf(boxId)).to.eq(alice.address);
      expect(await act(boxId, ACTION.Withdraw, key, { to: alice.address })).to.eq(REQUEST.Done);
    });

    it("setKey from someone who does not hold the box changes nothing", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      const carolKey = randomKey();
      const input = await keyInput(carol, carolKey);
      await (await vault.connect(carol).setKey(boxId, input.handles[0]!, input.inputProof)).wait();
      expect(await act(boxId, ACTION.Withdraw, carolKey, { to: carol.address })).to.eq(REQUEST.Refused);
      expect(await act(boxId, ACTION.Withdraw, key, { to: alice.address })).to.eq(REQUEST.Done);
    });
  });

  describe("Seaport", function () {
    it("lists with the vault as the seller, and the key's holder collects the ETH", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const price = ETH("1");
      const listingId = await list(boxId, key, price);

      const listing = await vault.listingInfo(listingId);
      const status = await seaport.getOrderStatus(listing.orderHash);
      expect(status.isValidated).to.eq(true);
      expect((await listings.orderOf(listing.orderHash)).offerer).to.eq(vaultAddress);
      // A listed box stays put.
      await expect(vault.connect(alice).confidentialTransfer(bob.address, boxId)).to.be.revertedWithCustomError(vault, "WrongState");

      await (await fill(listingId, carol)).wait();
      expect(await nft.ownerOf(5)).to.eq(carol.address);
      await (await vault.sync(boxId)).wait();
      const box = await vault.boxInfo(boxId);
      expect(box.state).to.eq(BOX.Sold);
      expect(box.proceeds).to.eq(price - feeOf(price));

      const before = await ethers.provider.getBalance(fresh.address);
      expect(await act(boxId, ACTION.Claim, key, { to: fresh.address })).to.eq(REQUEST.Done);
      expect((await ethers.provider.getBalance(fresh.address)) - before).to.eq(price - feeOf(price));
      expect((await vault.boxInfo(boxId)).state).to.eq(BOX.Claimed);

      expect(await vault.feesOwed()).to.eq(feeOf(price));
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await (await vault.connect(relay).sendFees()).wait();
      expect((await ethers.provider.getBalance(treasury.address)) - treasuryBefore).to.eq(feeOf(price));
    });

    it("a wrong key cannot list, unlist or claim", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      expect(await act(boxId, ACTION.List, randomKey(), { price: ETH("0.01"), endTime: await inAWeek() })).to.eq(REQUEST.Refused);
      const listingId = await list(boxId, key, ETH("1"));
      expect(await act(boxId, ACTION.Unlist, randomKey())).to.eq(REQUEST.Refused);
      await (await fill(listingId, carol)).wait();
      expect(await act(boxId, ACTION.Claim, randomKey(), { to: carol.address })).to.eq(REQUEST.Refused);
      expect((await vault.boxInfo(boxId)).proceeds).to.be.gt(0n);
    });

    it("a payout to an address that refuses ETH settles stale and keeps the ETH for the box", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const listingId = await list(boxId, key, ETH("1"));
      await (await fill(listingId, carol)).wait();
      // The test NFT contract has no way to take ETH.
      expect(await act(boxId, ACTION.Claim, key, { to: await nft.getAddress() })).to.eq(REQUEST.Stale);
      const box = await vault.boxInfo(boxId);
      expect(box.state).to.eq(BOX.Sold);
      expect(box.proceeds).to.eq(ETH("1") - feeOf(ETH("1")));
      expect(await act(boxId, ACTION.Claim, key, { to: fresh.address })).to.eq(REQUEST.Done);
    });

    it("unlisting cancels the order on Seaport", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const listingId = await list(boxId, key, ETH("1"));
      expect(await act(boxId, ACTION.Unlist, key)).to.eq(REQUEST.Done);
      expect((await seaport.getOrderStatus((await vault.listingInfo(listingId)).orderHash)).isCancelled).to.eq(true);
      await expect(fill(listingId, carol)).to.be.reverted;
      expect((await vault.boxInfo(boxId)).state).to.eq(BOX.Sealed);
      expect(await nft.getApproved(5)).to.eq(ethers.ZeroAddress);
    });

    it("withdrawing a listed box takes the listing down first", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const listingId = await list(boxId, key, ETH("1"));
      expect(await act(boxId, ACTION.Withdraw, key, { to: fresh.address })).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(5)).to.eq(fresh.address);
      expect((await seaport.getOrderStatus((await vault.listingInfo(listingId)).orderHash)).isCancelled).to.eq(true);
    });

    it("a withdrawal beaten by a Seaport buyer settles stale, and the ETH waits", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const listingId = await list(boxId, key, ETH("1"));
      const requestId = await placeRequest(boxId, ACTION.Withdraw, key, { to: fresh.address });
      await (await fill(listingId, carol)).wait();
      expect(await finalize(requestId)).to.eq(REQUEST.Stale);
      expect((await vault.boxInfo(boxId)).state).to.eq(BOX.Sold);
      expect(await act(boxId, ACTION.Claim, key, { to: fresh.address })).to.eq(REQUEST.Done);
    });

    it("a listing that runs out leaves the box sealed again", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const endTime = (await time.latest()) + 3_600;
      const listingId = await list(boxId, key, ETH("1"), endTime);
      await time.increaseTo(endTime + 1);
      await expect(fill(listingId, carol)).to.be.reverted;
      await (await vault.sync(boxId)).wait();
      expect((await vault.boxInfo(boxId)).state).to.eq(BOX.Sealed);
      expect(await nft.getApproved(5)).to.eq(ethers.ZeroAddress);
      // And it moves again.
      await (await vault.connect(alice).confidentialTransfer(bob.address, boxId)).wait();
      expect(await holderOf(boxId)).to.eq(bob.address);
    });

    it("refuses bad listings in the clear", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const input = await keyInput(relay, key);
      await expect(
        vault.connect(relay).request(boxId, ACTION.List, ethers.ZeroAddress, 0, await inAWeek(), ethers.ZeroHash, input.handles[0]!, input.inputProof),
      ).to.be.revertedWithCustomError(vault, "BadPrice");
      await expect(
        vault.connect(relay).request(boxId, ACTION.List, ethers.ZeroAddress, ETH("1"), await time.latest(), ethers.ZeroHash, input.handles[0]!, input.inputProof),
      ).to.be.revertedWithCustomError(vault, "BadEndTime");
      await expect(
        vault.connect(relay).request(boxId, ACTION.Claim, fresh.address, 0, 0, ethers.ZeroHash, input.handles[0]!, input.inputProof),
      ).to.be.revertedWithCustomError(vault, "WrongState");
    });

    it("takes ETH from Seaport only", async function () {
      await expect(alice.sendTransaction({ to: vaultAddress, value: 1n })).to.be.revertedWithCustomError(vault, "OnlySeaport");
    });

    describe("the way OpenSea shows it (mainnet)", function () {
      const CREATOR = "0x00000000000000000000000000000000000c4ea7";
      /** OpenSea's 1% and a 5% creator fee, as its listings of an enforcing collection pay. */
      const osFee = (price: bigint) => (price * 100n) / 10_000n;
      const creatorFee = (price: bigint) => (price * 500n) / 10_000n;
      const netOf = (price: bigint) => price - osFee(price) - creatorFee(price);

      beforeEach(async function () {
        ({ seaport, listings } = await installOpenSea());
        offers = (await (await ethers.getContractFactory("VaultOffers")).deploy(await seaport.getAddress(), wethAddress)) as unknown as VaultOffers;
        vault = (await (await ethers.getContractFactory("SealedVault")).deploy(
          await listings.getAddress(),
          await cUsdc.getAddress(),
          await offers.getAddress(),
          await registry.getAddress(),
          treasury.address,
          deployer.address,
          FEE_BPS,
        )) as unknown as SealedVault;
        vaultAddress = await vault.getAddress();
        await (
          await listings.setFees(await nft.getAddress(), [
            { recipient: OPENSEA.feeRecipient, bps: 100 },
            { recipient: CREATOR, bps: 500 },
          ])
        ).wait();
      });

      it("lists on Seaport 1.6 through OpenSea's conduit and signed zone, the fees paid to their recipients", async function () {
        const key = randomKey();
        const boxId = await deposit(alice, 5, key);
        const price = ETH("1");
        const listingId = await list(boxId, key, price);
        const listing = await vault.listingInfo(listingId);
        expect(listing.net).to.eq(netOf(price));

        const order = await listings.orderOf(listing.orderHash);
        expect(order.offerer).to.eq(vaultAddress);
        expect(order.zone).to.eq(OPENSEA.zone);
        expect(order.orderType).to.eq(2n); // FULL_RESTRICTED, as OpenSea's signed zone wants
        expect(order.conduitKey).to.eq(OPENSEA.conduitKey);
        expect(order.consideration.map((c) => [c.recipient, c.startAmount])).to.deep.eq([
          [vaultAddress, netOf(price)],
          [OPENSEA.feeRecipient, osFee(price)],
          [CREATOR, creatorFee(price)],
        ]);
        expect((await seaport.getOrderStatus(listing.orderHash)).isValidated).to.eq(true);
        // The conduit, not Seaport, moves the NFT, and only this one.
        expect(await nft.getApproved(5)).to.eq(OPENSEA.conduit);

        const openseaBefore = await ethers.provider.getBalance(OPENSEA.feeRecipient);
        await (await fill(listingId, carol)).wait();
        expect(await nft.ownerOf(5)).to.eq(carol.address);
        expect((await ethers.provider.getBalance(OPENSEA.feeRecipient)) - openseaBefore).to.eq(osFee(price));
        expect(await ethers.provider.getBalance(CREATOR)).to.eq(creatorFee(price));

        await (await vault.sync(boxId)).wait();
        const box = await vault.boxInfo(boxId);
        expect(box.state).to.eq(BOX.Sold);
        // The vault's own fee is on what it netted.
        expect(box.proceeds).to.eq(netOf(price) - feeOf(netOf(price)));
        const before = await ethers.provider.getBalance(fresh.address);
        expect(await act(boxId, ACTION.Claim, key, { to: fresh.address })).to.eq(REQUEST.Done);
        expect((await ethers.provider.getBalance(fresh.address)) - before).to.eq(netOf(price) - feeOf(netOf(price)));
      });

      it("a listing keeps the fees it was made with, and still comes down after they change", async function () {
        const key = randomKey();
        const boxId = await deposit(alice, 5, key);
        const listingId = await list(boxId, key, ETH("1"));
        await (await listings.setFees(await nft.getAddress(), [{ recipient: OPENSEA.feeRecipient, bps: 250 }])).wait();
        expect(await act(boxId, ACTION.Unlist, key)).to.eq(REQUEST.Done);
        expect((await seaport.getOrderStatus((await vault.listingInfo(listingId)).orderHash)).isCancelled).to.eq(true);
        expect(await nft.getApproved(5)).to.eq(ethers.ZeroAddress);
        // The next listing pays the new fee.
        const next = await list(boxId, key, ETH("1"));
        expect((await vault.listingInfo(next)).net).to.eq(ETH("0.975"));
      });

      it("a collection without fees of its own takes the default ones, and its own replace them", async function () {
        // Another collection, nothing set for it: the default fees (OpenSea's, under collection 0) apply.
        const other = (await (await ethers.getContractFactory("TestERC721")).deploy()) as unknown as TestERC721;
        const otherAddress = await other.getAddress();
        expect((await listings.feesOf(otherAddress)).length).to.eq(0);
        await (await listings.setFees(ethers.ZeroAddress, [{ recipient: OPENSEA.feeRecipient, bps: 100 }])).wait();
        expect((await listings.feesOf(otherAddress)).map((f) => [f.recipient, f.bps])).to.deep.eq([[OPENSEA.feeRecipient, 100n]]);
        // The collection with fees of its own keeps them.
        expect((await listings.feesOf(await nft.getAddress())).length).to.eq(2);
        const key = randomKey();
        await (await other.mint(alice.address, 3)).wait();
        await (await other.connect(alice).approve(vaultAddress, 3)).wait();
        const i = await depositInput(alice, key);
        await (await vault.connect(alice).deposit(otherAddress, 3, i.key, i.to, i.really, i.proof)).wait();
        const boxId = (await vault.boxOf(otherAddress, 3)) - 1n;
        const listingId = await list(boxId, key, ETH("1"));
        expect((await vault.listingInfo(listingId)).net).to.eq(ETH("0.99"));
        expect((await listings.orderOf((await vault.listingInfo(listingId)).orderHash)).consideration.length).to.eq(2);
        // Its own fees replace the default, they do not add to it.
        await (await listings.setFees(otherAddress, [{ recipient: CREATOR, bps: 500 }])).wait();
        expect(await act(boxId, ACTION.Unlist, key)).to.eq(REQUEST.Done);
        const next = await list(boxId, key, ETH("1"));
        expect((await vault.listingInfo(next)).net).to.eq(ETH("0.95"));
      });

      it("withdrawing a listed box cancels its order on Seaport 1.6", async function () {
        const key = randomKey();
        const boxId = await deposit(alice, 5, key);
        const listingId = await list(boxId, key, ETH("1"));
        expect(await act(boxId, ACTION.Withdraw, key, { to: fresh.address })).to.eq(REQUEST.Done);
        expect(await nft.ownerOf(5)).to.eq(fresh.address);
        expect((await seaport.getOrderStatus((await vault.listingInfo(listingId)).orderHash)).isCancelled).to.eq(true);
      });

      it("only the owner sets a collection's fees, never above 15% in all", async function () {
        const collection = await nft.getAddress();
        await expect(listings.connect(alice).setFees(collection, [])).to.be.revertedWithCustomError(listings, "OwnableUnauthorizedAccount");
        await expect(
          listings.setFees(collection, [
            { recipient: OPENSEA.feeRecipient, bps: 1_000 },
            { recipient: CREATOR, bps: 501 },
          ]),
        ).to.be.revertedWithCustomError(listings, "TooManyFees");
        await expect(listings.setFees(collection, [{ recipient: ethers.ZeroAddress, bps: 1 }])).to.be.revertedWithCustomError(listings, "ZeroAddress");
        expect((await listings.feesOf(collection)).length).to.eq(2);
      });

      it("accepts a buyer's OpenSea offer: through OpenSea's conduit and signed zone, its fee paid in WETH", async function () {
        const key = randomKey();
        const boxId = await deposit(alice, 5, key);
        // 1 WETH for the NFT, OpenSea's 1% out of it, as its offers are made.
        const offer = await makeOffer(carol, ETH("1"), { tokenId: 5, opensea: true, signed: true, fees: [{ to: OPENSEA.feeRecipient, amount: ETH("0.01") }] });
        expect(offer.parameters.orderType).to.eq(2); // FULL_RESTRICTED
        const net = ETH("0.99");
        const before = await ethers.provider.getBalance(fresh.address);
        const { status } = await acceptOffer(boxId, key, offer, net, fresh.address);
        expect(status).to.eq(REQUEST.Done);
        expect(await nft.ownerOf(5)).to.eq(carol.address);
        expect(await weth.balanceOf(OPENSEA.feeRecipient)).to.eq(ETH("0.01"));
        expect((await ethers.provider.getBalance(fresh.address)) - before).to.eq(net - feeOf(net));
        expect(await weth.balanceOf(await offers.getAddress())).to.eq(0n);
      });

      it("accepts a collection offer made on OpenSea, one share of it", async function () {
        const key = randomKey();
        const boxId = await deposit(alice, 8, key);
        const offer = await makeOffer(carol, ETH("2"), { units: 2n, opensea: true, signed: true, fees: [{ to: OPENSEA.feeRecipient, amount: ETH("0.02") }] });
        expect(offer.parameters.orderType).to.eq(3); // PARTIAL_RESTRICTED
        const { status } = await acceptOffer(boxId, key, offer, ETH("0.99"), fresh.address);
        expect(status).to.eq(REQUEST.Done);
        expect(await nft.ownerOf(8)).to.eq(carol.address);
        expect((await seaport.getOrderStatus(offer.orderHash)).totalFilled).to.eq(1n);
      });
    });

    describe("as on Sepolia (Seaport 1.6 and OpenSea's conduit, no zone: OpenSea is not there)", function () {
      beforeEach(async function () {
        ({ seaport, listings } = await installOpenSea(false));
        offers = (await (await ethers.getContractFactory("VaultOffers")).deploy(await seaport.getAddress(), wethAddress)) as unknown as VaultOffers;
        vault = (await (await ethers.getContractFactory("SealedVault")).deploy(
          await listings.getAddress(),
          await cUsdc.getAddress(),
          await offers.getAddress(),
          await registry.getAddress(),
          treasury.address,
          deployer.address,
          FEE_BPS,
        )) as unknown as SealedVault;
        vaultAddress = await vault.getAddress();
      });

      it("lists an open order anyone fills, the NFT moved by OpenSea's conduit, no fee but the vault's", async function () {
        const key = randomKey();
        const boxId = await deposit(alice, 5, key);
        const price = ETH("1");
        const listingId = await list(boxId, key, price);
        const listing = await vault.listingInfo(listingId);
        expect(listing.net).to.eq(price);
        const order = await listings.orderOf(listing.orderHash);
        expect(order.zone).to.eq(ethers.ZeroAddress);
        expect(order.orderType).to.eq(0n); // FULL_OPEN
        expect(order.conduitKey).to.eq(OPENSEA.conduitKey);
        expect(order.consideration.length).to.eq(1);
        expect(await nft.getApproved(5)).to.eq(OPENSEA.conduit);
        await (await fill(listingId, carol)).wait();
        expect(await nft.ownerOf(5)).to.eq(carol.address);
        await (await vault.sync(boxId)).wait();
        expect((await vault.boxInfo(boxId)).proceeds).to.eq(price - feeOf(price));
      });

      it("accepts a buyer's offer signed for Seaport 1.6 and posted to the board", async function () {
        const key = randomKey();
        const boxId = await deposit(alice, 5, key);
        const offer = await makeOffer(carol, ETH("1"), { tokenId: 5, posted: true });
        const { status } = await acceptOffer(boxId, key, offer, ETH("1"), fresh.address);
        expect(status).to.eq(REQUEST.Done);
        expect(await nft.ownerOf(5)).to.eq(carol.address);
      });
    });
  });

  describe("private sale", function () {
    const PRICE = usd("250");

    beforeEach(async function () {
      await giveCusdc(bob, usd("1000"));
    });

    it("swaps the box for the secret price, and the key changes hands", async function () {
      const aliceKey = randomKey();
      const boxId = await deposit(alice, 9, aliceKey);
      const saleId = await offerSale(alice, boxId, bob, PRICE);
      const sale = await vault.saleInfo(saleId);
      // Only the two sides can read the price.
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, sale.price, vaultAddress, bob)).to.eq(PRICE);

      const bobKey = randomKey();
      await acceptSale(saleId, bob, bobKey);
      expect((await vault.saleInfo(saleId)).status).to.eq(SALE.Settled);
      expect(await holderOf(boxId)).to.eq(bob.address);
      expect(await fhevm.userDecryptEbool((await vault.saleInfo(saleId)).moved, vaultAddress, alice)).to.eq(true);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(PRICE - feeOf(PRICE));
      expect(await confidentialUsdcOf(cUsdc, treasury)).to.eq(feeOf(PRICE));
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(usd("1000") - PRICE);

      expect(await act(boxId, ACTION.Withdraw, aliceKey, { to: alice.address })).to.eq(REQUEST.Refused);
      expect(await act(boxId, ACTION.Withdraw, bobKey, { to: fresh.address })).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(9)).to.eq(fresh.address);
    });

    it("an offer from someone who does not hold the box moves nothing and refunds the buyer", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 9, key);
      const saleId = await offerSale(carol, boxId, bob, PRICE);
      await acceptSale(saleId, bob, randomKey());
      expect(await holderOf(boxId)).to.eq(alice.address);
      expect(await fhevm.userDecryptEbool((await vault.saleInfo(saleId)).moved, vaultAddress, bob)).to.eq(false);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(usd("1000"));
      expect(await confidentialUsdcOf(cUsdc, carol)).to.eq(0n);
      // Alice's key still opens her box.
      expect(await act(boxId, ACTION.Withdraw, key, { to: alice.address })).to.eq(REQUEST.Done);
    });

    it("a buyer who cannot pay gets nothing and pays nothing", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 9, key);
      const saleId = await offerSale(alice, boxId, bob, usd("5000"));
      await acceptSale(saleId, bob, randomKey());
      expect(await holderOf(boxId)).to.eq(alice.address);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(usd("1000"));
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(0n);
    });

    it("only the named buyer accepts, only the seller cancels", async function () {
      const boxId = await deposit(alice, 9, randomKey());
      const saleId = await offerSale(alice, boxId, bob, PRICE);
      const input = await keyInput(carol, 1n);
      await expect(vault.connect(carol).acceptSale(saleId, input.handles[0]!, input.inputProof)).to.be.revertedWithCustomError(vault, "NotBuyer");
      await expect(vault.connect(bob).cancelSale(saleId)).to.be.revertedWithCustomError(vault, "NotSeller");
      await (await vault.connect(alice).cancelSale(saleId)).wait();
      expect((await vault.saleInfo(saleId)).status).to.eq(SALE.Cancelled);
      const bobInput = await keyInput(bob, 1n);
      await expect(vault.connect(bob).acceptSale(saleId, bobInput.handles[0]!, bobInput.inputProof)).to.be.revertedWithCustomError(
        vault,
        "SaleNotOpen",
      );
    });

    it("a listed box cannot be sold privately", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 9, key);
      const saleId = await offerSale(alice, boxId, bob, PRICE);
      await list(boxId, key, ETH("1"));
      const input = await keyInput(bob, 1n);
      await expect(vault.connect(bob).acceptSale(saleId, input.handles[0]!, input.inputProof)).to.be.revertedWithCustomError(vault, "WrongState");
    });
  });

  describe("requests that do not lock the box", function () {
    /** Requests with wrong keys, as a stranger would send to keep the box busy. */
    async function grief(boxId: bigint, times: number, action: number = ACTION.Withdraw) {
      const ids: bigint[] = [];
      for (let i = 0; i < times; i++) ids.push(await placeRequest(boxId, action, randomKey(), { to: carol.address, sender: carol }));
      return ids;
    }

    it("a stranger's waiting requests do not stop the holder taking the NFT out", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      const junk = await grief(boxId, 3);
      expect((await vault.boxInfo(boxId)).pending).to.eq(3n);
      // Alice's request goes in next to them and settles first.
      expect(await act(boxId, ACTION.Withdraw, key, { to: fresh.address })).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(1)).to.eq(fresh.address);
      // The stranger's requests settle refused, whenever someone finalizes them.
      for (const id of junk) expect(await finalize(id)).to.eq(REQUEST.Refused);
      expect((await vault.boxInfo(boxId)).pending).to.eq(0n);
    });

    it("a stranger's requests do not stop listing, unlisting or collecting either", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      await grief(boxId, 1);
      const listingId = await list(boxId, key, ETH("1"));
      await grief(boxId, 1);
      expect(await act(boxId, ACTION.Unlist, key)).to.eq(REQUEST.Done);
      await list(boxId, key, ETH("1"));
      await (await fill((await vault.boxInfo(boxId)).listing - 1n, carol)).wait();
      expect(listingId).to.not.eq((await vault.boxInfo(boxId)).listing - 1n);
      await grief(boxId, 2, ACTION.Claim);
      expect(await act(boxId, ACTION.Claim, key, { to: fresh.address })).to.eq(REQUEST.Done);
      expect((await vault.boxInfo(boxId)).state).to.eq(BOX.Claimed);
    });

    it("a wrong key does not spoil an input the holder already prepared", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      // Alice's page binds her key to the current nonce...
      const input = await boundKey(boxId, ACTION.Withdraw, key, { to: fresh.address }, relay);
      // ...a stranger's request lands and settles first...
      const [junk] = await grief(boxId, 1);
      expect(await finalize(junk!)).to.eq(REQUEST.Refused);
      // ...and alice's input still works.
      const id = await vault.requestCount();
      await (await vault.connect(relay).request(boxId, ACTION.Withdraw, fresh.address, 0, 0, ethers.ZeroHash, input.handles[0]!, input.inputProof)).wait();
      expect(await finalize(id)).to.eq(REQUEST.Done);
    });

    it("the nonce moves on only when a key matched", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      for (const id of await grief(boxId, 2)) await finalize(id);
      expect((await vault.boxInfo(boxId)).nonce).to.eq(0n);
      await list(boxId, key, ETH("1"));
      expect((await vault.boxInfo(boxId)).nonce).to.eq(1n);
      // A matched key that found the box changed (stale) moves it on too.
      const id = await placeRequest(boxId, ACTION.Unlist, key);
      await (await fill((await vault.boxInfo(boxId)).listing - 1n, carol)).wait();
      expect(await finalize(id)).to.eq(REQUEST.Stale);
      expect((await vault.boxInfo(boxId)).nonce).to.eq(2n);
    });

    it("two of the holder's own requests at once: the first runs, the second finds the box changed", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      const first = await placeRequest(boxId, ACTION.Withdraw, key, { to: fresh.address });
      const second = await placeRequest(boxId, ACTION.Withdraw, key, { to: bob.address });
      expect(await finalize(first)).to.eq(REQUEST.Done);
      expect(await finalize(second)).to.eq(REQUEST.Stale);
      expect(await nft.ownerOf(1)).to.eq(fresh.address);
    });

    it("finalized in any order, requests leave the box consistent", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const junk = await grief(boxId, 2);
      const listing = await placeRequest(boxId, ACTION.List, key, { price: ETH("1"), endTime: await inAWeek() });
      // The second request is placed while the box is still sealed: Withdraw is allowed then.
      const withdraw = await placeRequest(boxId, ACTION.Withdraw, key, { to: fresh.address });
      expect(await finalize(withdraw)).to.eq(REQUEST.Done);
      expect(await finalize(listing)).to.eq(REQUEST.Stale);
      for (const id of junk) expect(await finalize(id)).to.eq(REQUEST.Refused);
      const box = await vault.boxInfo(boxId);
      expect(box.state).to.eq(BOX.Withdrawn);
      expect(box.pending).to.eq(0n);
      expect(await nft.getApproved(5)).to.eq(ethers.ZeroAddress);
    });

    it("a private sale waits for the box's requests, then goes through", async function () {
      await giveCusdc(bob, usd("1000"));
      const boxId = await deposit(alice, 9, randomKey());
      const saleId = await offerSale(alice, boxId, bob, usd("10"));
      const [junk] = await grief(boxId, 1);
      const input = await keyInput(bob, randomKey());
      await expect(vault.connect(bob).acceptSale(saleId, input.handles[0]!, input.inputProof)).to.be.revertedWithCustomError(vault, "BoxBusy");
      // Anyone may finalize the stranger's request, the buyer included.
      expect(await finalize(junk!)).to.eq(REQUEST.Refused);
      await acceptSale(saleId, bob, randomKey());
      expect(await holderOf(boxId)).to.eq(bob.address);
    });
  });

  describe("expiry", function () {
    it("a request whose proof never comes can be expired by anyone, after a day", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      const id = await placeRequest(boxId, ACTION.Withdraw, randomKey(), { to: carol.address, sender: carol });
      await expect(vault.connect(bob).expire(id)).to.be.revertedWithCustomError(vault, "TooEarly");
      await time.increase(DAY + 1);
      await (await vault.connect(bob).expire(id)).wait();
      const box = await vault.boxInfo(boxId);
      expect((await vault.requestInfo(id)).status).to.eq(REQUEST.Expired);
      expect(box.pending).to.eq(0n);
      expect(box.nonce).to.eq(1n);
      // Settled once, for good.
      await expect(vault.expire(id)).to.be.revertedWithCustomError(vault, "RequestNotPending");
      const { ok } = await vault.requestInfo(id);
      const result = await fhevm.publicDecrypt([ok]);
      await expect(vault.finalize(id, result.abiEncodedClearValues, result.decryptionProof)).to.be.revertedWithCustomError(vault, "RequestNotPending");
      // The box moves and comes out again.
      await (await vault.connect(alice).confidentialTransfer(bob.address, boxId)).wait();
      expect(await holderOf(boxId)).to.eq(bob.address);
    });

    it("an expired request of the holder's runs nothing, and its input cannot be sent again", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      const input = await boundKey(boxId, ACTION.Withdraw, key, { to: fresh.address }, relay);
      const send = () => vault.connect(relay).request(boxId, ACTION.Withdraw, fresh.address, 0, 0, ethers.ZeroHash, input.handles[0]!, input.inputProof);
      let id = await vault.requestCount();
      await (await send()).wait();
      await time.increase(DAY + 1);
      await (await vault.expire(id)).wait();
      expect(await nft.ownerOf(1)).to.eq(vaultAddress);
      id = await vault.requestCount();
      await (await send()).wait();
      expect(await finalize(id)).to.eq(REQUEST.Refused);
      expect(await act(boxId, ACTION.Withdraw, key, { to: fresh.address })).to.eq(REQUEST.Done);
    });

    it("a request already finalized cannot be expired", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      const id = await placeRequest(boxId, ACTION.Withdraw, key, { to: fresh.address });
      await finalize(id);
      await time.increase(DAY + 1);
      await expect(vault.expire(id)).to.be.revertedWithCustomError(vault, "RequestNotPending");
    });
  });

  describe("deposit with decoys", function () {

    it("sends the new box to decoys that move nothing: the depositor keeps it and its key", async function () {
      const key = randomKey();
      const sends = decoys(3);
      const boxId = await deposit(alice, 1, key, sends);
      expect(await holderOf(boxId)).to.eq(alice.address);
      // One receipt per send, from alice, each a "maybe" only alice can read.
      const receipts = lastDeposit.logs
        .map((l) => vault.interface.parseLog(l))
        .filter((e) => e?.name === "ConfidentialTransfer" && e.args.from === alice.address);
      expect(receipts.map((e) => e!.args.to)).to.deep.eq(sends.map((s) => s.to));
      for (const e of receipts) expect(await fhevm.userDecryptEbool(e!.args.moved, vaultAddress, alice)).to.eq(false);
      expect(await act(boxId, ACTION.Withdraw, key, { to: fresh.address })).to.eq(REQUEST.Done);
    });

    it("can hand the box straight to someone else, among decoys: they set their key", async function () {
      const key = randomKey();
      const sends = [...decoys(2), { to: bob.address, really: true }, ...decoys(1)];
      const boxId = await deposit(alice, 1, key, sends);
      expect(await holderOf(boxId)).to.eq(bob.address);
      // The box moved, so it has a key nobody knows: alice's no longer opens it.
      expect(await act(boxId, ACTION.Withdraw, key, { to: alice.address })).to.eq(REQUEST.Refused);
      const bobKey = randomKey();
      const input = await keyInput(bob, bobKey);
      await (await vault.connect(bob).setKey(boxId, input.handles[0]!, input.inputProof)).wait();
      expect(await act(boxId, ACTION.Withdraw, bobKey, { to: fresh.address })).to.eq(REQUEST.Done);
    });

    it("a real send after a real send: the box ends with the last one", async function () {
      const boxId = await deposit(alice, 1, randomKey(), [{ to: bob.address, really: true }, { to: carol.address, really: true }]);
      // The second transfer is alice's, but alice no longer holds the box: it moves nothing.
      expect(await holderOf(boxId)).to.eq(bob.address);
    });

    it("refuses too many sends, or sends and flags that do not pair up", async function () {
      await (await nft.mint(alice.address, 1)).wait();
      await (await nft.connect(alice).approve(vaultAddress, 1)).wait();
      const six = await depositInput(alice, 1n, decoys(6));
      await expect(vault.connect(alice).deposit(await nft.getAddress(), 1, six.key, six.to, six.really, six.proof)).to.be.revertedWithCustomError(
        vault,
        "BadSends",
      );
      const two = await depositInput(alice, 1n, decoys(2));
      await expect(
        vault.connect(alice).deposit(await nft.getAddress(), 1, two.key, two.to, two.really.slice(1), two.proof),
      ).to.be.revertedWithCustomError(vault, "BadSends");
    });

    it("stays within the HCU budget with the most sends", async function () {
      await deposit(alice, 1, randomKey(), decoys(5));
      const used = fhevm.computeTransactionHCU(lastDeposit as Parameters<typeof fhevm.computeTransactionHCU>[0]);
      expect(used.globalHCU).to.be.lessThan(20_000_000);
      expect(used.maxHCUDepth).to.be.lessThan(5_000_000);
    });
  });

  describe("no box stays stuck", function () {
    it("whatever strangers send, once every request is settled each holder can still take their NFT out", async function () {
      // Three boxes, three holders; strangers pile wrong-key requests, transfers and offers on them.
      const keys = [randomKey(), randomKey(), randomKey()];
      const holders = [alice, bob, carol];
      const boxes: bigint[] = [];
      for (let i = 0; i < 3; i++) boxes.push(await deposit(holders[i]!, 20 + i, keys[i]!, decoys(i)));
      const open: bigint[] = [];
      let seed = 7;
      const rand = (n: number) => (seed = (seed * 48_271) % 2_147_483_647) % n;
      for (let round = 0; round < 12; round++) {
        const b = rand(3);
        const stranger = holders[(b + 1 + rand(2)) % 3]!;
        switch (rand(4)) {
          case 0:
          case 1:
            open.push(await placeRequest(boxes[b]!, ACTION.Withdraw, randomKey(), { to: stranger.address, sender: stranger }));
            break;
          case 2:
            // A transfer from someone who does not hold it: reverts while busy, moves nothing otherwise.
            if ((await vault.boxInfo(boxes[b]!)).pending === 0n) await (await vault.connect(stranger).confidentialTransfer(fresh.address, boxes[b]!)).wait();
            break;
          default:
            // Some proofs come back, in any order.
            if (open.length) expect(await finalize(open.splice(rand(open.length), 1)[0]!)).to.eq(REQUEST.Refused);
        }
      }
      // Whatever is left: some proofs come back, the rest expire.
      const late = open.splice(0, Math.ceil(open.length / 2));
      for (const id of late) await finalize(id);
      await time.increase(DAY + 1);
      for (const id of open) await (await vault.connect(fresh).expire(id)).wait();
      for (let i = 0; i < 3; i++) {
        expect((await vault.boxInfo(boxes[i]!)).pending).to.eq(0n);
        expect(await holderOf(boxes[i]!)).to.eq(holders[i]!.address);
        expect(await act(boxes[i]!, ACTION.Withdraw, keys[i]!, { to: fresh.address })).to.eq(REQUEST.Done);
        expect(await nft.ownerOf(20 + i)).to.eq(fresh.address);
      }
    });
  });

  describe("accepting Seaport offers", function () {
    it("fills a buyer's offer for the box's NFT and pays the key's holder straight away", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const market = ethers.Wallet.createRandom().address;
      const offer = await makeOffer(carol, ETH("1"), { tokenId: 5, fees: [{ to: market, amount: ETH("0.025") }] });
      const net = ETH("0.975");
      const before = await ethers.provider.getBalance(fresh.address);
      const { id, status } = await acceptOffer(boxId, key, offer, net, fresh.address);
      expect(status).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(5)).to.eq(carol.address);
      expect(await weth.balanceOf(market)).to.eq(ETH("0.025"));
      expect((await ethers.provider.getBalance(fresh.address)) - before).to.eq(net - feeOf(net));
      const box = await vault.boxInfo(boxId);
      expect(box.state).to.eq(BOX.Claimed);
      expect(box.proceeds).to.eq(0n);
      expect(await vault.feesOwed()).to.eq(feeOf(net));
      expect(await vault.boxOf(await nft.getAddress(), 5)).to.eq(0n);
      // Nothing stays behind in the helper.
      expect(await weth.balanceOf(await offers.getAddress())).to.eq(0n);
      expect(await ethers.provider.getBalance(await offers.getAddress())).to.eq(0n);
      const logs = (await ethers.provider.getTransactionReceipt((await vault.queryFilter(vault.filters.RequestSettled(id)))[0]!.transactionHash))!.logs;
      const accepted = logs.map((l) => vault.interface.parseLog(l)).find((l) => l?.name === "OfferAccepted")!;
      expect(accepted.args.buyer).to.eq(carol.address);
      expect(accepted.args.amount).to.eq(net);
    });

    it("takes one share of a signed collection offer, and the rest stays open", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 8, key);
      const market = ethers.Wallet.createRandom().address;
      // 2 WETH for any two tokens of the collection, 0.1 WETH of fees.
      const offer = await makeOffer(carol, ETH("2"), { units: 2n, signed: true, fees: [{ to: market, amount: ETH("0.1") }] });
      const { status } = await acceptOffer(boxId, key, offer, ETH("0.95"), fresh.address);
      expect(status).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(8)).to.eq(carol.address);
      expect(await weth.balanceOf(market)).to.eq(ETH("0.05"));
      const orderStatus = await seaport.getOrderStatus(offer.orderHash);
      expect(orderStatus.totalFilled).to.eq(1n);
      expect(orderStatus.totalSize).to.eq(2n);
    });

    it("a listed box: accepting an offer takes the listing down first", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const listingId = await list(boxId, key, ETH("3"));
      const offer = await makeOffer(carol, ETH("2"), { tokenId: 5 });
      expect((await acceptOffer(boxId, key, offer, ETH("2"), fresh.address)).status).to.eq(REQUEST.Done);
      expect((await seaport.getOrderStatus((await vault.listingInfo(listingId)).orderHash)).isCancelled).to.eq(true);
      expect(await nft.ownerOf(5)).to.eq(carol.address);
    });

    it("an order asking for another box's NFT cannot take it, even a listed one Seaport may move", async function () {
      const aliceKey = randomKey();
      const bobKey = randomKey();
      const cheap = await deposit(alice, 1, aliceKey);
      const dear = await deposit(bob, 2, bobKey);
      await list(dear, bobKey, ETH("50"));
      // Alice makes an offer (as a buyer) for bob's NFT, and accepts it with her own box's key.
      const offer = await makeOffer(alice, 1n, { tokenId: 2 });
      expect((await acceptOffer(cheap, aliceKey, offer, 1n, alice.address)).status).to.eq(REQUEST.Stale);
      expect(await nft.ownerOf(2)).to.eq(vaultAddress);
      expect(await nft.ownerOf(1)).to.eq(vaultAddress);
      // Straight to the helper: it holds neither NFT, so Seaport takes nothing.
      await expect(offers.connect(alice).fill(encodeOffer(offer), await nft.getAddress(), 2)).to.be.reverted;
      expect(await nft.ownerOf(2)).to.eq(vaultAddress);
      // A collection offer is resolved to the box's own token, never another.
      const any = await makeOffer(alice, 1n);
      expect((await acceptOffer(cheap, aliceKey, any, 1n, alice.address)).status).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(1)).to.eq(alice.address);
      expect(await nft.ownerOf(2)).to.eq(vaultAddress);
    });

    it("an order for another collection, or paying in something else, settles stale", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const other = (await (await ethers.getContractFactory("TestERC721")).deploy()) as unknown as TestERC721;
      const offer = await makeOffer(carol, ETH("1"), { tokenId: 5, collection: await other.getAddress() });
      expect((await acceptOffer(boxId, key, offer, 1n, fresh.address)).status).to.eq(REQUEST.Stale);
      expect(await nft.ownerOf(5)).to.eq(vaultAddress);
      expect((await vault.boxInfo(boxId)).state).to.eq(BOX.Sealed);
    });

    it("an offer worth less than asked, cancelled or ended settles stale and the box stays", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const low = await makeOffer(carol, ETH("1"), { tokenId: 5, fees: [{ to: bob.address, amount: ETH("0.1") }] });
      expect((await acceptOffer(boxId, key, low, ETH("0.95"), fresh.address)).status).to.eq(REQUEST.Stale);

      const cancelled = await makeOffer(carol, ETH("1"), { tokenId: 5 });
      const id = await placeRequest(boxId, ACTION.AcceptOffer, key, { to: fresh.address, price: ETH("1"), ref: cancelled.orderHash });
      await (await seaport.connect(carol).cancel([cancelled.components])).wait();
      await (await finalizeOffer(id, cancelled)).wait();
      expect((await vault.requestInfo(id)).status).to.eq(REQUEST.Stale);

      const endTime = (await time.latest()) + 3_600;
      const ending = await makeOffer(carol, ETH("1"), { tokenId: 5, endTime });
      const late = await placeRequest(boxId, ACTION.AcceptOffer, key, { to: fresh.address, price: ETH("1"), ref: ending.orderHash });
      await time.increaseTo(endTime + 1);
      await (await finalizeOffer(late, ending)).wait();
      expect((await vault.requestInfo(late)).status).to.eq(REQUEST.Stale);

      expect(await nft.ownerOf(5)).to.eq(vaultAddress);
      expect((await vault.boxInfo(boxId)).pending).to.eq(0n);
      expect(await act(boxId, ACTION.Withdraw, key, { to: fresh.address })).to.eq(REQUEST.Done);
    });

    it("the order must be the one the key was bound to, and only finalizeOffer runs it", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const offer = await makeOffer(carol, ETH("1"), { tokenId: 5 });
      const other = await makeOffer(bob, ETH("0.5"), { tokenId: 5 });
      const id = await placeRequest(boxId, ACTION.AcceptOffer, key, { to: fresh.address, price: ETH("0.5"), ref: offer.orderHash });
      await expect(finalizeOffer(id, other)).to.be.revertedWithCustomError(vault, "WrongOrder");
      await expect(finalize(id)).to.be.revertedWithCustomError(vault, "NeedsOrder");
      expect((await vault.requestInfo(id)).status).to.eq(REQUEST.Pending);
      await (await finalizeOffer(id, offer)).wait();
      expect((await vault.requestInfo(id)).status).to.eq(REQUEST.Done);
      // finalizeOffer runs nothing else.
      const key2 = randomKey();
      const box2 = await deposit(alice, 6, key2);
      const w = await placeRequest(box2, ACTION.Withdraw, key2, { to: fresh.address });
      await expect(finalizeOffer(w, offer)).to.be.revertedWithCustomError(vault, "NotAnOffer");
    });

    it("a wrong key settles refused with a plain finalize, no order needed", async function () {
      const boxId = await deposit(alice, 5, randomKey());
      const offer = await makeOffer(carol, ETH("1"), { tokenId: 5 });
      const id = await placeRequest(boxId, ACTION.AcceptOffer, randomKey(), { to: carol.address, price: 1n, ref: offer.orderHash });
      expect(await finalize(id)).to.eq(REQUEST.Refused);
      expect(await nft.ownerOf(5)).to.eq(vaultAddress);
    });

    it("an order Seaport will not fill now leaves the request waiting, not spoiled, and a day later anyone expires it", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      // The buyer never let Seaport take their WETH.
      const offer = await makeOffer(carol, ETH("1"), { tokenId: 5, noAllowance: true });
      const id = await placeRequest(boxId, ACTION.AcceptOffer, key, { to: fresh.address, price: ETH("1"), ref: offer.orderHash });
      await expect(finalizeOffer(id, offer)).to.be.reverted;
      expect((await vault.requestInfo(id)).status).to.eq(REQUEST.Pending);
      expect(await nft.ownerOf(5)).to.eq(vaultAddress);
      // The buyer fixes it: the same request goes through.
      await (await weth.connect(carol).approve(await seaport.getAddress(), ETH("1"))).wait();
      await (await finalizeOffer(id, offer)).wait();
      expect((await vault.requestInfo(id)).status).to.eq(REQUEST.Done);

      const key2 = randomKey();
      const box2 = await deposit(alice, 6, key2);
      const stuck = await makeOffer(bob, ETH("1"), { tokenId: 6, noAllowance: true });
      const id2 = await placeRequest(box2, ACTION.AcceptOffer, key2, { to: fresh.address, price: ETH("1"), ref: stuck.orderHash });
      await expect(finalizeOffer(id2, stuck)).to.be.reverted;
      await time.increase(DAY + 1);
      await (await vault.connect(carol).expire(id2)).wait();
      expect((await vault.boxInfo(box2)).pending).to.eq(0n);
      expect(await act(box2, ACTION.Withdraw, key2, { to: fresh.address })).to.eq(REQUEST.Done);
    });

    it("a payout to an address that refuses ETH keeps the sale and holds the ETH for a claim", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const offer = await makeOffer(carol, ETH("1"), { tokenId: 5 });
      expect((await acceptOffer(boxId, key, offer, ETH("1"), await nft.getAddress())).status).to.eq(REQUEST.Done);
      const box = await vault.boxInfo(boxId);
      expect(box.state).to.eq(BOX.Sold);
      expect(box.proceeds).to.eq(ETH("1") - feeOf(ETH("1")));
      expect(await act(boxId, ACTION.Claim, key, { to: fresh.address })).to.eq(REQUEST.Done);
    });
  });

  describe("the offer board", function () {
    it("validates a signed offer on Seaport and logs it by NFT, so a holder finds and accepts it", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const offer = await makeOffer(carol, ETH("1"), { tokenId: 5, posted: true });
      expect((await seaport.getOrderStatus(offer.orderHash)).isValidated).to.eq(true);
      const logs = await offers.queryFilter(offers.filters.OfferPosted(await nft.getAddress(), 5));
      expect(logs).to.have.length(1);
      expect(logs[0]!.args.orderHash).to.eq(offer.orderHash);
      expect(logs[0]!.args.order.offerer).to.eq(carol.address);
      // What the page rebuilds from the log is enough to accept it.
      const fromLog = { ...offer, parameters: plain(logs[0]!.args.order) as Offer["parameters"], signature: "0x" };
      expect((await offers.inspect(encodeOffer(fromLog), await nft.getAddress(), 5, 0)).fillable).to.eq(true);
      expect((await acceptOffer(boxId, key, fromLog, ETH("1"), fresh.address)).status).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(5)).to.eq(carol.address);
    });

    it("writes the Seaport call a holder sends itself to fill an offer, as the vault does, approving Seaport for the NFT and the fee alone", async function () {
      // Alice keeps her NFT in her wallet: she is the holder, as the vault is for a box.
      await (await nft.mint(alice.address, 21)).wait();
      const market = ethers.Wallet.createRandom().address;
      const offer = await makeOffer(carol, ETH("1"), { tokenId: 21, fees: [{ to: market, amount: ETH("0.05") }] });
      const encoded = encodeOffer(offer);
      const [call, fee] = await offers.fillCall(encoded, await nft.getAddress(), 21, alice.address);
      expect(fee).to.eq(ETH("0.05"));
      const parsed = seaport.interface.parseTransaction({ data: call })!;
      expect(parsed.name).to.eq("fulfillAdvancedOrder");
      expect(parsed.args[0].numerator).to.eq(1n);
      expect(parsed.args[0].denominator).to.eq(1n);
      expect(parsed.args[3]).to.eq(alice.address);
      // Without the approvals, Seaport cannot take the NFT: nothing moves.
      await expect(alice.sendTransaction({ to: await seaport.getAddress(), data: call })).to.be.reverted;
      await (await nft.connect(alice).approve(await seaport.getAddress(), 21)).wait();
      await (await weth.connect(alice).approve(await seaport.getAddress(), fee)).wait();
      await (await alice.sendTransaction({ to: await seaport.getAddress(), data: call })).wait();
      expect(await nft.ownerOf(21)).to.eq(carol.address);
      expect(await weth.balanceOf(alice.address)).to.eq(ETH("0.95"));
      expect(await weth.balanceOf(market)).to.eq(ETH("0.05"));
      // A collection offer: one share, its criteria resolved to the token.
      await (await nft.mint(alice.address, 22)).wait();
      const any = await makeOffer(bob, ETH("2"), { units: 2n, fees: [{ to: market, amount: ETH("0.1") }] });
      const [callAny, feeAny] = await offers.fillCall(encodeOffer(any), await nft.getAddress(), 22, alice.address);
      expect(feeAny).to.eq(ETH("0.05"));
      const parsedAny = seaport.interface.parseTransaction({ data: callAny })!;
      expect(parsedAny.args[0].denominator).to.eq(2n);
      expect(parsedAny.args[1][0].identifier).to.eq(22n);
      await expect(offers.fillCall(encodeOffer(offer), await nft.getAddress(), 22, alice.address)).to.be.revertedWithCustomError(offers, "NotFilled");
    });

    it("logs a collection offer under ANY_TOKEN", async function () {
      await makeOffer(carol, ETH("2"), { units: 2n, posted: true });
      const any = await offers.ANY_TOKEN();
      expect(await offers.queryFilter(offers.filters.OfferPosted(await nft.getAddress(), any))).to.have.length(1);
    });

    it("refuses what is not an offer for an NFT, or a signature that is not the buyer's", async function () {
      const offer = await makeOffer(carol, ETH("1"), { tokenId: 5 });
      // Asks for WETH only: no NFT.
      const noNft = { ...offer.parameters, consideration: offer.parameters.consideration.slice(1), totalOriginalConsiderationItems: 0n };
      await expect(offers.post(noNft, "0x")).to.be.revertedWithCustomError(offers, "NotAnOffer");
      // A trait offer (criteria root set) needs proofs the page cannot make.
      const trait = {
        ...offer.parameters,
        consideration: [{ ...offer.parameters.consideration[0]!, itemType: 4, identifierOrCriteria: 1n }],
      };
      await expect(offers.post(trait, "0x")).to.be.revertedWithCustomError(offers, "NotAnOffer");
      // Someone else's signature does not validate carol's order.
      const fresh2 = { ...offer.parameters, salt: 1n };
      const domain = { name: "Seaport", version: "1.5", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await seaport.getAddress() };
      const forged = await bob.signTypedData(domain, SEAPORT_TYPES, { ...offer.components, salt: 1n });
      await expect(offers.post(fresh2, forged)).to.be.reverted;
    });
  });

  describe("delegation", function () {
    it("names a wallet in delegate.xyz for the box's NFT, replaces it, and clears it", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      const hot = ethers.Wallet.createRandom().address;
      expect(await act(boxId, ACTION.Delegate, key, { to: hot })).to.eq(REQUEST.Done);
      expect(await delegated(hot, 5)).to.eq(true);
      expect((await vault.boxInfo(boxId)).delegate).to.eq(hot);

      const other = ethers.Wallet.createRandom().address;
      expect(await act(boxId, ACTION.Delegate, key, { to: other })).to.eq(REQUEST.Done);
      expect(await delegated(hot, 5)).to.eq(false);
      expect(await delegated(other, 5)).to.eq(true);

      expect(await act(boxId, ACTION.Delegate, key, { to: ethers.ZeroAddress })).to.eq(REQUEST.Done);
      expect(await delegated(other, 5)).to.eq(false);
      expect((await vault.boxInfo(boxId)).delegate).to.eq(ethers.ZeroAddress);
    });

    it("a wrong key delegates nothing", async function () {
      const boxId = await deposit(alice, 5, randomKey());
      expect(await act(boxId, ACTION.Delegate, randomKey(), { to: carol.address })).to.eq(REQUEST.Refused);
      expect(await delegated(carol.address, 5)).to.eq(false);
    });

    it("a listed box can be delegated", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      await list(boxId, key, ETH("1"));
      expect(await act(boxId, ACTION.Delegate, key, { to: fresh.address })).to.eq(REQUEST.Done);
      expect(await delegated(fresh.address, 5)).to.eq(true);
    });

    it("taking the NFT out, a Seaport sale or an accepted offer clears the delegate", async function () {
      const k1 = randomKey();
      const b1 = await deposit(alice, 1, k1);
      await act(b1, ACTION.Delegate, k1, { to: fresh.address });
      await act(b1, ACTION.Withdraw, k1, { to: alice.address });
      expect(await delegated(fresh.address, 1)).to.eq(false);

      const k2 = randomKey();
      const b2 = await deposit(alice, 2, k2);
      await act(b2, ACTION.Delegate, k2, { to: fresh.address });
      const listingId = await list(b2, k2, ETH("1"));
      await (await fill(listingId, carol)).wait();
      await (await vault.sync(b2)).wait();
      expect(await delegated(fresh.address, 2)).to.eq(false);

      const k3 = randomKey();
      const b3 = await deposit(alice, 3, k3);
      await act(b3, ACTION.Delegate, k3, { to: fresh.address });
      await acceptOffer(b3, k3, await makeOffer(carol, ETH("1"), { tokenId: 3 }), ETH("1"), alice.address);
      expect(await delegated(fresh.address, 3)).to.eq(false);
    });

    it("a box that changes hands keeps its delegate until the new holder sets theirs", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 5, key);
      await act(boxId, ACTION.Delegate, key, { to: fresh.address });
      await (await vault.connect(alice).confidentialTransfer(bob.address, boxId)).wait();
      expect(await delegated(fresh.address, 5)).to.eq(true);
      // Alice's key no longer opens it: she cannot move the delegate.
      expect(await act(boxId, ACTION.Delegate, key, { to: alice.address })).to.eq(REQUEST.Refused);
      const bobKey = randomKey();
      const input = await keyInput(bob, bobKey);
      await (await vault.connect(bob).setKey(boxId, input.handles[0]!, input.inputProof)).wait();
      expect(await act(boxId, ACTION.Delegate, bobKey, { to: carol.address })).to.eq(REQUEST.Done);
      expect(await delegated(fresh.address, 5)).to.eq(false);
      expect(await delegated(carol.address, 5)).to.eq(true);
    });
  });

  describe("admin", function () {
    it("caps the fee and keeps the treasury set", async function () {
      await expect(vault.setFee(1_001)).to.be.revertedWithCustomError(vault, "FeeTooHigh");
      await expect(vault.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await expect(vault.connect(alice).banCollection(alice.address, true)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await expect(vault.banCollection(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });
  });
});
