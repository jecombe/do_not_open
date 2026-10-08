import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { ISeaport, SealedVault, TestConfidentialUSDC, TestERC721, TestUSDC } from "../types";
import { confidentialUsdcOf, usd } from "./helpers";
import { installSeaport } from "./seaport";

const BOX = { None: 0n, Sealed: 1n, Listed: 2n, Sold: 3n, Withdrawn: 4n, Claimed: 5n } as const;
const ACTION = { Withdraw: 0, List: 1, Unlist: 2, Claim: 3 } as const;
const REQUEST = { None: 0n, Pending: 1n, Done: 2n, Refused: 3n, Stale: 4n } as const;
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

  /** Mints NFT `tokenId` to `who` and puts it in a box with `key`. Returns the box id. */
  async function deposit(who: HardhatEthersSigner, tokenId: number, key: bigint) {
    await (await nft.mint(who.address, tokenId)).wait();
    await (await nft.connect(who).approve(vaultAddress, tokenId)).wait();
    const input = await keyInput(who, key);
    const boxId = await vault.tokenCount();
    await (await vault.connect(who).deposit(await nft.getAddress(), tokenId, input.handles[0]!, input.inputProof)).wait();
    return boxId;
  }

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
      const input = await keyInput(alice, 1n);
      await expect(vault.connect(alice).deposit(await nft.getAddress(), 1, input.handles[0]!, input.inputProof)).to.be.revertedWithCustomError(
        vault,
        "CollectionNotAllowed",
      );
    });

    it("refuses an NFT the caller does not hold", async function () {
      await (await nft.mint(alice.address, 2)).wait();
      const input = await keyInput(bob, 1n);
      await expect(vault.connect(bob).deposit(await nft.getAddress(), 2, input.handles[0]!, input.inputProof)).to.be.reverted;
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
      // The same input with the right terms, a request later: the nonce moved on.
      id = await vault.requestCount();
      await (await vault.connect(relay).request(boxId, ACTION.Withdraw, fresh.address, 0, 0, input.handles[0]!, input.inputProof)).wait();
      expect(await finalize(id)).to.eq(REQUEST.Refused);
      expect(await nft.ownerOf(1)).to.eq(vaultAddress);
      expect(await act(boxId, ACTION.Withdraw, key, { to: fresh.address })).to.eq(REQUEST.Done);
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

    it("holds the box still while a request waits", async function () {
      const key = randomKey();
      const boxId = await deposit(alice, 1, key);
      await placeRequest(boxId, ACTION.Withdraw, key, { to: alice.address });
      const input = await keyInput(relay, key);
      await expect(
        vault.connect(relay).request(boxId, ACTION.Withdraw, alice.address, 0, 0, input.handles[0]!, input.inputProof),
      ).to.be.revertedWithCustomError(vault, "BoxBusy");
      await expect(vault.connect(alice).confidentialTransfer(bob.address, boxId)).to.be.revertedWithCustomError(vault, "BoxBusy");
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

  describe("admin", function () {
    it("caps the fee and keeps the treasury set", async function () {
      await expect(vault.setFee(1_001)).to.be.revertedWithCustomError(vault, "FeeTooHigh");
      await expect(vault.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await expect(vault.connect(alice).setCollection(alice.address, true)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });
});
