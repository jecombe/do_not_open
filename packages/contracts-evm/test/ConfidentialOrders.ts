import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { configParamsFromSpec } from "../lib/specParams";
import { DoNotOpen, TestConfidentialUSDC, TestUSDC } from "../types";
import {
  confidentialUsdcOf,
  deploy,
  FEES,
  finalizeObserve,
  finalizeOrder,
  giveConfidentialUsdc,
  peekSeed,
  traitByte,
  usd,
} from "./helpers";

const Purchase = { Mint: 0, Feed: 1, Observe: 2, PaidShake: 3 } as const;
const Status = { None: 0, Pending: 1, Done: 2, Unpaid: 3, Refunded: 4 } as const;

describe("DoNotOpen cUSDC orders", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dno: DoNotOpen;
  let address: string;
  let usdc: TestUSDC;
  let cUsdc: TestConfidentialUSDC;
  const params = configParamsFromSpec();

  /** Places an order and returns its id. */
  const order = async (who: HardhatEthersSigner, purchase: number, arg: number) => {
    const receipt = await (await dno.connect(who).order(purchase, arg)).wait();
    const placed = receipt!.logs.map((l) => dno.interface.parseLog(l)).find((e) => e?.name === "OrderPlaced");
    return placed!.args.orderId as bigint;
  };
  const statusOf = async (orderId: bigint) => Number((await dno.orderInfo(orderId))[2]);

  before(async function () {
    [deployer, alice, bob, carol] = (await ethers.getSigners()) as [
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
    ];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    ({ dno, address, usdc, cUsdc } = await deploy({ maxSupply: 8 }));
    for (const who of [alice, bob, carol]) await giveConfidentialUsdc(usdc, cUsdc, dno, who, usd("100"));
  });

  it("mints only once the payment is proven, and keeps the boxes for the order meanwhile", async function () {
    const id = await order(alice, Purchase.Mint, 3);
    expect(await dno.totalMinted()).to.eq(0);
    expect(await dno.reserved()).to.eq(3);
    expect(await statusOf(id)).to.eq(Status.Pending);
    // 8 boxes, 3 held back: 6 more would be one too many.
    await expect(dno.connect(bob).mint(6)).to.be.revertedWithCustomError(dno, "SoldOut");

    await expect(finalizeOrder(dno, id, carol))
      .to.emit(dno, "Minted")
      .withArgs(0, alice.address)
      .and.to.emit(dno, "OrderSettled")
      .withArgs(id, Status.Done);
    expect(await dno.balanceOf(alice.address)).to.eq(3);
    expect(await dno.reserved()).to.eq(0);
    expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(usd("100") - FEES.mint * 3n);
    expect(await dno.confidentialRevenue()).to.eq(FEES.mint * 3n);
  });

  it("moves nothing and mints nothing when the buyer cannot pay", async function () {
    const poor = (await ethers.getSigners())[5]!;
    await giveConfidentialUsdc(usdc, cUsdc, dno, poor, usd("1"));
    const id = await order(poor, Purchase.Mint, 1);
    await expect(finalizeOrder(dno, id, poor)).to.emit(dno, "OrderSettled").withArgs(id, Status.Unpaid);
    expect(await dno.totalMinted()).to.eq(0);
    expect(await dno.reserved()).to.eq(0);
    expect(await confidentialUsdcOf(cUsdc, poor)).to.eq(usd("1"));
  });

  it("feeds, opens and shakes for cUSDC", async function () {
    await dno.connect(alice).mint(2);

    await finalizeOrder(dno, await order(carol, Purchase.Feed, 0), carol);
    expect(await dno.feedCount(0)).to.eq(1);

    const share = (FEES.paidShake * BigInt(params.paidShakeHolderBps)) / 10_000n;
    const before = await confidentialUsdcOf(cUsdc, alice);
    await finalizeOrder(dno, await order(carol, Purchase.PaidShake, 0), bob);
    const [pick, roll] = await dno.lastShake(0, carol.address);
    const p = Number(await fhevm.userDecryptEuint(FhevmType.euint8, pick, address, carol));
    const r = Number(await fhevm.userDecryptEuint(FhevmType.euint8, roll, address, carol));
    expect(r).to.eq(traitByte(await peekSeed(dno, 0), p));
    // The holder's share arrives at once, in cUSDC.
    expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(before + share);

    await finalizeOrder(dno, await order(alice, Purchase.Observe, 1), bob);
    await finalizeObserve(dno, 1, bob);
    expect(await dno.revealed(1)).to.eq(true);

    expect(await dno.confidentialRevenue()).to.eq(FEES.feed + FEES.paidShake - share + FEES.observe);
  });

  it("checks the same rules as the plain functions when the order is placed", async function () {
    await dno.connect(alice).mint(1);
    await expect(dno.connect(bob).order(Purchase.Observe, 0)).to.be.revertedWithCustomError(dno, "NotHolder");
    await expect(dno.connect(alice).order(Purchase.PaidShake, 0)).to.be.revertedWithCustomError(dno, "HolderShakesForFree");
    await expect(dno.connect(alice).order(Purchase.Feed, 5)).to.be.revertedWithCustomError(dno, "ERC721NonexistentToken");
    await expect(dno.connect(alice).order(Purchase.Mint, 0)).to.be.revertedWithCustomError(dno, "InvalidQuantity");
    const stranger = (await ethers.getSigners())[6]!;
    await expect(dno.connect(stranger).order(Purchase.Mint, 1)).to.be.revertedWithCustomError(cUsdc, "ERC7984UnauthorizedSpender");
  });

  it("refunds a paid order the box no longer allows", async function () {
    await dno.connect(alice).mint(1);
    const id = await order(alice, Purchase.Observe, 0);
    // Alice sells the box before the order settles.
    await dno.connect(alice).transferFrom(alice.address, bob.address, 0);
    await expect(finalizeOrder(dno, id, carol)).to.emit(dno, "OrderSettled").withArgs(id, Status.Refunded);
    expect(await dno.status(0)).to.eq(0);
    expect(await confidentialUsdcOf(cUsdc, alice)).to.eq(usd("100"));
    expect(await dno.confidentialRevenue()).to.eq(0);
  });

  it("settles an order once, with a proof for its own bit only", async function () {
    const a = await order(alice, Purchase.Mint, 1);
    const b = await order(bob, Purchase.Mint, 1);
    const proofA = await fhevm.publicDecrypt([(await dno.orderInfo(a))[5]]);
    await expect(dno.finalizeOrder(b, proofA.abiEncodedClearValues, proofA.decryptionProof)).to.be.reverted;
    await dno.finalizeOrder(a, proofA.abiEncodedClearValues, proofA.decryptionProof);
    await expect(dno.finalizeOrder(a, proofA.abiEncodedClearValues, proofA.decryptionProof)).to.be.revertedWithCustomError(
      dno,
      "OrderNotPending",
    );
  });

  it("lets the owner withdraw cUSDC revenue, never a pending order's price", async function () {
    await finalizeOrder(dno, await order(alice, Purchase.Mint, 2), alice);
    await order(bob, Purchase.Mint, 1);
    await expect(dno.connect(alice).withdrawConfidential(alice.address)).to.be.revertedWithCustomError(
      dno,
      "OwnableUnauthorizedAccount",
    );
    await dno.connect(deployer).withdrawConfidential(deployer.address);
    expect(await confidentialUsdcOf(cUsdc, deployer)).to.eq(FEES.mint * 2n);
    expect(await dno.confidentialRevenue()).to.eq(0);
    // Bob's price is still there for his order.
    expect(await confidentialUsdcOf(cUsdc, bob)).to.eq(usd("100") - FEES.mint);
  });

  it("stays within the documented HCU budget", async function () {
    const receipt = await (await dno.connect(alice).order(Purchase.Mint, 1)).wait();
    expect(fhevm.computeTransactionHCU(receipt!).globalHCU).to.be.lessThan(700_000);
  });
});
