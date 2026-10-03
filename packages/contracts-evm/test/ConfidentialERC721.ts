import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { TestConfidentialEscrow, TestConfidentialNFT } from "../types";
import { expectDenied } from "./helpers";

/** The standard on its own, through the smallest collection that uses it. */
describe("ConfidentialERC721", function () {
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let nft: TestConfidentialNFT;
  let address: string;

  const hcu = async (tx: Promise<{ wait(): Promise<unknown> }>) =>
    fhevm.computeTransactionHCU((await (await tx).wait()) as Parameters<typeof fhevm.computeTransactionHCU>[0]);

  /** Mock only: the real owner, from the local coprocessor. */
  const ownerOf = async (tokenId: number) =>
    ethers.getAddress(await fhevm.debugger.decryptEaddress(await nft.confidentialOwnerOf(tokenId)));

  /** The `moved` bit of the last ConfidentialTransfer a transaction emitted. */
  async function movedOf(tx: Promise<{ wait(): Promise<unknown> }>) {
    const receipt = (await (await tx).wait()) as { logs: Parameters<typeof nft.interface.parseLog>[0][] };
    const event = receipt.logs.map((l) => nft.interface.parseLog(l)).filter((e) => e?.name === "ConfidentialTransfer").pop()!;
    return event.args.moved as string;
  }

  /** The discovery the standard is built for: replay one's own receipts. */
  async function holdings(who: HardhatEthersSigner) {
    const f = nft.filters.ConfidentialTransfer;
    const logs = [...(await nft.queryFilter(f(undefined, who.address))), ...(await nft.queryFilter(f(undefined, undefined, who.address)))].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.index - b.index,
    );
    const held = new Set<number>();
    const done = new Set<string>();
    for (const log of logs) {
      const key = `${log.transactionHash}:${log.index}`;
      if (done.has(key)) continue;
      done.add(key);
      if (!(await fhevm.userDecryptEbool(log.args.moved, address, who))) continue;
      if (log.args.from === who.address) held.delete(Number(log.args.tokenId));
      if (log.args.to === who.address) held.add(Number(log.args.tokenId));
    }
    return [...held].sort((a, b) => a - b);
  }

  before(async function () {
    [, alice, bob, carol] = (await ethers.getSigners()) as HardhatEthersSigner[] as [
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
      HardhatEthersSigner,
    ];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    nft = (await (await ethers.getContractFactory("TestConfidentialNFT")).deploy()) as unknown as TestConfidentialNFT;
    address = await nft.getAddress();
  });

  it("announces the interface", async function () {
    const iface = new ethers.Interface([
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function tokenURI(uint256) view returns (string)",
      "function tokenCount() view returns (uint256)",
      "function confidentialOwnerOf(uint256) view returns (bytes32)",
      "function isOperator(address,address) view returns (bool)",
      "function setOperator(address,uint48)",
      "function confidentialTransfer(address,uint256) returns (bytes32)",
      "function confidentialTransferIf(address,uint256,bytes32,bytes) returns (bytes32)",
      "function confidentialTransferFrom(address,address,uint256) returns (bytes32)",
      "function isOwner(uint256,address) returns (bytes32)",
      "function supportsInterface(bytes4) view returns (bool)",
    ]);
    let id = 0n;
    iface.forEachFunction((f) => {
      if (f.name !== "supportsInterface") id ^= BigInt(f.selector);
    });
    expect(await nft.supportsInterface(ethers.toBeHex(id, 4))).to.eq(true);
    expect(await nft.supportsInterface("0x01ffc9a7")).to.eq(true); // ERC-165
    expect(await nft.supportsInterface("0x80ac58cd")).to.eq(false); // not an ERC-721
  });

  describe("mint", function () {
    it("makes a real token and an empty one look the same from outside", async function () {
      const real = await movedOf(nft.mint(alice.address));
      const empty = await movedOf(nft.mintEmpty(alice.address));
      expect(await nft.tokenCount()).to.eq(2);
      expect(await ownerOf(0)).to.eq(alice.address);
      expect(await ownerOf(1)).to.eq(ethers.ZeroAddress);
      // Only the receiver can tell them apart.
      expect(await fhevm.userDecryptEbool(real, address, alice)).to.eq(true);
      expect(await fhevm.userDecryptEbool(empty, address, alice)).to.eq(false);
      await expectDenied(fhevm.userDecryptEbool(real, address, bob));
      await expectDenied(fhevm.publicDecrypt([real]));
      expect(await holdings(alice)).to.deep.eq([0]);
    });

    it("keeps the owner itself unreadable, even to the owner", async function () {
      await nft.mint(alice.address);
      const handle = await nft.confidentialOwnerOf(0);
      await expectDenied(fhevm.userDecryptEaddress(handle, address, alice));
      await expectDenied(fhevm.publicDecrypt([handle]));
      await expect(nft.confidentialOwnerOf(1)).to.be.revertedWithCustomError(nft, "ConfidentialERC721NonexistentToken");
    });
  });

  describe("transfer", function () {
    beforeEach(async function () {
      await nft.mint(alice.address);
    });

    it("moves the token when the sender holds it, and tells only the two sides", async function () {
      const moved = await movedOf(nft.connect(alice).confidentialTransfer(bob.address, 0));
      expect(await ownerOf(0)).to.eq(bob.address);
      expect(await fhevm.userDecryptEbool(moved, address, alice)).to.eq(true);
      expect(await fhevm.userDecryptEbool(moved, address, bob)).to.eq(true);
      await expectDenied(fhevm.userDecryptEbool(moved, address, carol));
      expect(await holdings(alice)).to.deep.eq([]);
      expect(await holdings(bob)).to.deep.eq([0]);
    });

    it("does nothing, without reverting, when the sender does not hold it", async function () {
      const tx = nft.connect(carol).confidentialTransfer(bob.address, 0);
      await expect(tx).to.emit(nft, "ConfidentialTransfer");
      const moved = await movedOf(nft.connect(carol).confidentialTransfer(bob.address, 0));
      expect(await ownerOf(0)).to.eq(alice.address);
      expect(await fhevm.userDecryptEbool(moved, address, bob)).to.eq(false);
      expect(await holdings(bob)).to.deep.eq([]);
      expect(await holdings(alice)).to.deep.eq([0]);
    });

    it("follows a token through several hands, decoys included", async function () {
      await nft.mint(bob.address);
      await nft.connect(alice).confidentialTransfer(bob.address, 0);
      await nft.connect(alice).confidentialTransfer(carol.address, 0); // alice no longer holds 0
      await nft.connect(bob).confidentialTransfer(carol.address, 1);
      await nft.connect(carol).confidentialTransfer(alice.address, 1);
      await nft.connect(bob).confidentialTransfer(bob.address, 0); // to oneself: still held
      expect(await holdings(alice)).to.deep.eq([1]);
      expect(await holdings(bob)).to.deep.eq([0]);
      expect(await holdings(carol)).to.deep.eq([]);
      expect(await ownerOf(0)).to.eq(bob.address);
      expect(await ownerOf(1)).to.eq(alice.address);
    });

    it("sends a decoy when the holder says so, and nobody else can tell it from the real one", async function () {
      const send = async (to: HardhatEthersSigner, really: boolean) => {
        const input = await fhevm.createEncryptedInput(address, alice.address).addBool(really).encrypt();
        return movedOf(nft.connect(alice).confidentialTransferIf(to.address, 0, input.handles[0]!, input.inputProof));
      };
      const decoy = await send(bob, false);
      expect(await ownerOf(0)).to.eq(alice.address);
      const real = await send(carol, true);
      expect(await ownerOf(0)).to.eq(carol.address);
      // Each receiver learns only their own receipt; to anyone else both are a "maybe".
      expect(await fhevm.userDecryptEbool(decoy, address, bob)).to.eq(false);
      expect(await fhevm.userDecryptEbool(real, address, carol)).to.eq(true);
      await expectDenied(fhevm.userDecryptEbool(decoy, address, carol));
      await expectDenied(fhevm.publicDecrypt([real]));
      expect(await holdings(alice)).to.deep.eq([]);
      expect(await holdings(bob)).to.deep.eq([]);
      expect(await holdings(carol)).to.deep.eq([0]);
    });

    it("takes every bit of one encryption, one transaction each, as the app sends decoys", async function () {
      const input = await fhevm.createEncryptedInput(address, alice.address).addBool(false).addBool(true).addBool(false).encrypt();
      const tos = [bob, carol, bob];
      for (const [i, to] of tos.entries()) {
        await nft.connect(alice).confidentialTransferIf(to.address, 0, input.handles[i]!, input.inputProof);
      }
      expect(await ownerOf(0)).to.eq(carol.address);
      expect(await holdings(carol)).to.deep.eq([0]);
      expect(await holdings(bob)).to.deep.eq([]);
    });

    it("moves nothing for a stranger, even with really set to true", async function () {
      const input = await fhevm.createEncryptedInput(address, carol.address).addBool(true).encrypt();
      const moved = await movedOf(nft.connect(carol).confidentialTransferIf(bob.address, 0, input.handles[0]!, input.inputProof));
      expect(await ownerOf(0)).to.eq(alice.address);
      expect(await fhevm.userDecryptEbool(moved, address, bob)).to.eq(false);
    });

    it("refuses the zero address and unknown tokens", async function () {
      await expect(nft.connect(alice).confidentialTransfer(ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(
        nft,
        "ConfidentialERC721InvalidReceiver",
      );
      await expect(nft.connect(alice).confidentialTransfer(bob.address, 7)).to.be.revertedWithCustomError(
        nft,
        "ConfidentialERC721NonexistentToken",
      );
    });

    it("costs one eq and one select on an encrypted address", async function () {
      const used = await hcu(nft.connect(alice).confidentialTransfer(bob.address, 0));
      expect(used.globalHCU).to.be.lessThan(250_000);
    });

    it("adds one and on booleans for a transfer that may be a decoy", async function () {
      const input = await fhevm.createEncryptedInput(address, alice.address).addBool(true).encrypt();
      const used = await hcu(nft.connect(alice).confidentialTransferIf(bob.address, 0, input.handles[0]!, input.inputProof));
      expect(used.globalHCU).to.be.lessThan(300_000);
    });
  });

  describe("operators", function () {
    beforeEach(async function () {
      await nft.mint(alice.address);
    });

    it("lets an operator move a holder's tokens until the date it was given", async function () {
      await expect(nft.connect(carol).confidentialTransferFrom(alice.address, bob.address, 0)).to.be.revertedWithCustomError(
        nft,
        "ConfidentialERC721UnauthorizedSpender",
      );
      const until = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await expect(nft.connect(alice).setOperator(carol.address, until)).to.emit(nft, "OperatorSet").withArgs(alice.address, carol.address, until);
      expect(await nft.isOperator(alice.address, carol.address)).to.eq(true);
      await nft.connect(carol).confidentialTransferFrom(alice.address, bob.address, 0);
      expect(await ownerOf(0)).to.eq(bob.address);

      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);
      expect(await nft.isOperator(alice.address, carol.address)).to.eq(false);
    });
  });

  describe("isOwner", function () {
    beforeEach(async function () {
      await nft.mint(alice.address);
    });

    it("answers the account itself, its operators and trusted contracts only", async function () {
      await nft.connect(alice).isOwner(0, alice.address);
      await expect(nft.connect(bob).isOwner(0, alice.address)).to.be.revertedWithCustomError(nft, "ConfidentialERC721UnauthorizedReader");

      const escrow = (await (await ethers.getContractFactory("TestConfidentialEscrow")).deploy(address)) as unknown as TestConfidentialEscrow;
      // An untrusted contract could publish the answer: it may not ask.
      await expect(escrow.check(0, alice.address)).to.be.revertedWithCustomError(nft, "ConfidentialERC721UnauthorizedReader");
      await nft.setTrusted(await escrow.getAddress(), true);
      await escrow.check(0, alice.address);
    });

    it("tells a trusted contract the truth, for any account", async function () {
      const escrow = (await (await ethers.getContractFactory("TestConfidentialEscrow")).deploy(address)) as unknown as TestConfidentialEscrow;
      await nft.setTrusted(await escrow.getAddress(), true);
      const answer = async (who: string) => {
        await (await escrow.check(0, who)).wait();
        const r = await fhevm.publicDecrypt([await escrow.lastCheck()]);
        return ethers.AbiCoder.defaultAbiCoder().decode(["bool"], r.abiEncodedClearValues)[0] as boolean;
      };
      expect(await answer(alice.address)).to.eq(true);
      expect(await answer(bob.address)).to.eq(false);
    });
  });

  describe("escrow, as a marketplace does it", function () {
    let escrow: TestConfidentialEscrow;
    let escrowAddress: string;

    beforeEach(async function () {
      await nft.mint(alice.address);
      escrow = (await (await ethers.getContractFactory("TestConfidentialEscrow")).deploy(address)) as unknown as TestConfidentialEscrow;
      escrowAddress = await escrow.getAddress();
      const until = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
      await nft.connect(alice).setOperator(escrowAddress, until);
      await nft.connect(bob).setOperator(escrowAddress, until);
    });

    it("pulls a token from a seller who holds it, keeps the bit, and delivers it", async function () {
      await escrow.deposit(alice.address, 0);
      expect(await ownerOf(0)).to.eq(escrowAddress);
      const bit = await escrow.escrowed(0);
      expect(await fhevm.userDecryptEbool(bit, escrowAddress, alice)).to.eq(true);
      await escrow.release(carol.address, 0);
      expect(await ownerOf(0)).to.eq(carol.address);
      expect(await holdings(carol)).to.deep.eq([0]);
    });

    it("gets nothing from a seller who does not hold the token, and delivers nothing", async function () {
      await escrow.deposit(bob.address, 0);
      expect(await ownerOf(0)).to.eq(alice.address);
      expect(await fhevm.userDecryptEbool(await escrow.escrowed(0), escrowAddress, bob)).to.eq(false);
      await escrow.release(carol.address, 0);
      expect(await ownerOf(0)).to.eq(alice.address);
      expect(await holdings(carol)).to.deep.eq([]);
    });
  });

  it("reads the metadata of any token id, empty or not", async function () {
    await nft.mintEmpty(alice.address);
    expect(await nft.tokenURI(0)).to.eq("");
    await expect(nft.tokenURI(1)).to.be.revertedWithCustomError(nft, "ConfidentialERC721NonexistentToken");
    expect(await nft.name()).to.eq("Test Confidential NFT");
    expect(await nft.symbol()).to.eq("TCN");
  });
});
