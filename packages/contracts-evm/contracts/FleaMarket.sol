// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IConfidentialERC721} from "./confidential/IConfidentialERC721.sol";
import {ICollectionHooks} from "./market/ICollectionHooks.sol";

/// @title The flea market
/// @notice Where players sell each other boxes, cats (opened boxes) and rats, in cUSDC.
///
///         Two ways to buy:
///         - at the asking price, which is public: `buy`, then a public decryption of "the buyer
///           paid it" settles the sale (`finalizePurchase`);
///         - with a secret offer: `makeOffer` escrows an encrypted amount that only the seller
///           and the buyer can read; `acceptOffer` sells at once. That price is never public.
///
/// @dev Design notes.
///
///  1. The market holds what it sells. A rat (plain ERC-721) is escrowed with `transferFrom` and
///     listed at once. A box is a confidential ERC-721: nobody can check its owner, so `list`
///     pulls it with `confidentialTransferFrom`, which never reverts, and makes the "it arrived"
///     bit publicly decryptable; `finalizeListing` proves it. Only a seller who held the box gets
///     an active listing, and since the market then holds it, nobody else can list it again.
///
///  2. Payments are all-or-nothing cUSDC pulls (ERC-7984): what arrived is either the amount or
///     zero, encrypted. A purchase stores what arrived and refunds it unless the sale settles,
///     so a buyer who could not pay, or who was beaten to the item, gets back exactly what left
///     their wallet. Several purchases may be pending on one listing: the first one settled
///     with "paid" wins, the others are refunded. Nothing locks a listing.
///
///  3. A secret offer is capped at `MAX_PRICE` under encryption, so the fee computed on it can
///     never overflow. The seller decrypts the amount before accepting; an offer from an empty
///     wallet holds zero and the seller sees it.
///
///  4. A box is sold in a given public state (sealed or opened, entangled or not, vet checked or
///     not). The collection's hooks take a snapshot of it at listing; if it changed (an
///     entangled partner opened it, say), buying and accepting revert, and a pending purchase is
///     refunded.
///
///  5. What becomes public: the seller of a listing (once active), the asking price, the buyer of
///     a sale, and per purchase whether the buyer could pay. Never public: balances, offer
///     amounts, the price of a sale made by offer, or what is inside a sealed box.
contract FleaMarket is Ownable, ReentrancyGuard, ZamaEthereumConfig {
    enum Collection {
        Boxes,
        Rats
    }

    enum ListingStatus {
        None,
        /// A box on its way: waiting for the proof that it arrived.
        Pending,
        Active,
        Sold,
        Cancelled,
        /// The box never arrived: the seller did not hold it. Nothing happened.
        Refused
    }

    enum PurchaseStatus {
        None,
        Pending,
        /// Paid and delivered.
        Done,
        /// The buyer could not pay: nothing left their wallet.
        Unpaid,
        /// Paid, but the listing was sold, cancelled or changed first: refunded.
        Missed
    }

    enum OfferStatus {
        None,
        Open,
        Accepted,
        Withdrawn
    }

    struct Listing {
        Collection collection;
        ListingStatus status;
        address seller;
        uint64 price;
        uint64 listedAt;
        uint256 tokenId;
        /// The collection hooks' snapshot of the item's public state, or zero without hooks.
        bytes32 snapshot;
        /// Boxes only: "the box arrived", publicly decryptable until the listing is settled.
        ebool arrived;
    }

    struct Purchase {
        uint256 listingId;
        address buyer;
        PurchaseStatus status;
        uint64 price;
        /// What arrived from the buyer: the price or zero.
        euint64 paid;
        /// paid == price, publicly decryptable.
        ebool ok;
    }

    struct Offer {
        uint256 listingId;
        address buyer;
        OfferStatus status;
        /// Escrowed cUSDC. Readable by the buyer and the listing's seller only.
        euint64 amount;
    }

    /// @notice One million USDC: the most an item can be listed or offered for.
    uint64 public constant MAX_PRICE = 1_000_000_000_000;
    /// @notice The fee can never exceed 10%.
    uint16 public constant MAX_FEE_BPS = 1_000;

    IConfidentialERC721 public immutable boxes;
    IERC721 public immutable rats;
    IERC7984 public immutable confidentialUsdc;
    /// @notice Checks a box's public state between listing and sale. May be zero.
    ICollectionHooks public immutable boxHooks;

    address public treasury;
    uint16 public feeBps;

    uint256 public listingCount;
    uint256 public purchaseCount;
    uint256 public offerCount;

    mapping(uint256 listingId => Listing) private _listings;
    mapping(uint256 purchaseId => Purchase) private _purchases;
    mapping(uint256 offerId => Offer) private _offers;

    error ZeroAddress();
    error FeeTooHigh();
    error BadPrice();
    error NotSeller();
    error NotBuyer();
    error OwnListing();
    error ListingNotPending();
    error ListingNotActive();
    error PurchaseNotPending();
    error OfferNotOpen();
    error StateChanged();

    event Listed(uint256 indexed listingId, Collection indexed collection, uint256 indexed tokenId, address seller, uint64 price);
    /// @notice The box arrived (`active`) or did not, and the listing was refused.
    event ListingSettled(uint256 indexed listingId, bool active);
    event Repriced(uint256 indexed listingId, uint64 price);
    event ListingCancelled(uint256 indexed listingId);
    event PurchaseRequested(uint256 indexed purchaseId, uint256 indexed listingId, address indexed buyer, uint64 price);
    event PurchaseSettled(uint256 indexed purchaseId, PurchaseStatus status);
    /// @notice The amount is deliberately absent: only the buyer and the seller can read it.
    event OfferMade(uint256 indexed offerId, uint256 indexed listingId, address indexed buyer);
    event OfferWithdrawn(uint256 indexed offerId);
    event OfferAccepted(uint256 indexed offerId, uint256 indexed listingId);
    /// @notice An item changed hands. `price` is zero for a sale made by secret offer.
    event Sold(uint256 indexed listingId, address indexed seller, address indexed buyer, uint64 price, bool byOffer);
    event FeeSet(uint16 feeBps);
    event TreasurySet(address treasury);

    constructor(
        IConfidentialERC721 boxes_,
        ICollectionHooks boxHooks_,
        IERC721 rats_,
        IERC7984 confidentialUsdc_,
        address treasury_,
        address owner_,
        uint16 feeBps_
    ) Ownable(owner_) {
        if (address(boxes_) == address(0) || address(rats_) == address(0) || address(confidentialUsdc_) == address(0)) {
            revert ZeroAddress();
        }
        boxes = boxes_;
        boxHooks = boxHooks_;
        rats = rats_;
        confidentialUsdc = confidentialUsdc_;
        _setTreasury(treasury_);
        _setFee(feeBps_);
    }

    // ---------------------------------------------------------------- listing

    /// @notice Puts `tokenId` up for `price` cUSDC (6 decimals). The market must be the caller's
    ///         operator on the boxes (`setOperator`) or approved on the rats. A rat is listed at
    ///         once; a box waits for `finalizeListing`.
    function list(Collection collection, uint256 tokenId, uint64 price) external nonReentrant returns (uint256 listingId) {
        _checkPrice(price);
        listingId = listingCount++;
        Listing storage l = _listings[listingId];
        l.collection = collection;
        l.seller = msg.sender;
        l.price = price;
        l.listedAt = uint64(block.timestamp);
        l.tokenId = tokenId;
        if (collection == Collection.Boxes) {
            if (address(boxHooks) != address(0)) l.snapshot = boxHooks.beforeList(address(boxes), tokenId, msg.sender, address(this));
            l.status = ListingStatus.Pending;
            // A "maybe": it never reverts on ownership. The proof of arrival settles the listing.
            ebool arrived = boxes.confidentialTransferFrom(msg.sender, address(this), tokenId);
            FHE.allowThis(arrived);
            FHE.makePubliclyDecryptable(arrived);
            l.arrived = arrived;
        } else {
            l.status = ListingStatus.Active;
            rats.transferFrom(msg.sender, address(this), tokenId);
        }
        emit Listed(listingId, collection, tokenId, msg.sender, price);
        if (collection == Collection.Rats) emit ListingSettled(listingId, true);
    }

    /// @notice Step 2 of a box listing. Anyone may submit the decrypted "arrived" bit with its
    ///         KMS proof (the relayer's `publicDecrypt` of `listingInfo(listingId).arrived`).
    function finalizeListing(uint256 listingId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof) external {
        Listing storage l = _listings[listingId];
        if (l.status != ListingStatus.Pending) revert ListingNotPending();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(l.arrived);
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);
        bool arrived = abi.decode(abiEncodedCleartexts, (bool));
        l.status = arrived ? ListingStatus.Active : ListingStatus.Refused;
        emit ListingSettled(listingId, arrived);
    }

    /// @notice Changes the asking price. Pending purchases at the old price are refunded.
    function reprice(uint256 listingId, uint64 price) external {
        Listing storage l = _activeListing(listingId);
        if (l.seller != msg.sender) revert NotSeller();
        _checkPrice(price);
        l.price = price;
        emit Repriced(listingId, price);
    }

    /// @notice Takes the item back. Open offers stay withdrawable by their buyers.
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage l = _activeListing(listingId);
        if (l.seller != msg.sender) revert NotSeller();
        l.status = ListingStatus.Cancelled;
        _deliver(l, msg.sender);
        emit ListingCancelled(listingId);
    }

    // ------------------------------------------------------------------- buy

    /// @notice Step 1 of a purchase at the asking price. Pulls the price in cUSDC (the market
    ///         must be the caller's cUSDC operator) and makes "paid" publicly decryptable.
    function buy(uint256 listingId) external nonReentrant returns (uint256 purchaseId) {
        Listing storage l = _activeListing(listingId);
        if (l.seller == msg.sender) revert OwnListing();
        _checkState(l);
        euint64 price = FHE.asEuint64(l.price);
        euint64 paid = _pull(msg.sender, price);
        ebool ok = FHE.eq(paid, price);
        FHE.allowThis(paid);
        FHE.allow(paid, msg.sender);
        FHE.allowThis(ok);
        FHE.makePubliclyDecryptable(ok);
        purchaseId = purchaseCount++;
        _purchases[purchaseId] = Purchase({
            listingId: listingId,
            buyer: msg.sender,
            status: PurchaseStatus.Pending,
            price: l.price,
            paid: paid,
            ok: ok
        });
        emit PurchaseRequested(purchaseId, listingId, msg.sender, l.price);
    }

    /// @notice Step 2 of a purchase. Anyone may submit the decrypted "paid" bit with its KMS
    ///         proof. Delivers the item if the buyer paid and the listing is still as bought;
    ///         refunds whatever arrived otherwise.
    function finalizePurchase(uint256 purchaseId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof) external nonReentrant {
        Purchase storage p = _purchases[purchaseId];
        if (p.status != PurchaseStatus.Pending) revert PurchaseNotPending();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(p.ok);
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);
        bool ok = abi.decode(abiEncodedCleartexts, (bool));

        Listing storage l = _listings[p.listingId];
        if (!ok) {
            p.status = PurchaseStatus.Unpaid;
            // Nothing arrived (all-or-nothing pull): nothing to send back.
        } else if (l.status == ListingStatus.Active && l.price == p.price && _stateUnchanged(l)) {
            p.status = PurchaseStatus.Done;
            l.status = ListingStatus.Sold;
            uint64 fee = uint64((uint256(p.price) * feeBps) / 10_000);
            if (fee > 0) _pay(treasury, FHE.asEuint64(fee));
            _pay(l.seller, FHE.asEuint64(p.price - fee));
            _deliver(l, p.buyer);
            emit Sold(p.listingId, l.seller, p.buyer, p.price, false);
        } else {
            p.status = PurchaseStatus.Missed;
            _pay(p.buyer, p.paid);
        }
        emit PurchaseSettled(purchaseId, p.status);
    }

    // ---------------------------------------------------------------- offers

    /// @notice Escrows a secret offer on an active listing: `amount` is encrypted by the caller
    ///         for this contract, capped at `MAX_PRICE`. Only the caller and the seller can read
    ///         what was escrowed (zero if the caller held less).
    function makeOffer(uint256 listingId, externalEuint64 amount, bytes calldata inputProof) external nonReentrant returns (uint256 offerId) {
        Listing storage l = _activeListing(listingId);
        if (l.seller == msg.sender) revert OwnListing();
        euint64 wanted = FHE.min(FHE.fromExternal(amount, inputProof), MAX_PRICE);
        euint64 escrowed = _pull(msg.sender, wanted);
        FHE.allowThis(escrowed);
        FHE.allow(escrowed, msg.sender);
        FHE.allow(escrowed, l.seller);
        offerId = offerCount++;
        _offers[offerId] = Offer({listingId: listingId, buyer: msg.sender, status: OfferStatus.Open, amount: escrowed});
        emit OfferMade(offerId, listingId, msg.sender);
    }

    /// @notice The buyer takes their offer back, whatever became of the listing.
    function withdrawOffer(uint256 offerId) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.status != OfferStatus.Open) revert OfferNotOpen();
        if (o.buyer != msg.sender) revert NotBuyer();
        o.status = OfferStatus.Withdrawn;
        _pay(msg.sender, o.amount);
        emit OfferWithdrawn(offerId);
    }

    /// @notice The seller sells to `offerId` for its escrowed amount, which stays secret. The
    ///         seller should decrypt it first: the contract cannot tell them it is worth it.
    function acceptOffer(uint256 offerId) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.status != OfferStatus.Open) revert OfferNotOpen();
        Listing storage l = _activeListing(o.listingId);
        if (l.seller != msg.sender) revert NotSeller();
        _checkState(l);
        o.status = OfferStatus.Accepted;
        l.status = ListingStatus.Sold;
        euint64 amount = o.amount;
        if (feeBps > 0) {
            // amount <= MAX_PRICE, so amount * MAX_FEE_BPS fits in 64 bits.
            euint64 fee = FHE.div(FHE.mul(amount, uint64(feeBps)), 10_000);
            _pay(treasury, fee);
            amount = FHE.sub(amount, fee);
        }
        _pay(l.seller, amount);
        _deliver(l, o.buyer);
        emit OfferAccepted(offerId, o.listingId);
        emit Sold(o.listingId, l.seller, o.buyer, 0, true);
    }

    // ----------------------------------------------------------------- views

    function listingInfo(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    /// @notice Up to `count` listings from `from`, for pages that read the chain directly.
    function listings(uint256 from, uint256 count) external view returns (Listing[] memory page) {
        uint256 end = from + count > listingCount ? listingCount : from + count;
        if (from >= end) return page;
        page = new Listing[](end - from);
        for (uint256 i = from; i < end; i++) page[i - from] = _listings[i];
    }

    function purchaseInfo(uint256 purchaseId) external view returns (Purchase memory) {
        return _purchases[purchaseId];
    }

    function offerInfo(uint256 offerId) external view returns (Offer memory) {
        return _offers[offerId];
    }

    // ----------------------------------------------------------------- admin

    function setFee(uint16 feeBps_) external onlyOwner {
        _setFee(feeBps_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    // -------------------------------------------------------------- internal

    function _activeListing(uint256 listingId) private view returns (Listing storage l) {
        l = _listings[listingId];
        if (l.status != ListingStatus.Active) revert ListingNotActive();
    }

    function _checkPrice(uint64 price) private pure {
        if (price == 0 || price > MAX_PRICE) revert BadPrice();
    }

    function _checkState(Listing storage l) private view {
        if (!_stateUnchanged(l)) revert StateChanged();
    }

    /// @dev Never reverts, so a purchase can always be settled or refunded.
    function _stateUnchanged(Listing storage l) private view returns (bool) {
        if (l.collection != Collection.Boxes || address(boxHooks) == address(0)) return true;
        try boxHooks.beforeSettle(address(boxes), l.tokenId, l.seller, address(0), l.snapshot) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Hands the escrowed item to `to`. The market surely holds it.
    function _deliver(Listing storage l, address to) private {
        if (l.collection == Collection.Boxes) boxes.confidentialTransfer(to, l.tokenId);
        else rats.transferFrom(address(this), to, l.tokenId);
    }

    /// @dev All of `amount` from `from`, or zero if they hold less. Returns what arrived.
    function _pull(address from, euint64 amount) private returns (euint64) {
        FHE.allowTransient(amount, address(confidentialUsdc));
        return confidentialUsdc.confidentialTransferFrom(from, address(this), amount);
    }

    function _pay(address to, euint64 amount) private {
        FHE.allowTransient(amount, address(confidentialUsdc));
        confidentialUsdc.confidentialTransfer(to, amount);
    }

    function _setFee(uint16 feeBps_) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }
}
