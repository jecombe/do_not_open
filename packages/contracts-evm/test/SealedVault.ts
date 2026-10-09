import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import type { ContractTransactionReceipt } from "ethers";
import { ethers, fhevm } from "hardhat";
import { ISeaport, SealedVault, TestConfidentialUSDC, TestERC721, TestUSDC } from "../types";
import { confidentialUsdcOf, usd } from "./helpers";
import { installSeaport } from "./seaport";

const BOX = { None: 0n, Sealed: 1n, Listed: 2n, Sold: 3n, Withdrawn: 4n, Claimed: 5n } as const;
const ACTION = { Withdraw: 0, List: 1, Unlist: 2, Claim: 3 } as const;
const REQUEST = { None: 0n, Pending: 1n, Done: 2n, Refused: 3n, Stale: 4n, Expired: 5n } as const;
const DAY = 86_400;
const SALE = { None: 0n, Open: 1n, Settled: 2n, Cancelled: 3n } as const;
const FEE_BPS = 250n;
const feeOf = (price: bigint) => (price * FEE_BPS) / 10_000n;
const ETH = (amount: string) => ethers.parseEther(amount);

/** An ethers Result as plain objects and arrays, the way a contract call takes it back. */
const plain = (value: unknown): unknown => {
  if (!(value instanceof ethers.Result)) return value;
  const keys = Object.keys(value.toObject()).filter((k) => !/^\d+$/.test(k));
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

  type Terms = { to?: string; price?: bigint; endTime?: number };

  /** What the holder's page encrypts for a request: the key bound to the request's terms. */
  async function boundKey(boxId: bigint, action: number, key: bigint, terms: Terms, sender: HardhatEthersSigner) {
    const { nonce } = await vault.boxInfo(boxId);
    const hash = await vault.requestHash(boxId, nonce, action, terms.to ?? ethers.ZeroAddress, terms.price ?? 0n, terms.endTime ?? 0);
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
        .request(boxId, action, opts.to ?? ethers.ZeroAddress, opts.price ?? 0n, opts.endTime ?? 0, input.handles[0]!, input.inputProof)
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
    const parameters = plain(await vault.seaportOrder(listingId)) as Awaited<ReturnType<SealedVault["seaportOrder"]>>;
    const { price } = await vault.listingInfo(listingId);
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
    usdc = (await (await ethers.getContractFactory("TestUSDC")).deploy()) as unknown as TestUSDC;
    cUsdc = (await (await ethers.getContractFactory("TestConfidentialUSDC")).deploy(await usdc.getAddress())) as unknown as TestConfidentialUSDC;
    nft = (await (await ethers.getContractFactory("TestERC721")).deploy()) as unknown as TestERC721;
    vault = (await (await ethers.getContractFactory("SealedVault")).deploy(
      await seaport.getAddress(),
      await cUsdc.getAddress(),
      treasury.address,
      deployer.address,
      FEE_BPS,
    )) as unknown as SealedVault;
    vaultAddress = await vault.getAddress();
    await (await vault.setCollection(await nft.getAddress(), true)).wait();
  });

  describe("deposit", function () {
    it("seals an allowed NFT in a box only its depositor holds", async function () {
      const boxId = await deposit(alice, 7, randomKey());
      expect(await nft.ownerOf(7)).to.eq(vaultAddress);
      expect(await holderOf(boxId)).to.eq(alice.address);
      const box = await vault.boxInfo(boxId);
      expect(box.state).to.eq(BOX.Sealed);
      expect(box.tokenId).to.eq(7n);
      expect(await vault.boxOf(await nft.getAddress(), 7)).to.eq(boxId + 1n);
    });

    it("refuses a collection that is not allowed", async function () {
      await (await vault.setCollection(await nft.getAddress(), false)).wait();
      await (await nft.mint(alice.address, 1)).wait();
      await (await nft.connect(alice).approve(vaultAddress, 1)).wait();
      const i = await depositInput(alice, 1n);
      await expect(vault.connect(alice).deposit(await nft.getAddress(), 1, i.key, i.to, i.really, i.proof)).to.be.revertedWithCustomError(
        vault,
        "CollectionNotAllowed",
      );
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
      await (await vault.connect(relay).request(boxId, ACTION.Withdraw, relay.address, 0, 0, input.handles[0]!, input.inputProof)).wait();
      expect(await finalize(id)).to.eq(REQUEST.Refused);
      expect(await nft.ownerOf(1)).to.eq(vaultAddress);
      // A wrong key spoils nothing: the same input, with the terms alice signed for, still works.
      id = await vault.requestCount();
      await (await vault.connect(relay).request(boxId, ACTION.Withdraw, fresh.address, 0, 0, input.handles[0]!, input.inputProof)).wait();
      expect(await finalize(id)).to.eq(REQUEST.Done);
      expect(await nft.ownerOf(1)).to.eq(fresh.address);
    });

    it("an input that worked once is refused the second time: the nonce moved on", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      const endTime = await inAWeek();
      const input = await boundKey(boxId, ACTION.List, key, { price: ETH("1"), endTime }, relay);
      const send = () => vault.connect(relay).request(boxId, ACTION.List, ethers.ZeroAddress, ETH("1"), endTime, input.handles[0]!, input.inputProof);
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
        vault.connect(relay).request(boxId, ACTION.Withdraw, alice.address, 0, 0, input.handles[0]!, input.inputProof),
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
      expect((await vault.seaportOrder(listingId)).offerer).to.eq(vaultAddress);
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
        vault.connect(relay).request(boxId, ACTION.List, ethers.ZeroAddress, 0, await inAWeek(), input.handles[0]!, input.inputProof),
      ).to.be.revertedWithCustomError(vault, "BadPrice");
      await expect(
        vault.connect(relay).request(boxId, ACTION.List, ethers.ZeroAddress, ETH("1"), await time.latest(), input.handles[0]!, input.inputProof),
      ).to.be.revertedWithCustomError(vault, "BadEndTime");
      await expect(
        vault.connect(relay).request(boxId, ACTION.Claim, fresh.address, 0, 0, input.handles[0]!, input.inputProof),
      ).to.be.revertedWithCustomError(vault, "WrongState");
    });

    it("takes ETH from Seaport only", async function () {
      await expect(alice.sendTransaction({ to: vaultAddress, value: 1n })).to.be.revertedWithCustomError(vault, "OnlySeaport");
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
      await (await vault.connect(relay).request(boxId, ACTION.Withdraw, fresh.address, 0, 0, input.handles[0]!, input.inputProof)).wait();
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
      const send = () => vault.connect(relay).request(boxId, ACTION.Withdraw, fresh.address, 0, 0, input.handles[0]!, input.inputProof);
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

  describe("admin", function () {
    it("caps the fee and keeps the treasury set", async function () {
      await expect(vault.setFee(1_001)).to.be.revertedWithCustomError(vault, "FeeTooHigh");
      await expect(vault.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await expect(vault.connect(alice).setCollection(alice.address, true)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });
});
