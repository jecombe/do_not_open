// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint32, euint64, euint256, externalEuint256} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {SealedPockets} from "../SealedPockets.sol";
import {SealedVault} from "../SealedVault.sol";

/// @title The pockets' desk
/// @notice Buys sealed vault boxes offered in a private sale with a pocket's tokens. The seller
///         offers the box to this desk and reserves the sale for the buyer's pocket; the pocket's
///         holder then buys it with the pocket's key, through any wallet. The box is held by the
///         desk, a holder every pocket shares, and its vault key is the buyer's: taking the NFT
///         out, listing it, accepting offers and delegating work as for any box.
///
/// @dev A purchase is asked first (`ask`): the key and the balance are checked under encryption
///      and only that bit is made public, so a stranger's wrong key cannot spend the seller's sale
///      (the vault settles a sale on its first `acceptSale`, paid or not). `buy` then runs it.
///
///      The desk holds tokens only during `buy`: it takes the price from the pocket (or nothing,
///      when the key is wrong or the balance short), lets the vault pull it (all or nothing, so a
///      pocket that paid nothing buys nothing), and hands back whatever the vault refunded. It
///      never sells, so nothing else ever sits in its balance for the vault to pull.
contract PocketDesk is ZamaEthereumConfig, ReentrancyGuard {
    SealedPockets public immutable pockets;
    SealedVault public immutable vault;
    IERC7984 public immutable token;

    /// @notice The pocket a sale offered to the desk is reserved for, + 1. Public: the seller knows it.
    mapping(uint256 saleId => uint256 pocketIdPlusOne) public reservedFor;
    /// @notice Bound keys already used.
    mapping(bytes32 handle => bool) public spent;
    enum AskStatus {
        None,
        Pending,
        Done,
        /// The key was wrong or the pocket short: nothing happened, the sale is still open.
        Refused
    }

    struct Ask {
        uint256 saleId;
        uint256 pocketId;
        /// The pocket's key, as the ask gave it: `buy` takes the price with it.
        euint256 key;
        /// The key matched and the pocket covered the price, publicly decryptable.
        ebool ok;
        /// The handle of the box's new vault key, which `buy` must bring.
        bytes32 boxKey;
        AskStatus status;
    }

    uint256 public askCount;
    mapping(uint256 askId => Ask) private _asks;

    /// @dev The pocket each box the desk bought belongs to, + 1, encrypted: 0 until a purchase moved it.
    mapping(uint256 boxId => euint32) private _owner;

    error NotForDesk();
    error NotSeller();
    error NotReserved();
    error KeyUsed();
    error AskNotPending();
    error WrongBoxKey();

    /// @notice The seller of `saleId` reserved it for `pocketId`.
    event Reserved(uint256 indexed saleId, uint256 indexed pocketId);
    event Asked(uint256 indexed askId, uint256 indexed saleId, uint256 indexed pocketId);
    event AskSettled(uint256 indexed askId, AskStatus status);
    /// @notice `pocketId` tried to buy `boxId`: whether it paid and the box moved is encrypted.
    event Bought(uint256 indexed saleId, uint256 indexed boxId, uint256 indexed pocketId);

    constructor(SealedPockets pockets_, SealedVault vault_) {
        pockets = pockets_;
        vault = vault_;
        token = pockets_.token();
        // The vault pulls a sale's price from its buyer: here, only ever what `buy` just took.
        token.setOperator(address(vault_), type(uint48).max);
    }

    /// @notice The seller of a private sale offered to this desk names the pocket that may buy it,
    ///         whose viewer may then read the price.
    function reserve(uint256 saleId, uint256 pocketId) external {
        SealedVault.Sale memory s = vault.saleInfo(saleId);
        if (s.buyer != address(this) || s.status != SealedVault.SaleStatus.Open) revert NotForDesk();
        if (s.seller != msg.sender) revert NotSeller();
        // The pocket's holder reads the price before buying (reverts for a pocket never opened).
        FHE.allow(s.price, pockets.viewerOf(pocketId));
        reservedFor[saleId] = pocketId + 1;
        emit Reserved(saleId, pocketId);
    }

    /// @notice Step 1 of a purchase: checks, under encryption, that `boundKey` is the reserved
    ///         pocket's key (XOR `buyHash(saleId, pocket, boxKey)`, encrypted for this desk) and
    ///         that the pocket covers the price, and makes only that bit public. Anyone may send it.
    ///         The sale stays open either way: a stranger's wrong key cannot spend it.
    function ask(uint256 saleId, externalEuint256 boundKey, bytes calldata keyProof, bytes32 boxKey) external returns (uint256 askId) {
        uint256 pocketId = _reserved(saleId);
        SealedVault.Sale memory s = _openSale(saleId);
        euint256 k = _key(boundKey, keyProof, buyHash(saleId, pocketId, boxKey));
        FHE.allowThis(k);
        FHE.allowTransient(k, address(pockets));
        FHE.allowTransient(s.price, address(pockets));
        ebool ok = pockets.deskCheck(pocketId, k, s.price);
        FHE.allowThis(ok);
        FHE.makePubliclyDecryptable(ok);
        askId = askCount++;
        _asks[askId] = Ask({saleId: saleId, pocketId: pocketId, key: k, ok: ok, boxKey: boxKey, status: AskStatus.Pending});
        emit Asked(askId, saleId, pocketId);
    }

    /// @notice Step 2: with the proof of the bit, buys the sale if it was true. `boxKey` is the
    ///         box's new vault key, encrypted for the vault with this desk as its user: the one the
    ///         ask named. Anyone may send it. The pocket pays only if its key and balance still
    ///         hold, and the box moves only if it paid and the seller still holds the box.
    function buy(uint256 askId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof, externalEuint256 boxKey, bytes calldata boxKeyProof)
        external
        nonReentrant
    {
        Ask storage a = _asks[askId];
        if (a.status != AskStatus.Pending) revert AskNotPending();
        if (externalEuint256.unwrap(boxKey) != a.boxKey) revert WrongBoxKey();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(a.ok);
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);
        if (!abi.decode(abiEncodedCleartexts, (bool))) {
            a.status = AskStatus.Refused;
            emit AskSettled(askId, AskStatus.Refused);
            return;
        }
        SealedVault.Sale memory s = _openSale(a.saleId);
        uint256 pocketId = a.pocketId;
        // The seller may have reserved the sale for another pocket since.
        if (reservedFor[a.saleId] != pocketId + 1) revert NotReserved();
        FHE.allowTransient(a.key, address(pockets));
        FHE.allowTransient(s.price, address(pockets));
        pockets.deskTake(pocketId, a.key, s.price);
        vault.acceptSale(a.saleId, boxKey, boxKeyProof);
        _handBack(pocketId);
        _record(a.saleId, s.boxId, pocketId);
        a.status = AskStatus.Done;
        emit AskSettled(askId, AskStatus.Done);
    }

    function askInfo(uint256 askId) external view returns (Ask memory) {
        return _asks[askId];
    }

    function _reserved(uint256 saleId) private view returns (uint256) {
        uint256 reserved = reservedFor[saleId];
        if (reserved == 0) revert NotReserved();
        return reserved - 1;
    }

    function _openSale(uint256 saleId) private view returns (SealedVault.Sale memory s) {
        s = vault.saleInfo(saleId);
        if (s.buyer != address(this) || s.status != SealedVault.SaleStatus.Open) revert NotForDesk();
    }

    function _key(externalEuint256 boundKey, bytes calldata keyProof, uint256 terms) private returns (euint256) {
        bytes32 h = externalEuint256.unwrap(boundKey);
        if (spent[h]) revert KeyUsed();
        spent[h] = true;
        return FHE.xor(FHE.fromExternal(boundKey, keyProof), terms);
    }

    /// @dev A refund (the seller no longer held the box) goes back to the pocket; otherwise this is 0.
    function _handBack(uint256 pocketId) private {
        euint64 back = token.confidentialBalanceOf(address(this));
        FHE.allowTransient(back, address(token));
        euint64 sent = token.confidentialTransfer(address(pockets), back);
        FHE.allowTransient(sent, address(pockets));
        pockets.deskGive(pocketId, sent);
    }

    /// @dev The box is the pocket's if it moved; the pocket's viewer may read both.
    function _record(uint256 saleId, uint256 boxId, uint256 pocketId) private {
        ebool moved = vault.saleInfo(saleId).moved;
        address viewer = pockets.viewerOf(pocketId);
        euint32 owner = FHE.select(moved, FHE.asEuint32(uint32(pocketId + 1)), _owner[boxId]);
        FHE.allowThis(owner);
        FHE.allow(owner, viewer);
        _owner[boxId] = owner;
        FHE.allow(moved, viewer);
        emit Bought(saleId, boxId, pocketId);
    }

    /// @notice What a purchase's key is bound to.
    function buyHash(uint256 saleId, uint256 pocketId, bytes32 boxKey) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), saleId, pocketId, boxKey)));
    }

    /// @notice The pocket a box bought here belongs to, + 1 (0: none), readable by the buyers' viewers.
    function ownerOf(uint256 boxId) external view returns (euint32) {
        return _owner[boxId];
    }
}
