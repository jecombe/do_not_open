// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint64, euint256, externalEbool, externalEuint64, externalEuint256} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ConfidentialERC721} from "./confidential/ConfidentialERC721.sol";
import {ISeaport} from "./vault/ISeaport.sol";
import {IDelegateRegistry} from "./vault/IDelegateRegistry.sol";
import {VaultListings} from "./vault/VaultListings.sol";
import {VaultOffers} from "./vault/VaultOffers.sol";
import {IWETH} from "./vault/IWETH.sol";

/// @title The sealed vault
/// @notice Any NFT of an allowed collection, put in a box whose owner is encrypted. The box
///         moves like any confidential ERC-721; the NFT stays in the vault until its holder takes
///         it out, sells it on Seaport (OpenSea's protocol) with the vault as the seller, by a
///         listing or by accepting a buyer's offer, or sells the box privately for an encrypted
///         cUSDC price. Meanwhile its holder may lend the NFT's rights (airdrops, token gates) to
///         a wallet of theirs through delegate.xyz.
///
/// @dev Design notes.
///
///  1. Each box has an encrypted owner (the address that receives it) and an encrypted key: a
///     256-bit secret its holder picks. Everything that leaves the vault (taking the NFT out,
///     listing it, taking the listing down, collecting a sale's ETH) is asked with the key, not
///     with the caller's address (so are accepting an offer and delegating): `request` compares the
///     key it is given with the box's under encryption and makes only that bit public, so any
///     wallet can send the request (a relayer, or a fresh wallet with no history) and the holder's
///     address never shows. A wrong key is not a revert: the request settles `Refused`, as any
///     FHEVM ownership check here does.
///
///     The key is never sent as is: the holder encrypts key XOR `requestHash(...)`, the hash of the
///     request's own terms (box, action, recipient, price, end time, an offer's order hash) and of
///     the box's request nonce. A relayer that changed a term, or replayed the input later, would
///     make the vault compare against another hash, and the key would not match.
///
///  2. A box that changes hands gets a new random key nobody knows: the previous holder can no
///     longer act on it. The new holder sets theirs with `setKey`, a "maybe" like a transfer (only
///     the holder's call takes effect), or as part of a private sale.
///
///  3. Requests do not lock each other out: a box takes any number of them at once, each decided on
///     its own when its proof comes back (`finalize`, which anyone may send), and one that can no
///     longer run (the box changed first) settles `Stale`. So a stranger's requests with a wrong
///     key cannot keep the holder from taking the NFT out, listing it or collecting. While any
///     request waits, the box cannot move: a request decided for one holder never runs for the
///     next. The nonce a key is bound to moves on only when a key matched, so a wrong key spoils
///     nothing the holder prepared. A request whose proof never comes can be expired by anyone
///     after `REQUEST_TIMEOUT`, so no box waits forever.
///
///  4. Seaport: listing validates a Seaport order whose offerer is the vault itself (an offerer's
///     own orders need no signature) for the NFT against `price` wei, the vault's share first and
///     then the fees OpenSea's buyers pay (OpenSea's, the creator's). `listings` writes the order
///     the way OpenSea shows a contract's listing (its conduit and signed zone on mainnet) and
///     keeps it; the vault sends it to Seaport and approves the conduit for that one token only.
///     When the order fills, `sync` (or any request on the box) marks the box sold and holds the
///     ETH, less the fee, for whoever holds the key. The vault never signs anything and implements
///     no ERC-1271, so the only orders Seaport can fill on its NFTs are the ones it validated.
///
///  5. Accepting an offer: a buyer's Seaport order that pays WETH for the box's NFT (that token, or
///     any of its collection) is filled by the vault itself, with the call `VaultOffers` writes
///     for it (`fillCall`), as OpenSea's signed zone wants the NFT's holder to be Seaport's caller.
///     `VaultOffers.inspect` lets through only an order that pays WETH and asks for that one NFT
///     (and its WETH fees), and the vault approves Seaport for that token alone, so an order can
///     never take another box's NFT. The request binds the order's hash and the least WETH it must
///     net after the order's own fees; the order itself comes with `finalizeOffer`. The WETH is
///     unwrapped and goes, less the fee, straight to the request's address. A dead order (cancelled, filled, ended, or worth
///     less than asked) settles `Stale`; one that only fails to fill reverts and stays pending, so
///     a stranger cannot spoil it by finalizing it with bad data.
///
///  6. Delegation: the vault, the NFT's owner, names one wallet per box in delegate.xyz's registry,
///     which airdrops and token gates read: that wallet acts for the NFT without holding it. The
///     delegate is public, so a fresh wallet keeps the holder unlinked. A box keeps its delegate
///     when it changes hands (whether it moved is secret); its new holder sets their own. Taking
///     the NFT out or selling it clears it.
///
///  7. Private sale: the holder names a buyer and an encrypted cUSDC price only the two of them can
///     read. `acceptSale` pulls the price from the buyer (all or nothing), moves the box if the
///     payment arrived and the seller still holds it, and pays the seller, or refunds the buyer,
///     under encryption. Nothing decides it in the clear: to everyone else a sale that happened and
///     one that did not look the same.
///
///  8. A deposit may send the new box on at once, in the same transaction, to up to
///     `MAX_DEPOSIT_SENDS` addresses, each transfer real or not under encryption (decoys go to
///     fresh random addresses): the deposit names the depositor, but no longer who holds the box.
///
///  9. What is public: each deposit (who put which NFT in), the NFT behind each box, Seaport
///     listings and their prices, accepted offers (Seaport is public), the address a withdrawal or
///     a sale's ETH is sent to, a box's delegate, and who called what. Never public: who holds a
///     box, the key, a private sale's price, and whether a private sale or a plain transfer moved
///     anything.
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
        Claim,
        AcceptOffer,
        Delegate
    }

    enum RequestStatus {
        None,
        Pending,
        Done,
        /// The key was wrong. Nothing happened.
        Refused,
        /// The key was right, but the box changed first (its listing filled or expired, say).
        Stale,
        /// Its proof never came: nothing happened, and the box no longer waits on it.
        Expired
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
        /// How many requests wait for their proof. The box cannot move while any does.
        uint256 pending;
        /// ETH a Seaport sale left for the box's key holder, the fee taken.
        uint256 proceeds;
        /// How many requests on the box matched its key: part of what each request's key is
        ///      bound to. A wrong key does not move it on.
        uint64 nonce;
        /// Who may act for the NFT in delegate.xyz's registry, or 0.
        address delegate;
    }

    struct Listing {
        uint256 boxId;
        /// What the buyer pays, fees included.
        uint256 price;
        /// What comes to the vault when it fills: the price less OpenSea's and the creator's fees.
        uint256 net;
        uint64 endTime;
        /// Its order on Seaport: `listings.orderOf(orderHash)`.
        bytes32 orderHash;
    }

    struct Request {
        uint256 boxId;
        Action action;
        RequestStatus status;
        /// Withdraw, Claim and AcceptOffer: where the NFT or the ETH goes. Delegate: the delegate,
        ///      or 0 to clear it.
        address to;
        /// List: the price. AcceptOffer: the least WETH the vault must net.
        uint256 price;
        uint64 endTime;
        /// When it was placed: after `REQUEST_TIMEOUT` without a proof, anyone may expire it.
        uint64 placedAt;
        /// AcceptOffer: the Seaport order hash of the offer.
        bytes32 ref;
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
    /// @notice How long a request may wait for its proof before anyone may expire it.
    uint64 public constant REQUEST_TIMEOUT = 1 days;
    /// @notice The most transfers a deposit may send the new box on, decoys included.
    uint256 public constant MAX_DEPOSIT_SENDS = 5;

    ISeaport public immutable seaport;
    /// @notice Writes the listings' Seaport orders, the way OpenSea shows them, and keeps them.
    VaultListings public immutable listings;
    IERC7984 public immutable confidentialUsdc;
    /// @notice Writes the Seaport call that fills an offer the vault accepts, and is the offer board.
    VaultOffers public immutable offers;
    /// @notice What offers pay in: unwrapped here when one fills.
    IWETH public immutable weth;
    /// @notice delegate.xyz's Delegate Registry v2.
    IDelegateRegistry public immutable delegateRegistry;

    address public treasury;
    uint16 public feeBps;
    /// @notice ETH fees from Seaport sales, not yet sent to the treasury.
    uint256 public feesOwed;

    uint256 public requestCount;
    uint256 public listingCount;
    uint256 public saleCount;

    /// @notice Collections the owner shut out of the vault; any other ERC-721 goes in.
    mapping(address collection => bool) public bannedCollection;
    /// @notice The box holding an NFT, + 1; 0 when the vault does not hold it.
    mapping(address collection => mapping(uint256 tokenId => uint256 boxIdPlusOne)) public boxOf;

    mapping(uint256 boxId => Box) private _boxes;
    mapping(uint256 boxId => euint256) private _keys;
    mapping(uint256 requestId => Request) private _requests;
    mapping(uint256 listingId => Listing) private _listings;
    mapping(uint256 saleId => Sale) private _sales;

    error ZeroAddress();
    error FeeTooHigh();
    error CollectionBanned(address collection);
    error NotReceived();
    error NotABox(uint256 boxId);
    error BoxBusy(uint256 boxId);
    error WrongState(uint256 boxId, BoxState state);
    error BadPrice();
    error BadEndTime();
    error SaleNotOpen();
    error NotSeller();
    error NotBuyer();
    error RequestNotPending();
    error TooEarly();
    error BadSends();
    error OnlySeaport();
    error SendFailed();
    error NeedsOrder();
    error NotAnOffer();
    error WrongOrder();
    error OfferShort();
    error SeaportRefused();

    event CollectionBanSet(address indexed collection, bool banned);
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
    /// @notice The vault filled a buyer's Seaport offer: `amount` WETH came in, its fees paid.
    event OfferAccepted(uint256 indexed boxId, bytes32 indexed orderHash, address indexed buyer, uint256 amount);
    /// @notice `delegate` acts for the box's NFT in delegate.xyz's registry (0: nobody).
    event Delegated(uint256 indexed boxId, address indexed delegate);
    /// @notice The price is deliberately absent: only the seller and the buyer can read it.
    event SaleOffered(uint256 indexed saleId, uint256 indexed boxId, address indexed seller, address buyer);
    event SaleCancelled(uint256 indexed saleId);
    /// @notice Whether the box moved is not in here: only the two sides can read `moved`.
    event SaleSettled(uint256 indexed saleId);
    event FeeSet(uint16 feeBps);
    event TreasurySet(address treasury);

    constructor(
        VaultListings listings_,
        IERC7984 confidentialUsdc_,
        VaultOffers offers_,
        IDelegateRegistry delegateRegistry_,
        address treasury_,
        address owner_,
        uint16 feeBps_
    ) ConfidentialERC721("DO NOT OPEN Vault", "SEALED") Ownable(owner_) {
        if (
            address(listings_) == address(0) || address(confidentialUsdc_) == address(0) || address(offers_) == address(0)
                || address(delegateRegistry_) == address(0)
        ) revert ZeroAddress();
        listings = listings_;
        seaport = listings_.seaport();
        confidentialUsdc = confidentialUsdc_;
        offers = offers_;
        weth = offers_.weth();
        delegateRegistry = delegateRegistry_;
        _setTreasury(treasury_);
        _setFee(feeBps_);
    }

    /// @dev Only Seaport pays the vault (the ETH of a filled listing), and WETH (an accepted
    ///      offer's, unwrapped).
    receive() external payable {
        if (msg.sender != address(seaport) && msg.sender != address(weth)) revert OnlySeaport();
    }

    // ---------------------------------------------------------------- deposit

    /// @notice Puts `tokenId` of `collection` in a new box held by the caller, with `key` (a
    ///         256-bit secret encrypted for this contract) as its key. The vault must be approved
    ///         on the NFT. The deposit itself is public; what happens to the box next is not.
    ///         The box is then sent to each of `to` in turn, for real only where `really` is true
    ///         (encrypted, with `key`, under `inputProof`): with decoys only, the caller keeps it,
    ///         and nobody else can tell. A box that moves gets a random key, as on any transfer.
    function deposit(
        address collection,
        uint256 tokenId,
        externalEuint256 key,
        address[] calldata to,
        externalEbool[] calldata really,
        bytes calldata inputProof
    ) external nonReentrant returns (uint256 boxId) {
        if (to.length != really.length || to.length > MAX_DEPOSIT_SENDS) revert BadSends();
        if (bannedCollection[collection]) revert CollectionBanned(collection);
        IERC721(collection).transferFrom(msg.sender, address(this), tokenId);
        // Any ERC-721 may come in: the one thing asked of it is that the NFT is really here now.
        if (IERC721(collection).ownerOf(tokenId) != address(this)) revert NotReceived();
        boxId = _mint(msg.sender, FHE.asEbool(true));
        _boxes[boxId] = Box({
            collection: collection,
            tokenId: tokenId,
            state: BoxState.Sealed,
            listing: 0,
            pending: 0,
            proceeds: 0,
            nonce: 0,
            delegate: address(0)
        });
        boxOf[collection][tokenId] = boxId + 1;
        euint256 k = FHE.fromExternal(key, inputProof);
        FHE.allowThis(k);
        _keys[boxId] = k;
        emit Deposited(boxId, collection, tokenId, msg.sender);
        for (uint256 i = 0; i < to.length; i++) {
            _transfer(msg.sender, to[i], boxId, FHE.fromExternal(really[i], inputProof));
        }
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
    ///         wallet sends this. `to` is where a withdrawal or a sale's ETH goes, or the delegate;
    ///         `price` (wei) and `endTime` are for a listing. To accept an offer, `ref` is its
    ///         Seaport order hash and `price` the least WETH the vault must net from it. Reverts
    ///         only on what is public: the box's state, a bad price or date. Other requests
    ///         waiting on the box do not stop it.
    function request(
        uint256 boxId,
        Action action,
        address to,
        uint256 price,
        uint64 endTime,
        bytes32 ref,
        externalEuint256 boundKey,
        bytes calldata inputProof
    ) external returns (uint256 requestId) {
        Box storage b = _box(boxId);
        _sync(boxId);
        _checkAction(boxId, b, action, to, price, endTime, ref);
        requestId = requestCount++;
        Request storage r = _requests[requestId];
        r.boxId = boxId;
        r.action = action;
        r.status = RequestStatus.Pending;
        r.to = to;
        r.price = price;
        r.endTime = endTime;
        r.placedAt = uint64(block.timestamp);
        r.ref = ref;
        r.ok = _keyMatches(r, b.nonce, boundKey, inputProof);
        b.pending++;
        emit RequestPlaced(requestId, boxId, action, msg.sender);
    }

    /// @notice Step 2. Anyone may submit the decrypted "key matched" bit with its KMS proof (the
    ///         relayer's `publicDecrypt` of `requestInfo(requestId).ok`). Never reverts on the
    ///         box's state: a request that can no longer run settles `Stale`. An offer whose key
    ///         matched needs its order: `finalizeOffer`.
    function finalize(uint256 requestId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof)
        external
        nonReentrant
    {
        (Request storage r, bool ok, bool runnable) = _open(requestId, abiEncodedCleartexts, decryptionProof);
        if (runnable && r.action == Action.AcceptOffer) revert NeedsOrder();
        _close(requestId, r, ok, runnable && _run(r));
    }

    /// @notice Step 2 of accepting an offer: `finalize`, with `offer` =
    ///         abi.encode(AdvancedOrder, bytes32[] criteriaProof): the buyer's order as Seaport
    ///         takes it (`numerator` and `denominator` are set by `VaultOffers`: one token's share)
    ///         and, for an offer on some of a collection's tokens, the proof that the box's is one
    ///         of them. Anyone may send it, as the order is public. Reverts if the order is not
    ///         the one the request named, or if Seaport will not fill it now (the request then waits:
    ///         another try, or `expire`); settles `Stale` if the order is dead or worth less
    ///         than asked.
    function finalizeOffer(
        uint256 requestId,
        bytes calldata abiEncodedCleartexts,
        bytes calldata decryptionProof,
        bytes calldata offer
    ) external nonReentrant {
        (Request storage r, bool ok, bool runnable) = _open(requestId, abiEncodedCleartexts, decryptionProof);
        if (r.action != Action.AcceptOffer) revert NotAnOffer();
        _close(requestId, r, ok, runnable && _acceptOffer(r, offer));
    }

    /// @notice Settles a request whose proof did not come within `REQUEST_TIMEOUT`: nothing
    ///         happens, and the box no longer waits on it. Anyone may. The nonce moves on, so
    ///         an input bound to it cannot be sent again later.
    function expire(uint256 requestId) external {
        Request storage r = _requests[requestId];
        if (r.status != RequestStatus.Pending) revert RequestNotPending();
        if (block.timestamp <= r.placedAt + REQUEST_TIMEOUT) revert TooEarly();
        Box storage b = _boxes[r.boxId];
        b.pending--;
        b.nonce++;
        r.status = RequestStatus.Expired;
        emit RequestSettled(requestId, RequestStatus.Expired);
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
    ///         box's `nonce` when the request is placed: it moves on only when a key matches (or
    ///         a request expires).
    function requestHash(uint256 boxId, uint64 nonce, Action action, address to, uint256 price, uint64 endTime, bytes32 ref)
        public
        view
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(block.chainid, address(this), boxId, nonce, action, to, price, endTime, ref)));
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

    /// @notice Shuts a collection out of the vault (no new deposits; its boxes still come out), or lets it back in.
    function banCollection(address collection, bool banned) external onlyOwner {
        if (collection == address(0)) revert ZeroAddress();
        bannedCollection[collection] = banned;
        emit CollectionBanSet(collection, banned);
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

    /// @dev Boxes move only while sealed and not waiting on any request, and lose their key when
    ///      they do: the previous holder's key must not open them.
    function _transfer(address from, address to, uint256 tokenId, ebool really) internal override returns (ebool moved) {
        Box storage b = _box(tokenId);
        if (b.state != BoxState.Sealed) revert WrongState(tokenId, b.state);
        if (b.pending != 0) revert BoxBusy(tokenId);
        moved = super._transfer(from, to, tokenId, really);
        euint256 k = FHE.select(moved, FHE.randEuint256(), _keys[tokenId]);
        FHE.allowThis(k);
        _keys[tokenId] = k;
    }

    function _box(uint256 boxId) private view returns (Box storage b) {
        b = _boxes[boxId];
        if (b.state == BoxState.None) revert NotABox(boxId);
    }

    function _checkAction(uint256 boxId, Box storage b, Action action, address to, uint256 price, uint64 endTime, bytes32 ref)
        private
        view
    {
        if (action != Action.Delegate && action != Action.List && action != Action.Unlist && to == address(0)) {
            revert ZeroAddress();
        }
        if (action == Action.List) {
            if (price == 0) revert BadPrice();
            if (endTime <= block.timestamp || endTime > block.timestamp + MAX_LISTING_TIME) revert BadEndTime();
        }
        if (action == Action.AcceptOffer && (price == 0 || ref == 0)) revert BadPrice();
        if (!_stateAllows(b.state, action)) revert WrongState(boxId, b.state);
    }

    function _canRun(Box storage b, Request storage r) private view returns (bool) {
        if (r.action == Action.List && r.endTime <= block.timestamp) return false;
        return _stateAllows(b.state, r.action);
    }

    function _stateAllows(BoxState state, Action action) private pure returns (bool) {
        if (action == Action.List) return state == BoxState.Sealed;
        if (action == Action.Unlist) return state == BoxState.Listed;
        if (action == Action.Claim) return state == BoxState.Sold;
        // Withdraw, AcceptOffer, Delegate: the NFT is in the vault.
        return state == BoxState.Sealed || state == BoxState.Listed;
    }

    /// @dev key == the box's key, where the holder sent key XOR the request's terms; public.
    function _keyMatches(Request storage r, uint64 nonce, externalEuint256 boundKey, bytes calldata inputProof)
        private
        returns (ebool ok)
    {
        uint256 terms = requestHash(r.boxId, nonce, r.action, r.to, r.price, r.endTime, r.ref);
        ok = FHE.eq(FHE.xor(FHE.fromExternal(boundKey, inputProof), terms), _keys[r.boxId]);
        FHE.allowThis(ok);
        FHE.makePubliclyDecryptable(ok);
    }

    /// @dev Checks the proof of a request's "key matched" bit and brings its box up to date.
    ///      `runnable`: the key matched and the box can still do what was asked.
    function _open(uint256 requestId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof)
        private
        returns (Request storage r, bool ok, bool runnable)
    {
        r = _requests[requestId];
        if (r.status != RequestStatus.Pending) revert RequestNotPending();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(r.ok);
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);
        ok = abi.decode(abiEncodedCleartexts, (bool));
        _sync(r.boxId);
        runnable = ok && _canRun(_boxes[r.boxId], r);
    }

    /// @dev The request stops holding its box only here, after it ran: while it runs (Seaport may
    ///      call an order's zone), the box cannot move.
    function _close(uint256 requestId, Request storage r, bool ok, bool done) private {
        Box storage b = _boxes[r.boxId];
        b.pending--;
        r.status = !ok ? RequestStatus.Refused : done ? RequestStatus.Done : RequestStatus.Stale;
        // The key matched: an input bound to this nonce must not work twice.
        if (ok) b.nonce++;
        emit RequestSettled(requestId, r.status);
    }

    /// @dev Returns false if the action could not go through after all (the ETH would not send).
    function _run(Request storage r) private returns (bool) {
        uint256 boxId = r.boxId;
        Box storage b = _boxes[boxId];
        if (r.action == Action.Withdraw) {
            if (b.state == BoxState.Listed) _unlist(boxId, b);
            _delegate(boxId, b, address(0));
            b.state = BoxState.Withdrawn;
            delete boxOf[b.collection][b.tokenId];
            IERC721(b.collection).transferFrom(address(this), r.to, b.tokenId);
            emit Withdrawn(boxId, r.to);
        } else if (r.action == Action.List) {
            _list(boxId, b, r.price, r.endTime);
        } else if (r.action == Action.Unlist) {
            _unlist(boxId, b);
        } else if (r.action == Action.Delegate) {
            _delegate(boxId, b, r.to);
        } else {
            return _claim(boxId, b, r.to);
        }
        return true;
    }

    /// @dev Sends a sold box's ETH to `to`; on failure it stays, for a later `Claim`.
    function _claim(uint256 boxId, Box storage b, address to) private returns (bool) {
        uint256 amount = b.proceeds;
        b.proceeds = 0;
        b.state = BoxState.Claimed;
        (bool sent,) = to.call{value: amount}("");
        if (!sent) {
            b.proceeds = amount;
            b.state = BoxState.Sold;
            return false;
        }
        emit Claimed(boxId, to, amount);
        return true;
    }

    /// @dev Fills the buyer's order with the box's NFT: the vault sends Seaport the call `offers`
    ///      writes, approving Seaport for that token and the order's WETH fees alone, and unwraps
    ///      what came. Returns false (the request settles `Stale`) when the order can never fill
    ///      as asked; reverts when it only cannot fill now.
    function _acceptOffer(Request storage r, bytes calldata offer) private returns (bool) {
        uint256 boxId = r.boxId;
        Box storage b = _boxes[boxId];
        (bytes32 orderHash, address buyer, bool fillable) = offers.inspect(offer, b.collection, b.tokenId, r.price);
        if (orderHash != r.ref) revert WrongOrder();
        if (!fillable) return false;

        if (b.state == BoxState.Listed) _unlist(boxId, b);
        uint256 amount = _fillOffer(b, offer);
        if (amount < r.price) revert OfferShort();

        uint256 fee = (amount * feeBps) / 10_000;
        feesOwed += fee;
        b.proceeds = amount - fee;
        b.state = BoxState.Sold;
        delete boxOf[b.collection][b.tokenId];
        _delegate(boxId, b, address(0));
        emit OfferAccepted(boxId, orderHash, buyer, amount);
        // If the ETH will not go to `to`, it waits in the box for a `Claim`.
        _claim(boxId, b, r.to);
        return true;
    }

    /// @dev Sends Seaport the fill `offers` writes, approving it for the box's NFT and the order's
    ///      WETH fees alone, and unwraps the WETH held (the buyer's; the vault keeps none
    ///      otherwise, and any sent to it only adds to this payout). Reverts if the NFT stays.
    function _fillOffer(Box storage b, bytes calldata offer) private returns (uint256 amount) {
        (bytes memory call, uint256 orderFee) = offers.fillCall(offer, b.collection, b.tokenId, address(this));
        IERC721(b.collection).approve(address(seaport), b.tokenId);
        weth.approve(address(seaport), orderFee);
        _seaport(call);
        weth.approve(address(seaport), 0);
        if (IERC721(b.collection).ownerOf(b.tokenId) == address(this)) revert SeaportRefused();
        amount = weth.balanceOf(address(this));
        weth.withdraw(amount);
    }

    /// @dev Names `to` (0: nobody) as the one wallet acting for the box's NFT in delegate.xyz.
    function _delegate(uint256 boxId, Box storage b, address to) private {
        address old = b.delegate;
        if (old == to) return;
        if (old != address(0)) delegateRegistry.delegateERC721(old, b.collection, b.tokenId, bytes32(0), false);
        if (to != address(0)) delegateRegistry.delegateERC721(to, b.collection, b.tokenId, bytes32(0), true);
        b.delegate = to;
        emit Delegated(boxId, to);
    }

    function _list(uint256 boxId, Box storage b, uint256 price, uint64 endTime) private {
        (bytes memory validateCall, bytes32 orderHash, uint256 net) = listings.prepare(b.collection, b.tokenId, price, endTime);
        IERC721(b.collection).approve(listings.operator(), b.tokenId);
        _seaport(validateCall);
        uint256 listingId = listingCount++;
        _listings[listingId] = Listing({boxId: boxId, price: price, net: net, endTime: endTime, orderHash: orderHash});
        b.state = BoxState.Listed;
        b.listing = listingId + 1;
        emit Listed(listingId, boxId, price, endTime, orderHash);
    }

    function _unlist(uint256 boxId, Box storage b) private {
        uint256 listingId = b.listing - 1;
        _seaport(listings.cancelCall(_listings[listingId].orderHash));
        IERC721(b.collection).approve(address(0), b.tokenId);
        b.state = BoxState.Sealed;
        b.listing = 0;
        emit Unlisted(listingId, boxId);
    }

    /// @dev Sends Seaport a call `listings` wrote: the vault's own `validate` or `cancel`.
    function _seaport(bytes memory call) private {
        (bool ok,) = address(seaport).call(call);
        if (!ok) revert SeaportRefused();
    }

    /// @dev A listed box whose order filled is sold; one whose order ran out is sealed again.
    function _sync(uint256 boxId) private {
        Box storage b = _boxes[boxId];
        if (b.state != BoxState.Listed) return;
        uint256 listingId = b.listing - 1;
        Listing storage l = _listings[listingId];
        (,, uint256 filled, uint256 size) = seaport.getOrderStatus(l.orderHash);
        if (size != 0 && filled == size) {
            uint256 fee = (l.net * feeBps) / 10_000;
            feesOwed += fee;
            b.proceeds = l.net - fee;
            b.state = BoxState.Sold;
            delete boxOf[b.collection][b.tokenId];
            _delegate(boxId, b, address(0));
            emit SoldOnSeaport(listingId, boxId, l.price);
        } else if (block.timestamp > l.endTime) {
            IERC721(b.collection).approve(address(0), b.tokenId);
            b.state = BoxState.Sealed;
            b.listing = 0;
            emit ListingExpired(listingId, boxId);
        }
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
