// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint64, euint256, externalEuint64, externalEuint256} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ConfidentialERC721} from "./confidential/ConfidentialERC721.sol";
import {
    ConsiderationItem,
    ISeaport,
    ItemType,
    OfferItem,
    Order,
    OrderComponents,
    OrderParameters,
    OrderType
} from "./vault/ISeaport.sol";

/// @title The sealed vault
/// @notice Any NFT of an allowed collection, put in a box whose owner is encrypted. The box
///         moves like any confidential ERC-721; the NFT stays in the vault until its holder takes
///         it out, sells it on Seaport (OpenSea's protocol) with the vault as the seller, or sells
///         the box privately for an encrypted cUSDC price.
///
/// @dev Design notes.
///
///  1. Each box has an encrypted owner (the address that receives it) and an encrypted key: a
///     256-bit secret its holder picks. Everything that leaves the vault (taking the NFT out,
///     listing it, taking the listing down, collecting a sale's ETH) is asked with the key, not
///     with the caller's address: `request` compares the key it is given with the box's under
///     encryption and makes only that bit public, so any wallet can send the request (a relayer,
///     or a fresh wallet with no history) and the holder's address never shows. A wrong key is
///     not a revert: the request settles `Refused`, as any FHEVM ownership check here does.
///
///     The key is never sent as is: the holder encrypts key XOR `requestHash(...)`, the hash of
///     the request's own terms (box, action, recipient, price, end time) and of the box's
///     request nonce. A relayer that changed a term, or replayed the input later, would make the
///     vault compare against another hash, and the key would not match.
///
///  2. A box that changes hands gets a new random key nobody knows: the previous holder can no
///     longer act on it. The new holder sets theirs with `setKey`, a "maybe" like a transfer
///     (only the holder's call takes effect), or as part of a private sale.
///
///  3. One request per box at a time. While it waits for its public decryption, the box cannot
///     move, so a request decided for one holder never runs for the next. Anyone may finalize it
///     with the KMS proof (`finalize`), as with every reveal in this repo.
///
///  4. Seaport: listing validates a Seaport order whose offerer is the vault itself (an
///     offerer's own orders need no signature) for the NFT against `price` wei paid to the
///     vault. The vault approves Seaport for that one token only. When the order fills, `sync`
///     (or any request on the box) marks the box sold and holds the ETH, less the fee, for
///     whoever holds the key. The vault never signs anything and implements no ERC-1271, so the
///     only orders Seaport can fill on its NFTs are the ones the vault validated.
///
///  5. Private sale: the holder names a buyer and an encrypted cUSDC price only the two of them
///     can read. `acceptSale` pulls the price from the buyer (all or nothing), moves the box if
///     the payment arrived and the seller still holds it, and pays the seller, or refunds the
///     buyer, under encryption. Nothing decides it in the clear: to everyone else a sale that
///     happened and one that did not look the same.
///
///  6. What is public: each deposit (who put which NFT in), the NFT behind each box, Seaport
///     listings and their prices (Seaport is public), the address a withdrawal or a sale's ETH
///     is sent to, and who called what. Never public: who holds a box, the key, a private sale's
///     price, and whether a private sale or a plain transfer moved anything.
contract SealedVault is ConfidentialERC721, ZamaEthereumConfig, Ownable, ReentrancyGuard {
    enum BoxState {
        None,
        /// In the vault, free to move.
        Sealed,
        /// Offered on Seaport. Cannot move until it is taken down, sold or expired.
        Listed,
        /// Sold on Seaport: the NFT is gone, the ETH waits for the key's holder.
        Sold,
        /// The NFT was taken out.
        Withdrawn,
        /// Sold, and the ETH collected.
        Claimed
    }

    enum Action {
        Withdraw,
        List,
        Unlist,
        Claim
    }

    enum RequestStatus {
        None,
        Pending,
        Done,
        /// The key was wrong. Nothing happened.
        Refused,
        /// The key was right, but the box changed first (its listing filled or expired, say).
        Stale
    }

    enum SaleStatus {
        None,
        Open,
        /// The buyer accepted. Whether the box moved is encrypted (`moved`).
        Settled,
        Cancelled
    }

    struct Box {
        address collection;
        uint256 tokenId;
        BoxState state;
        /// The listing id + 1 while listed or sold, 0 otherwise.
        uint256 listing;
        /// The pending request's id + 1, 0 when none.
        uint256 busy;
        /// ETH a Seaport sale left for the box's key holder, the fee taken.
        uint256 proceeds;
        /// How many requests the box has had: part of what each request's key is bound to.
        uint64 nonce;
    }

    struct Listing {
        uint256 boxId;
        uint256 price;
        uint64 startTime;
        uint64 endTime;
        uint256 counter;
        bytes32 orderHash;
    }

    struct Request {
        uint256 boxId;
        Action action;
        RequestStatus status;
        /// Withdraw and Claim: where the NFT or the ETH goes.
        address to;
        /// List only.
        uint256 price;
        uint64 endTime;
        /// key == the box's key, publicly decryptable.
        ebool ok;
    }

    struct Sale {
        uint256 boxId;
        address seller;
        address buyer;
        SaleStatus status;
        /// cUSDC, readable by the seller and the buyer only.
        euint64 price;
        /// Whether the box moved: the seller and the buyer can read it once settled.
        ebool moved;
    }

    /// @notice One million USDC: the most a private sale can ask.
    uint64 public constant MAX_SALE_PRICE = 1_000_000_000_000;
    /// @notice The fee can never exceed 10%.
    uint16 public constant MAX_FEE_BPS = 1_000;
    /// @notice The longest a Seaport listing may run.
    uint64 public constant MAX_LISTING_TIME = 180 days;

    ISeaport public immutable seaport;
    IERC7984 public immutable confidentialUsdc;

    address public treasury;
    uint16 public feeBps;
    /// @notice ETH fees from Seaport sales, not yet sent to the treasury.
    uint256 public feesOwed;

    uint256 public requestCount;
    uint256 public listingCount;
    uint256 public saleCount;

    mapping(address collection => bool) public allowedCollection;
    /// @notice The box holding an NFT, + 1; 0 when the vault does not hold it.
    mapping(address collection => mapping(uint256 tokenId => uint256 boxIdPlusOne)) public boxOf;

    mapping(uint256 boxId => Box) private _boxes;
    mapping(uint256 boxId => euint256) private _keys;
    mapping(uint256 requestId => Request) private _requests;
    mapping(uint256 listingId => Listing) private _listings;
    mapping(uint256 saleId => Sale) private _sales;

    error ZeroAddress();
    error FeeTooHigh();
    error CollectionNotAllowed(address collection);
    error NotABox(uint256 boxId);
    error BoxBusy(uint256 boxId);
    error WrongState(uint256 boxId, BoxState state);
    error BadPrice();
    error BadEndTime();
    error SaleNotOpen();
    error NotSeller();
    error NotBuyer();
    error RequestNotPending();
    error OnlySeaport();
    error SendFailed();

    event CollectionSet(address indexed collection, bool allowed);
    event Deposited(uint256 indexed boxId, address indexed collection, uint256 indexed tokenId, address depositor);
    /// @notice `caller` may have changed the box's key: only its holder's call takes effect.
    event KeySet(uint256 indexed boxId, address indexed caller);
    event RequestPlaced(uint256 indexed requestId, uint256 indexed boxId, Action action, address caller);
    event RequestSettled(uint256 indexed requestId, RequestStatus status);
    event Withdrawn(uint256 indexed boxId, address indexed to);
    event Listed(uint256 indexed listingId, uint256 indexed boxId, uint256 price, uint64 endTime, bytes32 orderHash);
    event Unlisted(uint256 indexed listingId, uint256 indexed boxId);
    /// @notice The listing ran out without a buyer: the box is back to sealed.
    event ListingExpired(uint256 indexed listingId, uint256 indexed boxId);
    event SoldOnSeaport(uint256 indexed listingId, uint256 indexed boxId, uint256 price);
    event Claimed(uint256 indexed boxId, address indexed to, uint256 amount);
    /// @notice The price is deliberately absent: only the seller and the buyer can read it.
    event SaleOffered(uint256 indexed saleId, uint256 indexed boxId, address indexed seller, address buyer);
    event SaleCancelled(uint256 indexed saleId);
    /// @notice Whether the box moved is not in here: only the two sides can read `moved`.
    event SaleSettled(uint256 indexed saleId);
    event FeeSet(uint16 feeBps);
    event TreasurySet(address treasury);

    constructor(ISeaport seaport_, IERC7984 confidentialUsdc_, address treasury_, address owner_, uint16 feeBps_)
        ConfidentialERC721("DO NOT OPEN Vault", "SEALED")
        Ownable(owner_)
    {
        if (address(seaport_) == address(0) || address(confidentialUsdc_) == address(0)) revert ZeroAddress();
        seaport = seaport_;
        confidentialUsdc = confidentialUsdc_;
        _setTreasury(treasury_);
        _setFee(feeBps_);
    }

    /// @dev Only Seaport pays the vault: the ETH of a filled listing.
    receive() external payable {
        if (msg.sender != address(seaport)) revert OnlySeaport();
    }

    // ---------------------------------------------------------------- deposit

    /// @notice Puts `tokenId` of `collection` in a new box held by the caller, with `key` (a
    ///         256-bit secret encrypted for this contract) as its key. The vault must be approved
    ///         on the NFT. The deposit itself is public; what happens to the box next is not.
    function deposit(address collection, uint256 tokenId, externalEuint256 key, bytes calldata inputProof)
        external
        nonReentrant
        returns (uint256 boxId)
    {
        if (!allowedCollection[collection]) revert CollectionNotAllowed(collection);
        IERC721(collection).transferFrom(msg.sender, address(this), tokenId);
        boxId = _mint(msg.sender, FHE.asEbool(true));
        _boxes[boxId] = Box({collection: collection, tokenId: tokenId, state: BoxState.Sealed, listing: 0, busy: 0, proceeds: 0, nonce: 0});
        boxOf[collection][tokenId] = boxId + 1;
        euint256 k = FHE.fromExternal(key, inputProof);
        FHE.allowThis(k);
        _keys[boxId] = k;
        emit Deposited(boxId, collection, tokenId, msg.sender);
    }

    /// @notice Sets the box's key, if the caller holds it; does nothing otherwise, and looks the
    ///         same either way.
    function setKey(uint256 boxId, externalEuint256 key, bytes calldata inputProof) external {
        _box(boxId);
        ebool owns = _isOwner(boxId, msg.sender);
        euint256 k = FHE.select(owns, FHE.fromExternal(key, inputProof), _keys[boxId]);
        FHE.allowThis(k);
        _keys[boxId] = k;
        emit KeySet(boxId, msg.sender);
    }

    // --------------------------------------------------------------- requests

    /// @notice Step 1 of anything that leaves the vault. `boundKey` is the box's key XOR
    ///         `requestHash` of these same terms, encrypted for this contract and for whichever
    ///         wallet sends this. `to` is where a withdrawal or a sale's ETH goes;
    ///         `price` (wei) and `endTime` are for a listing. Reverts only on what is public: the
    ///         box's state, a pending request, a bad price or date.
    function request(
        uint256 boxId,
        Action action,
        address to,
        uint256 price,
        uint64 endTime,
        externalEuint256 boundKey,
        bytes calldata inputProof
    ) external returns (uint256 requestId) {
        Box storage b = _box(boxId);
        if (b.busy != 0) revert BoxBusy(boxId);
        _sync(boxId);
        _checkAction(boxId, b, action, to, price, endTime);
        uint256 terms = requestHash(boxId, b.nonce++, action, to, price, endTime);
        ebool ok = FHE.eq(FHE.xor(FHE.fromExternal(boundKey, inputProof), terms), _keys[boxId]);
        FHE.allowThis(ok);
        FHE.makePubliclyDecryptable(ok);
        requestId = requestCount++;
        _requests[requestId] = Request({
            boxId: boxId,
            action: action,
            status: RequestStatus.Pending,
            to: to,
            price: price,
            endTime: endTime,
            ok: ok
        });
        b.busy = requestId + 1;
        emit RequestPlaced(requestId, boxId, action, msg.sender);
    }

    /// @notice Step 2. Anyone may submit the decrypted "key matched" bit with its KMS proof (the
    ///         relayer's `publicDecrypt` of `requestInfo(requestId).ok`). Never reverts on the
    ///         box's state: a request that can no longer run settles `Stale`.
    function finalize(uint256 requestId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof)
        external
        nonReentrant
    {
        Request storage r = _requests[requestId];
        if (r.status != RequestStatus.Pending) revert RequestNotPending();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(r.ok);
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);
        bool ok = abi.decode(abiEncodedCleartexts, (bool));

        Box storage b = _boxes[r.boxId];
        b.busy = 0;
        _sync(r.boxId);
        if (!ok) {
            r.status = RequestStatus.Refused;
        } else if (!_canRun(b, r.action, r.to, r.price, r.endTime)) {
            r.status = RequestStatus.Stale;
        } else {
            r.status = _run(r) ? RequestStatus.Done : RequestStatus.Stale;
        }
        emit RequestSettled(requestId, r.status);
    }

    /// @notice Brings a listed box up to date with Seaport: sold if its order filled, back to
    ///         sealed if it ran out. Anyone may call it; requests do it on their own.
    function sync(uint256 boxId) external {
        _box(boxId);
        _sync(boxId);
    }

    // ----------------------------------------------------------- private sale

    /// @notice Offers the box to `buyer` for `price` cUSDC (6 decimals), encrypted for this
    ///         contract. Only the caller and `buyer` can read the price. Anyone may offer any box:
    ///         unless the caller holds it when the buyer accepts, nothing moves.
    function offerSale(uint256 boxId, address buyer, externalEuint64 price, bytes calldata inputProof)
        external
        returns (uint256 saleId)
    {
        Box storage b = _box(boxId);
        if (b.state != BoxState.Sealed) revert WrongState(boxId, b.state);
        if (buyer == address(0) || buyer == msg.sender) revert NotBuyer();
        euint64 p = FHE.min(FHE.fromExternal(price, inputProof), MAX_SALE_PRICE);
        FHE.allowThis(p);
        FHE.allow(p, msg.sender);
        FHE.allow(p, buyer);
        saleId = saleCount++;
        _sales[saleId] = Sale({boxId: boxId, seller: msg.sender, buyer: buyer, status: SaleStatus.Open, price: p, moved: ebool.wrap(0)});
        emit SaleOffered(saleId, boxId, msg.sender, buyer);
    }

    function cancelSale(uint256 saleId) external {
        Sale storage s = _sales[saleId];
        if (s.status != SaleStatus.Open) revert SaleNotOpen();
        if (s.seller != msg.sender) revert NotSeller();
        s.status = SaleStatus.Cancelled;
        emit SaleCancelled(saleId);
    }

    /// @notice The buyer takes the offer: the vault must be their cUSDC operator. `key` becomes
    ///         the box's key if it moves. The buyer should decrypt the price first.
    function acceptSale(uint256 saleId, externalEuint256 key, bytes calldata inputProof) external nonReentrant {
        Sale storage s = _sales[saleId];
        if (s.status != SaleStatus.Open) revert SaleNotOpen();
        if (s.buyer != msg.sender) revert NotBuyer();
        s.status = SaleStatus.Settled;
        uint256 boxId = s.boxId;

        euint64 price = s.price;
        FHE.allowTransient(price, address(confidentialUsdc));
        euint64 pulled = confidentialUsdc.confidentialTransferFrom(msg.sender, address(this), price);
        ebool paid = FHE.eq(pulled, price);
        // Moves only if the seller still holds the box and the price arrived; the box's key is
        // then the buyer's.
        ebool moved = _transfer(s.seller, msg.sender, boxId, paid);
        euint256 k = FHE.select(moved, FHE.fromExternal(key, inputProof), _keys[boxId]);
        FHE.allowThis(k);
        _keys[boxId] = k;

        euint64 zero = FHE.asEuint64(0);
        euint64 fee = zero;
        // pulled <= MAX_SALE_PRICE, so pulled * MAX_FEE_BPS fits in 64 bits.
        if (feeBps > 0) fee = FHE.div(FHE.mul(pulled, uint64(feeBps)), 10_000);
        _pay(s.seller, FHE.select(moved, FHE.sub(pulled, fee), zero));
        _pay(treasury, FHE.select(moved, fee, zero));
        _pay(msg.sender, FHE.select(moved, zero, pulled));

        FHE.allowThis(moved);
        FHE.allow(moved, s.seller);
        FHE.allow(moved, msg.sender);
        s.moved = moved;
        emit SaleSettled(saleId);
    }

    // ------------------------------------------------------------------ views

    /// @notice What a request's key is bound to: the holder sends key XOR this. `nonce` is the
    ///         box's `nonce` when the request is placed.
    function requestHash(uint256 boxId, uint64 nonce, Action action, address to, uint256 price, uint64 endTime)
        public
        view
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(block.chainid, address(this), boxId, nonce, action, to, price, endTime)));
    }

    function boxInfo(uint256 boxId) external view returns (Box memory) {
        return _boxes[boxId];
    }

    function requestInfo(uint256 requestId) external view returns (Request memory) {
        return _requests[requestId];
    }

    function listingInfo(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    function saleInfo(uint256 saleId) external view returns (Sale memory) {
        return _sales[saleId];
    }

    /// @notice The Seaport order of a listing, as a buyer passes it to `fulfillOrder` (with an
    ///         empty signature: the vault validated it).
    function seaportOrder(uint256 listingId) external view returns (OrderParameters memory) {
        Listing storage l = _listings[listingId];
        return _parameters(_components(_boxes[l.boxId], l, listingId));
    }

    /// @notice The NFT's own metadata: what is inside a box is public, only its holder is not.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireExists(tokenId);
        Box storage b = _boxes[tokenId];
        try IERC721Metadata(b.collection).tokenURI(b.tokenId) returns (string memory uri) {
            return uri;
        } catch {
            return "";
        }
    }

    // ------------------------------------------------------------------ admin

    function setCollection(address collection, bool allowed) external onlyOwner {
        if (collection == address(0)) revert ZeroAddress();
        allowedCollection[collection] = allowed;
        emit CollectionSet(collection, allowed);
    }

    function setFee(uint16 feeBps_) external onlyOwner {
        _setFee(feeBps_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    /// @notice Sends the Seaport fees collected so far to the treasury. Anyone may.
    function sendFees() external nonReentrant {
        uint256 amount = feesOwed;
        feesOwed = 0;
        (bool sent,) = treasury.call{value: amount}("");
        if (!sent) revert SendFailed();
    }

    // --------------------------------------------------------------- internal

    /// @dev Boxes move only while sealed and not waiting on a request, and lose their key when
    ///      they do: the previous holder's key must not open them.
    function _transfer(address from, address to, uint256 tokenId, ebool really) internal override returns (ebool moved) {
        Box storage b = _box(tokenId);
        if (b.state != BoxState.Sealed) revert WrongState(tokenId, b.state);
        if (b.busy != 0) revert BoxBusy(tokenId);
        moved = super._transfer(from, to, tokenId, really);
        euint256 k = FHE.select(moved, FHE.randEuint256(), _keys[tokenId]);
        FHE.allowThis(k);
        _keys[tokenId] = k;
    }

    function _box(uint256 boxId) private view returns (Box storage b) {
        b = _boxes[boxId];
        if (b.state == BoxState.None) revert NotABox(boxId);
    }

    function _checkAction(uint256 boxId, Box storage b, Action action, address to, uint256 price, uint64 endTime) private view {
        if ((action == Action.Withdraw || action == Action.Claim) && to == address(0)) revert ZeroAddress();
        if (action == Action.List) {
            if (price == 0) revert BadPrice();
            if (endTime <= block.timestamp || endTime > block.timestamp + MAX_LISTING_TIME) revert BadEndTime();
        }
        if (!_stateAllows(b.state, action)) revert WrongState(boxId, b.state);
    }

    function _canRun(Box storage b, Action action, address to, uint256 price, uint64 endTime) private view returns (bool) {
        if ((action == Action.Withdraw || action == Action.Claim) && to == address(0)) return false;
        if (action == Action.List && (price == 0 || endTime <= block.timestamp)) return false;
        return _stateAllows(b.state, action);
    }

    function _stateAllows(BoxState state, Action action) private pure returns (bool) {
        if (action == Action.Withdraw) return state == BoxState.Sealed || state == BoxState.Listed;
        if (action == Action.List) return state == BoxState.Sealed;
        if (action == Action.Unlist) return state == BoxState.Listed;
        return state == BoxState.Sold;
    }

    /// @dev Returns false if the action could not go through after all (the ETH would not send).
    function _run(Request storage r) private returns (bool) {
        uint256 boxId = r.boxId;
        Box storage b = _boxes[boxId];
        if (r.action == Action.Withdraw) {
            if (b.state == BoxState.Listed) _unlist(boxId, b);
            b.state = BoxState.Withdrawn;
            delete boxOf[b.collection][b.tokenId];
            IERC721(b.collection).transferFrom(address(this), r.to, b.tokenId);
            emit Withdrawn(boxId, r.to);
        } else if (r.action == Action.List) {
            _list(boxId, b, r.price, r.endTime);
        } else if (r.action == Action.Unlist) {
            _unlist(boxId, b);
        } else {
            uint256 amount = b.proceeds;
            b.proceeds = 0;
            b.state = BoxState.Claimed;
            (bool sent,) = r.to.call{value: amount}("");
            if (!sent) {
                b.proceeds = amount;
                b.state = BoxState.Sold;
                return false;
            }
            emit Claimed(boxId, r.to, amount);
        }
        return true;
    }

    function _list(uint256 boxId, Box storage b, uint256 price, uint64 endTime) private {
        uint256 listingId = listingCount++;
        Listing storage l = _listings[listingId];
        l.boxId = boxId;
        l.price = price;
        l.startTime = uint64(block.timestamp);
        l.endTime = endTime;
        l.counter = seaport.getCounter(address(this));
        OrderComponents memory c = _components(b, l, listingId);
        l.orderHash = seaport.getOrderHash(c);

        IERC721(b.collection).approve(address(seaport), b.tokenId);
        Order[] memory orders = new Order[](1);
        orders[0] = Order({parameters: _parameters(c), signature: ""});
        seaport.validate(orders);

        b.state = BoxState.Listed;
        b.listing = listingId + 1;
        emit Listed(listingId, boxId, price, endTime, l.orderHash);
    }

    function _unlist(uint256 boxId, Box storage b) private {
        uint256 listingId = b.listing - 1;
        OrderComponents[] memory orders = new OrderComponents[](1);
        orders[0] = _components(b, _listings[listingId], listingId);
        seaport.cancel(orders);
        IERC721(b.collection).approve(address(0), b.tokenId);
        b.state = BoxState.Sealed;
        b.listing = 0;
        emit Unlisted(listingId, boxId);
    }

    /// @dev A listed box whose order filled is sold; one whose order ran out is sealed again.
    function _sync(uint256 boxId) private {
        Box storage b = _boxes[boxId];
        if (b.state != BoxState.Listed) return;
        uint256 listingId = b.listing - 1;
        Listing storage l = _listings[listingId];
        (,, uint256 filled, uint256 size) = seaport.getOrderStatus(l.orderHash);
        if (size != 0 && filled == size) {
            uint256 fee = (l.price * feeBps) / 10_000;
            feesOwed += fee;
            b.proceeds = l.price - fee;
            b.state = BoxState.Sold;
            delete boxOf[b.collection][b.tokenId];
            emit SoldOnSeaport(listingId, boxId, l.price);
        } else if (block.timestamp > l.endTime) {
            IERC721(b.collection).approve(address(0), b.tokenId);
            b.state = BoxState.Sealed;
            b.listing = 0;
            emit ListingExpired(listingId, boxId);
        }
    }

    /// @dev One NFT against `price` wei paid to the vault, open to anyone, no conduit.
    function _components(Box storage b, Listing storage l, uint256 listingId) private view returns (OrderComponents memory c) {
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem({itemType: ItemType.ERC721, token: b.collection, identifierOrCriteria: b.tokenId, startAmount: 1, endAmount: 1});
        ConsiderationItem[] memory consideration = new ConsiderationItem[](1);
        consideration[0] = ConsiderationItem({
            itemType: ItemType.NATIVE,
            token: address(0),
            identifierOrCriteria: 0,
            startAmount: l.price,
            endAmount: l.price,
            recipient: payable(address(this))
        });
        c = OrderComponents({
            offerer: address(this),
            zone: address(0),
            offer: offer,
            consideration: consideration,
            orderType: OrderType.FULL_OPEN,
            startTime: l.startTime,
            endTime: l.endTime,
            zoneHash: bytes32(0),
            salt: uint256(keccak256(abi.encode(address(this), listingId))),
            conduitKey: bytes32(0),
            counter: l.counter
        });
    }

    function _parameters(OrderComponents memory c) private pure returns (OrderParameters memory) {
        return OrderParameters({
            offerer: c.offerer,
            zone: c.zone,
            offer: c.offer,
            consideration: c.consideration,
            orderType: c.orderType,
            startTime: c.startTime,
            endTime: c.endTime,
            zoneHash: c.zoneHash,
            salt: c.salt,
            conduitKey: c.conduitKey,
            totalOriginalConsiderationItems: c.consideration.length
        });
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
