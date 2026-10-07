import { ratParamsFromSpec } from "../lib/ratParams";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { marketParamsFromSpec } from "../lib/marketParams";
import { DoNotOpen, DoNotOpenHooks, FleaMarket, Rats, TestConfidentialUSDC, TestUSDC } from "../types";

const RAT_POWERS = ratParamsFromSpec().powerBelow;
import {
  REQUEST,
  STARTING_CUSDC,
  confidentialUsdcOf,
  deploy,
  expectDenied,
  finalizeRequest,
  grantedIn,
  holdings,
  mintBoxes,
  open,
  ownerOf,
  requestIdOf,
  usd,
} from "./helpers";

/** Collection in the contract. */
const BOXES = 0;
const RATS = 1;
const LISTING = { None: 0n, Pending: 1n, Active: 2n, Sold: 3n, Cancelled: 4n, Refused: 5n } as const;
const PURCHASE = { None: 0n, Pending: 1n, Done: 2n, Unpaid: 3n, Missed: 4n } as const;
const OFFER = { None: 0n, Open: 1n, Accepted: 2n, Withdrawn: 3n } as const;
const FEE_BPS = BigInt(marketParamsFromSpec().feeBps);
const MAX_PRICE = marketParamsFromSpec().maxPrice;
const feeOf = (price: bigint) => (price * FEE_BPS) / 10_000n;

describe("FleaMarket", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let relay: HardhatEthersSigner;
  /** Holds no cUSDC at all. */
  let broke: HardhatEthersSigner;
  let dno: DoNotOpen;
  let usdc: TestUSDC;
  let cUsdc: TestConfidentialUSDC;
  let hooks: DoNotOpenHooks;
  let rats: Rats;
  let market: FleaMarket;
  let marketAddress: string;

  const nextYear = async () => (await time.latest()) + 365 * 86_400;

  /** Lists a box and relays the proof that it arrived. Returns the listing id. */
  async function listBox(who: HardhatEthersSigner, tokenId: number, price: bigint) {
    const id = await market.listingCount();
    await (await market.connect(who).list(BOXES, tokenId, price)).wait();
    await (await finalizeListing(id)).wait();
    return id;
  }

  async function finalizeListing(listingId: bigint) {
    const { arrived } = await market.listingInfo(listingId);
    const result = await fhevm.publicDecrypt([arrived]);
    return market.connect(relay).finalizeListing(listingId, result.abiEncodedClearValues, result.decryptionProof);
  }

  async function listRat(who: HardhatEthersSigner, tokenId: number, price: bigint) {
    const id = await market.listingCount();
    await (await market.connect(who).list(RATS, tokenId, price)).wait();
    return id;
  }

  /** Places a purchase at the asking price. Returns its id. */
  async function placeBuy(who: HardhatEthersSigner, listingId: bigint) {
    const id = await market.purchaseCount();
    await (await market.connect(who).buy(listingId)).wait();
    return id;
  }

  async function finalizePurchase(purchaseId: bigint) {
    const { ok } = await market.purchaseInfo(purchaseId);
    const result = await fhevm.publicDecrypt([ok]);
    return market.connect(relay).finalizePurchase(purchaseId, result.abiEncodedClearValues, result.decryptionProof);
  }

  /** Buys in both steps. Returns the purchase's final status. */
  async function buy(who: HardhatEthersSigner, listingId: bigint) {
    const id = await placeBuy(who, listingId);
    await (await finalizePurchase(id)).wait();
    return (await market.purchaseInfo(id)).status;
  }

  async function makeOffer(who: HardhatEthersSigner, listingId: bigint, amount: bigint) {
    const input = await fhevm.createEncryptedInput(marketAddress, who.address).add64(amount).encrypt();
    const id = await market.offerCount();
    const receipt = await (await market.connect(who).makeOffer(listingId, input.handles[0]!, input.inputProof)).wait();
    return { id, receipt };
  }

  const decryptOffer = async (offerId: bigint, who: HardhatEthersSigner) =>
    fhevm.userDecryptEuint(FhevmType.euint64, (await market.offerInfo(offerId)).amount, marketAddress, who);

  async function adoptRat(who: HardhatEthersSigner, seed: number) {
    await (await usdc.mint(who.address, usd("1"))).wait();
    await (await usdc.connect(who).approve(await rats.getAddress(), usd("1"))).wait();
    await (await rats.connect(who).mintSeed(seed, usd("1"))).wait();
    return Number(await rats.totalSupply());
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [deployer, alice, bob, carol, relay] = signers as [
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
    ];
    // Signers 0-7 start with cUSDC (see `deploy`); the treasury and the broke buyer do not.
    treasury = signers[8]!;
    broke = signers[9]!;
    ({ dno, usdc, cUsdc } = await deploy({ maxSupply: 100 }));
    hooks = (await (await ethers.getContractFactory("DoNotOpenHooks")).deploy(await dno.getAddress())) as unknown as DoNotOpenHooks;
    rats = (await (await ethers.getContractFactory("Rats")).deploy(
      await usdc.getAddress(), deployer.address, deployer.address, deployer.address, usd("1"), usd("3"), "https://api.test/rats/", [100, 100, 50, 100], RAT_POWERS,
    )) as unknown as Rats;
    market = (await (await ethers.getContractFactory("FleaMarket")).deploy(
      await dno.getAddress(), await hooks.getAddress(), await rats.getAddress(), await cUsdc.getAddress(), treasury.address, deployer.address, FEE_BPS,
    )) as unknown as FleaMarket;
    marketAddress = await market.getAddress();
    // What the app asks of every player once: the market may move their cUSDC, boxes and rats.
    for (const who of [alice, bob, carol, broke]) {
      await (await cUsdc.connect(who).setOperator(marketAddress, await nextYear())).wait();
      await (await dno.connect(who).setOperator(marketAddress, await nextYear())).wait();
      await (await rats.connect(who).setApprovalForAll(marketAddress, true)).wait();
    }
  });

  describe("deployment and admin", function () {
    it("hardcodes the spec's price cap and fee cap", async function () {
      const params = marketParamsFromSpec();
      expect(await market.MAX_PRICE()).to.eq(params.maxPrice);
      expect(await market.MAX_FEE_BPS()).to.eq(params.maxFeeBps);
      expect(await market.feeBps()).to.eq(params.feeBps);
    });

    it("refuses zero addresses and a fee above 10%", async function () {
      const F = await ethers.getContractFactory("FleaMarket");
      const args = [await dno.getAddress(), await hooks.getAddress(), await rats.getAddress(), await cUsdc.getAddress(), treasury.address, deployer.address] as const;
      await expect(F.deploy(ethers.ZeroAddress, args[1], args[2], args[3], args[4], args[5], 0)).to.be.revertedWithCustomError(market, "ZeroAddress");
      await expect(F.deploy(args[0], args[1], ethers.ZeroAddress, args[3], args[4], args[5], 0)).to.be.revertedWithCustomError(market, "ZeroAddress");
      await expect(F.deploy(args[0], args[1], args[2], ethers.ZeroAddress, args[4], args[5], 0)).to.be.revertedWithCustomError(market, "ZeroAddress");
      await expect(F.deploy(args[0], args[1], args[2], args[3], ethers.ZeroAddress, args[5], 0)).to.be.revertedWithCustomError(market, "ZeroAddress");
      await expect(F.deploy(...args, 1_001)).to.be.revertedWithCustomError(market, "FeeTooHigh");
      // No hooks is allowed: boxes are then sold without a state check.
      await F.deploy(args[0], ethers.ZeroAddress, args[2], args[3], args[4], args[5], 1_000);
    });

    it("lets only the owner change the fee, up to 10%, and the treasury", async function () {
      await expect(market.connect(alice).setFee(10)).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
      await expect(market.connect(alice).setTreasury(alice.address)).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
      await expect(market.setFee(1_001)).to.be.revertedWithCustomError(market, "FeeTooHigh");
      await expect(market.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(market, "ZeroAddress");
      await expect(market.setFee(1_000)).to.emit(market, "FeeSet").withArgs(1_000);
      await expect(market.setTreasury(carol.address)).to.emit(market, "TreasurySet").withArgs(carol.address);
      expect(await market.feeBps()).to.eq(1_000);
      expect(await market.treasury()).to.eq(carol.address);
    });
  });

  describe("rats", function () {
    it("lists a rat at once, escrowed by the market", async function () {
      const rat = await adoptRat(alice, 7);
      await expect(market.connect(alice).list(RATS, rat, usd("4")))
        .to.emit(market, "Listed")
        .withArgs(0, RATS, rat, alice.address, usd("4"))
        .and.to.emit(market, "ListingSettled")
        .withArgs(0, true);
      expect(await rats.ownerOf(rat)).to.eq(marketAddress);
      const l = await market.listingInfo(0);
      expect(l.status).to.eq(LISTING.Active);
      expect(l.seller).to.eq(alice.address);
      expect(l.price).to.eq(usd("4"));
      expect(l.tokenId).to.eq(rat);
    });

    it("refuses a rat the caller does not own, or did not approve, and prices out of range", async function () {
      const rat = await adoptRat(alice, 7);
      await expect(market.connect(bob).list(RATS, rat, usd("4"))).to.be.revertedWithCustomError(rats, "ERC721IncorrectOwner");
      await (await rats.connect(alice).setApprovalForAll(marketAddress, false)).wait();
      await expect(market.connect(alice).list(RATS, rat, usd("4"))).to.be.revertedWithCustomError(rats, "ERC721InsufficientApproval");
      await expect(market.connect(alice).list(RATS, rat, 0)).to.be.revertedWithCustomError(market, "BadPrice");
      await expect(market.connect(alice).list(RATS, rat, MAX_PRICE + 1n)).to.be.revertedWithCustomError(market, "BadPrice");
      expect(await market.listingCount()).to.eq(0);
    });

    it("sells a rat at the asking price: the seller gets it minus the fee, the treasury the fee", async function () {
      const rat = await adoptRat(alice, 7);
      const price = usd("10");
      const listing = await listRat(alice, rat, price);
      const purchase = await placeBuy(bob, listing);
      // Paid but not settled: the rat is still in escrow, the money too.
      expect(await rats.ownerOf(rat)).to.eq(marketAddress);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC - price);
      await expect(finalizePurchase(purchase))
        .to.emit(market, "Sold")
        .withArgs(listing, alice.address, bob.address, price, false)
        .and.to.emit(market, "PurchaseSettled")
        .withArgs(purchase, PURCHASE.Done);
      expect(await rats.ownerOf(rat)).to.eq(bob.address);
      expect((await market.listingInfo(listing)).status).to.eq(LISTING.Sold);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(STARTING_CUSDC + price - feeOf(price));
      expect(await confidentialUsdcOf(cUsdc, treasury)).to.eq(feeOf(price));
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC - price);
      // The new owner may sell it on.
      const again = await listRat(bob, rat, usd("12"));
      expect((await market.listingInfo(again)).seller).to.eq(bob.address);
    });

    it("takes nothing from a buyer who cannot pay, and keeps the listing open", async function () {
      const rat = await adoptRat(alice, 7);
      const listing = await listRat(alice, rat, usd("10"));
      const purchase = await placeBuy(broke, listing);
      await expect(finalizePurchase(purchase)).to.emit(market, "PurchaseSettled").withArgs(purchase, PURCHASE.Unpaid);
      expect(await rats.ownerOf(rat)).to.eq(marketAddress);
      expect((await market.listingInfo(listing)).status).to.eq(LISTING.Active);
      expect(await confidentialUsdcOf(cUsdc, broke)).to.eq(0);
      expect(await buy(bob, listing)).to.eq(PURCHASE.Done);
    });

    it("gives the item to the first purchase settled and refunds the others in full", async function () {
      const rat = await adoptRat(alice, 7);
      const price = usd("10");
      const listing = await listRat(alice, rat, price);
      const first = await placeBuy(bob, listing);
      const second = await placeBuy(carol, listing);
      // Settled out of order: the second one to settle loses, whoever placed first.
      await (await finalizePurchase(second)).wait();
      await expect(finalizePurchase(first)).to.emit(market, "PurchaseSettled").withArgs(first, PURCHASE.Missed);
      expect(await rats.ownerOf(rat)).to.eq(carol.address);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC);
      expect(await confidentialUsdcOf(cUsdc, carol)).to.eq(STARTING_CUSDC - price);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(STARTING_CUSDC + price - feeOf(price));
    });

    it("settles a purchase once, and only with its own proof", async function () {
      const rat = await adoptRat(alice, 7);
      const listing = await listRat(alice, rat, usd("10"));
      const paid = await placeBuy(bob, listing);
      const unpaid = await placeBuy(broke, listing);
      // The proof that bob paid does not settle broke's purchase.
      const { ok } = await market.purchaseInfo(paid);
      const result = await fhevm.publicDecrypt([ok]);
      await expect(market.finalizePurchase(unpaid, result.abiEncodedClearValues, result.decryptionProof)).to.be.reverted;
      await (await market.finalizePurchase(paid, result.abiEncodedClearValues, result.decryptionProof)).wait();
      await expect(market.finalizePurchase(paid, result.abiEncodedClearValues, result.decryptionProof)).to.be.revertedWithCustomError(market, "PurchaseNotPending");
      await expect(market.finalizePurchase(99, result.abiEncodedClearValues, result.decryptionProof)).to.be.revertedWithCustomError(market, "PurchaseNotPending");
    });

    it("refuses buying your own listing, or one that is not active", async function () {
      const rat = await adoptRat(alice, 7);
      const listing = await listRat(alice, rat, usd("10"));
      await expect(market.connect(alice).buy(listing)).to.be.revertedWithCustomError(market, "OwnListing");
      await expect(market.connect(bob).buy(5)).to.be.revertedWithCustomError(market, "ListingNotActive");
      await (await market.connect(alice).cancelListing(listing)).wait();
      await expect(market.connect(bob).buy(listing)).to.be.revertedWithCustomError(market, "ListingNotActive");
    });
  });

  describe("reprice and cancel", function () {
    it("reprices for the seller only, and refunds purchases placed at the old price", async function () {
      const rat = await adoptRat(alice, 7);
      const listing = await listRat(alice, rat, usd("10"));
      const old = await placeBuy(bob, listing);
      await expect(market.connect(bob).reprice(listing, usd("1"))).to.be.revertedWithCustomError(market, "NotSeller");
      await expect(market.connect(alice).reprice(listing, 0)).to.be.revertedWithCustomError(market, "BadPrice");
      await expect(market.connect(alice).reprice(listing, usd("20"))).to.emit(market, "Repriced").withArgs(listing, usd("20"));
      await expect(finalizePurchase(old)).to.emit(market, "PurchaseSettled").withArgs(old, PURCHASE.Missed);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC);
      expect(await rats.ownerOf(rat)).to.eq(marketAddress);
      expect(await buy(bob, listing)).to.eq(PURCHASE.Done);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC - usd("20"));
    });

    it("gives the item back on cancel, refunds pending purchases, and cancels once", async function () {
      const rat = await adoptRat(alice, 7);
      const listing = await listRat(alice, rat, usd("10"));
      const pending = await placeBuy(bob, listing);
      await expect(market.connect(bob).cancelListing(listing)).to.be.revertedWithCustomError(market, "NotSeller");
      await expect(market.connect(alice).cancelListing(listing)).to.emit(market, "ListingCancelled").withArgs(listing);
      expect(await rats.ownerOf(rat)).to.eq(alice.address);
      await expect(market.connect(alice).cancelListing(listing)).to.be.revertedWithCustomError(market, "ListingNotActive");
      await expect(market.connect(alice).reprice(listing, usd("1"))).to.be.revertedWithCustomError(market, "ListingNotActive");
      await expect(finalizePurchase(pending)).to.emit(market, "PurchaseSettled").withArgs(pending, PURCHASE.Missed);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC);
    });
  });

  describe("boxes and cats", function () {
    let box: number;

    beforeEach(async function () {
      box = (await mintBoxes(dno, alice, 1, 3)).owned[0]!;
    });

    it("lists a box in two steps: escrowed while the arrival is proven", async function () {
      await expect(market.connect(alice).list(BOXES, box, usd("25")))
        .to.emit(market, "Listed")
        .withArgs(0, BOXES, box, alice.address, usd("25"));
      expect((await market.listingInfo(0)).status).to.eq(LISTING.Pending);
      // Nothing can be done with it before the proof.
      await expect(market.connect(bob).buy(0)).to.be.revertedWithCustomError(market, "ListingNotActive");
      await expect(market.connect(alice).cancelListing(0)).to.be.revertedWithCustomError(market, "ListingNotActive");
      await expect(finalizeListing(0n)).to.emit(market, "ListingSettled").withArgs(0, true);
      expect((await market.listingInfo(0)).status).to.eq(LISTING.Active);
      expect(await ownerOf(dno, box)).to.eq(marketAddress);
      // The seller's own receipts say the box left: it is no longer in their boxes.
      expect(await holdings(dno, alice)).to.not.include(box);
      await expect(finalizeListing(0n)).to.be.revertedWithCustomError(market, "ListingNotPending");
    });

    it("refuses a box the seller does not hold, and moves nothing", async function () {
      await (await market.connect(bob).list(BOXES, box, usd("25"))).wait();
      await expect(finalizeListing(0n)).to.emit(market, "ListingSettled").withArgs(0, false);
      expect((await market.listingInfo(0)).status).to.eq(LISTING.Refused);
      expect(await ownerOf(dno, box)).to.eq(alice.address);
      expect(await holdings(dno, alice)).to.include(box);
    });

    it("cannot list a box twice: once escrowed, a second listing never arrives", async function () {
      await (await market.connect(alice).list(BOXES, box, usd("25"))).wait();
      await (await market.connect(alice).list(BOXES, box, usd("30"))).wait();
      await expect(finalizeListing(1n)).to.emit(market, "ListingSettled").withArgs(1, false);
      await expect(finalizeListing(0n)).to.emit(market, "ListingSettled").withArgs(0, true);
      // Even the holder cannot pull it back out by listing it again from the market.
      await (await market.connect(bob).list(BOXES, box, usd("1"))).wait();
      await expect(finalizeListing(2n)).to.emit(market, "ListingSettled").withArgs(2, false);
      expect(await ownerOf(dno, box)).to.eq(marketAddress);
    });

    it("needs the market to be the seller's operator on the boxes", async function () {
      await (await dno.connect(alice).setOperator(marketAddress, 0)).wait();
      await expect(market.connect(alice).list(BOXES, box, usd("25"))).to.be.revertedWithCustomError(dno, "ConfidentialERC721UnauthorizedSpender");
    });

    it("refuses an arrival proof meant for another listing", async function () {
      await (await market.connect(alice).list(BOXES, box, usd("25"))).wait();
      await (await market.connect(bob).list(BOXES, box, usd("25"))).wait();
      const { arrived } = await market.listingInfo(0);
      const result = await fhevm.publicDecrypt([arrived]);
      await expect(market.finalizeListing(1, result.abiEncodedClearValues, result.decryptionProof)).to.be.reverted;
      // Nor a forged cleartext with a real proof.
      const forged = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [false]);
      await expect(market.finalizeListing(0, forged, result.decryptionProof)).to.be.reverted;
    });

    it("sells a sealed box: it lands in the buyer's own receipts, and its contents stay sealed", async function () {
      const price = usd("25");
      const listing = await listBox(alice, box, price);
      expect(await buy(bob, listing)).to.eq(PURCHASE.Done);
      expect(await ownerOf(dno, box)).to.eq(bob.address);
      expect(await holdings(dno, bob)).to.include(box);
      expect(await holdings(dno, alice)).to.not.include(box);
      expect(await dno.status(box)).to.eq(0);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(STARTING_CUSDC - usd("5") + price - feeOf(price));
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC - price);
      // The buyer really holds it: they can open it.
      expect(await open(dno, box, bob, relay)).to.eq(REQUEST.Done);
    });

    it("sells a cat (an opened box), and the cancel of a box gives it back", async function () {
      expect(await open(dno, box, alice, relay)).to.eq(REQUEST.Done);
      const listing = await listBox(alice, box, usd("40"));
      await (await market.connect(alice).cancelListing(listing)).wait();
      expect(await ownerOf(dno, box)).to.eq(alice.address);
      expect(await holdings(dno, alice)).to.include(box);
      const again = await listBox(alice, box, usd("40"));
      expect(await buy(carol, again)).to.eq(PURCHASE.Done);
      expect(await ownerOf(dno, box)).to.eq(carol.address);
      expect((await dno.contentsOf(box)).seed).to.not.eq(0);
    });

    it("refuses a box whose public state changed in escrow, and refunds a purchase placed before", async function () {
      const { owned } = await mintBoxes(dno, alice, 1, 1);
      const partner = owned[0]!;
      // Alice entangles her two boxes, lists one, then opens the other: both open.
      await (await dno.connect(alice).proposeEntangle(box, partner)).wait();
      const req = requestIdOf(dno, await (await dno.connect(alice).acceptEntangle(box, partner)).wait());
      await (await finalizeRequest(dno, req, relay)).wait();
      const listing = await listBox(alice, box, usd("25"));
      const early = await placeBuy(bob, listing);
      const { id: offer } = await makeOffer(carol, listing, usd("30"));
      expect(await open(dno, partner, alice, relay)).to.eq(REQUEST.Done);
      expect(await dno.status(box)).to.eq(1);

      await expect(market.connect(carol).buy(listing)).to.be.revertedWithCustomError(market, "StateChanged");
      await expect(market.connect(alice).acceptOffer(offer)).to.be.revertedWithCustomError(market, "StateChanged");
      await expect(finalizePurchase(early)).to.emit(market, "PurchaseSettled").withArgs(early, PURCHASE.Missed);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC);
      // The seller takes it back and may list the cat as a cat.
      await (await market.connect(alice).cancelListing(listing)).wait();
      expect(await ownerOf(dno, box)).to.eq(alice.address);
      await (await market.connect(carol).withdrawOffer(offer)).wait();
      expect(await confidentialUsdcOf(cUsdc, carol)).to.eq(STARTING_CUSDC);
    });

    it("keeps a box's paid-shake earnings in it for whoever buys it", async function () {
      const listing = await listBox(alice, box, usd("25"));
      // Anyone may still shake it in escrow, for a fee; the holder's share waits in the box.
      await (await dno.connect(carol).paidShake(box)).wait();
      expect(await buy(bob, listing)).to.eq(PURCHASE.Done);
      const before = await confidentialUsdcOf(cUsdc, bob);
      await (await dno.connect(bob).claimEarnings([box])).wait();
      expect(await confidentialUsdcOf(cUsdc, bob)).to.be.gt(before);
    });
  });

  describe("secret offers", function () {
    let rat: number;
    let listing: bigint;

    beforeEach(async function () {
      rat = await adoptRat(alice, 9);
      listing = await listRat(alice, rat, usd("50"));
    });

    it("escrows an encrypted amount only the buyer and the seller can read", async function () {
      const { id, receipt } = await makeOffer(bob, listing, usd("31.5"));
      const offerEvent = receipt!.logs.map((l) => market.interface.parseLog(l)).find((e) => e?.name === "OfferMade")!;
      expect(offerEvent.args.length).to.eq(3);
      expect(await decryptOffer(id, bob)).to.eq(usd("31.5"));
      expect(await decryptOffer(id, alice)).to.eq(usd("31.5"));
      await expectDenied(decryptOffer(id, carol));
      // Allowed for good: the market, the buyer and the seller. Nobody else.
      const granted = new Set(grantedIn(receipt));
      expect(granted.has(bob.address) && granted.has(alice.address) && granted.has(marketAddress)).to.eq(true);
      expect(granted.has(carol.address)).to.eq(false);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC - usd("31.5"));
      const o = await market.offerInfo(id);
      expect(o.status).to.eq(OFFER.Open);
      expect(o.buyer).to.eq(bob.address);
      expect(o.listingId).to.eq(listing);
    });

    it("sells on acceptance at the secret price, and never makes the price public", async function () {
      const amount = usd("31.5");
      const { id } = await makeOffer(bob, listing, amount);
      await expect(market.connect(bob).acceptOffer(id)).to.be.revertedWithCustomError(market, "NotSeller");
      await expect(market.connect(alice).acceptOffer(id))
        .to.emit(market, "Sold")
        .withArgs(listing, alice.address, bob.address, 0, true)
        .and.to.emit(market, "OfferAccepted")
        .withArgs(id, listing);
      expect(await rats.ownerOf(rat)).to.eq(bob.address);
      expect((await market.offerInfo(id)).status).to.eq(OFFER.Accepted);
      expect((await market.listingInfo(listing)).status).to.eq(LISTING.Sold);
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(STARTING_CUSDC + amount - feeOf(amount));
      expect(await confidentialUsdcOf(cUsdc, treasury)).to.eq(feeOf(amount));
      await expect(market.connect(alice).acceptOffer(id)).to.be.revertedWithCustomError(market, "OfferNotOpen");
      await expect(market.connect(bob).withdrawOffer(id)).to.be.revertedWithCustomError(market, "OfferNotOpen");
    });

    it("lets losing offers be withdrawn after the sale, in full", async function () {
      const { id: low } = await makeOffer(bob, listing, usd("20"));
      const { id: high } = await makeOffer(carol, listing, usd("45"));
      await (await market.connect(alice).acceptOffer(high)).wait();
      await expect(market.connect(alice).acceptOffer(low)).to.be.revertedWithCustomError(market, "ListingNotActive");
      await expect(market.connect(carol).withdrawOffer(low)).to.be.revertedWithCustomError(market, "NotBuyer");
      await expect(market.connect(bob).withdrawOffer(low)).to.emit(market, "OfferWithdrawn").withArgs(low);
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC);
      expect(await rats.ownerOf(rat)).to.eq(carol.address);
    });

    it("an offer may also lose to a purchase at the asking price", async function () {
      const { id } = await makeOffer(bob, listing, usd("20"));
      expect(await buy(carol, listing)).to.eq(PURCHASE.Done);
      await expect(market.connect(alice).acceptOffer(id)).to.be.revertedWithCustomError(market, "ListingNotActive");
      await (await market.connect(bob).withdrawOffer(id)).wait();
      expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(STARTING_CUSDC);
    });

    it("escrows zero from an empty wallet, and the seller can see it", async function () {
      const { id } = await makeOffer(broke, listing, usd("49"));
      expect(await decryptOffer(id, alice)).to.eq(0);
      expect(await decryptOffer(id, broke)).to.eq(0);
    });

    it("caps an offer at the maximum price, under encryption", async function () {
      const rich = usd("1500000");
      await (await usdc.mint(carol.address, rich)).wait();
      await (await usdc.connect(carol).approve(await cUsdc.getAddress(), rich)).wait();
      await (await cUsdc.connect(carol).wrap(carol.address, rich)).wait();
      const { id } = await makeOffer(carol, listing, rich);
      expect(await decryptOffer(id, carol)).to.eq(MAX_PRICE);
      await (await market.setFee(1_000)).wait();
      await (await market.connect(alice).acceptOffer(id)).wait();
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(STARTING_CUSDC + MAX_PRICE - MAX_PRICE / 10n);
      expect(await confidentialUsdcOf(cUsdc, treasury)).to.eq(MAX_PRICE / 10n);
    });

    it("takes no fee when the fee is zero", async function () {
      await (await market.setFee(0)).wait();
      const { id } = await makeOffer(bob, listing, usd("10"));
      await (await market.connect(alice).acceptOffer(id)).wait();
      expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(STARTING_CUSDC + usd("10"));
      expect(await confidentialUsdcOf(cUsdc, treasury)).to.eq(0);
    });

    it("refuses offers on your own listing or on a listing that is not active", async function () {
      const input = await fhevm.createEncryptedInput(marketAddress, alice.address).add64(1).encrypt();
      await expect(market.connect(alice).makeOffer(listing, input.handles[0]!, input.inputProof)).to.be.revertedWithCustomError(market, "OwnListing");
      await (await market.connect(alice).cancelListing(listing)).wait();
      const late = await fhevm.createEncryptedInput(marketAddress, bob.address).add64(1).encrypt();
      await expect(market.connect(bob).makeOffer(listing, late.handles[0]!, late.inputProof)).to.be.revertedWithCustomError(market, "ListingNotActive");
    });

    it("offers on a box: the seller who escrowed it can accept", async function () {
      const { owned } = await mintBoxes(dno, alice, 1, 1);
      const box = owned[0]!;
      const boxListing = await listBox(alice, box, usd("100"));
      const { id } = await makeOffer(bob, boxListing, usd("60"));
      expect(await decryptOffer(id, alice)).to.eq(usd("60"));
      await (await market.connect(alice).acceptOffer(id)).wait();
      expect(await ownerOf(dno, box)).to.eq(bob.address);
      expect(await holdings(dno, bob)).to.include(box);
    });
  });

  describe("reads", function () {
    it("pages through listings", async function () {
      const a = await adoptRat(alice, 1);
      const b = await adoptRat(alice, 2);
      const c = await adoptRat(bob, 3);
      await listRat(alice, a, usd("1"));
      await listRat(alice, b, usd("2"));
      await listRat(bob, c, usd("3"));
      expect((await market.listings(0, 10)).map((l) => l.price)).to.deep.eq([usd("1"), usd("2"), usd("3")]);
      expect((await market.listings(1, 1)).map((l) => l.tokenId)).to.deep.eq([BigInt(b)]);
      expect(await market.listings(3, 5)).to.deep.eq([]);
      expect(await market.listings(10, 5)).to.deep.eq([]);
    });
  });
});
