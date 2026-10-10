// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {
    ConsiderationItem,
    ISeaport,
    ItemType,
    OfferItem,
    Order,
    OrderComponents,
    OrderParameters,
    OrderType
} from "./ISeaport.sol";

/// @title Builds the sealed vault's Seaport listings, the way OpenSea shows them
/// @notice The vault lists its NFTs itself (it is the offerer and validates its own orders, so it
///         never signs anything); this contract writes the order and keeps it, so the vault does
///         not have to. A listing is what OpenSea's own contracts-as-sellers use on mainnet (the
///         TokenWorks NFT strategies, read on 2026-10-10): Seaport 1.6, OpenSea's conduit,
///         OpenSea's signed zone (a restricted order), the seller's share first and then each fee
///         the collection's buyers pay on OpenSea, all in ETH. OpenSea reads the order from
///         Seaport's `OrderValidated` event: no API, no signature. Where OpenSea is not (Sepolia,
///         a local node), the zone and the conduit are left out and the order is an open one.
///
///         Stateless as to who calls: `prepare` writes an order whose offerer is its caller, for
///         its caller to send to Seaport; an order only ever exists on Seaport when its offerer
///         validated it. The owner sets the fees (OpenSea's and the creator's), capped at
///         `MAX_FEES_BPS`: the default ones, under collection 0, for every collection, and a
///         collection's own where OpenSea asks for more (a creator's enforced fee); a listing
///         keeps the fees it was made with.
contract VaultListings is Ownable {
    struct Fee {
        address payable recipient;
        uint16 bps;
    }

    /// @notice What a listing was made of: enough to write its order again.
    struct Listing {
        address offerer;
        address collection;
        uint256 tokenId;
        uint256 price;
        uint64 startTime;
        uint64 endTime;
        uint256 salt;
        uint256 counter;
        Fee[] fees;
    }

    /// @notice The fees on a listing can never add up to more than 15% of its price.
    uint16 public constant MAX_FEES_BPS = 1_500;

    ISeaport public immutable seaport;
    /// @notice OpenSea's signed zone, or 0 where OpenSea is not (the order is then open).
    address public immutable zone;
    /// @notice OpenSea's conduit key, or 0: Seaport then moves the NFT itself.
    bytes32 public immutable conduitKey;
    /// @notice What the offerer approves on the NFT: OpenSea's conduit, or Seaport.
    address public immutable operator;

    uint256 public listingCount;
    mapping(address collection => Fee[]) private _fees;
    mapping(bytes32 orderHash => Listing) private _listings;

    error TooManyFees();
    error ZeroAddress();

    event FeesSet(address indexed collection, Fee[] fees);
    event Prepared(bytes32 indexed orderHash, address indexed offerer, address indexed collection, uint256 tokenId, uint256 price);

    constructor(ISeaport seaport_, address zone_, bytes32 conduitKey_, address conduit_, address owner_) Ownable(owner_) {
        if (address(seaport_) == address(0)) revert ZeroAddress();
        seaport = seaport_;
        zone = zone_;
        conduitKey = conduitKey_;
        operator = conduitKey_ == bytes32(0) ? address(seaport_) : conduit_;
        if (operator == address(0)) revert ZeroAddress();
    }

    /// @notice Writes the caller's listing of `tokenId` of `collection` for `price` wei paid by the
    ///         buyer (fees included), from now to `endTime`. Returns the `validate` call the caller
    ///         sends to Seaport, the order's hash, and what the caller nets when it fills. The
    ///         caller approves `operator` on the NFT.
    function prepare(address collection, uint256 tokenId, uint256 price, uint64 endTime)
        external
        returns (bytes memory validateCall, bytes32 orderHash, uint256 net)
    {
        Fee[] storage fees = _feesOf(collection);
        uint256 salt = uint256(keccak256(abi.encode(address(this), listingCount++)));
        uint256 counter = seaport.getCounter(msg.sender);
        OrderComponents memory c = _components(msg.sender, collection, tokenId, price, uint64(block.timestamp), endTime, salt, counter, fees);
        orderHash = seaport.getOrderHash(c);
        Listing storage l = _listings[orderHash];
        if (l.offerer == address(0)) {
            (l.offerer, l.collection, l.tokenId, l.price) = (msg.sender, collection, tokenId, price);
            (l.startTime, l.endTime, l.salt, l.counter) = (uint64(block.timestamp), endTime, salt, counter);
            for (uint256 i; i < fees.length; ++i) l.fees.push(fees[i]);
        }
        net = c.consideration[0].startAmount;
        Order[] memory orders = new Order[](1);
        orders[0] = Order({parameters: _parameters(c), signature: ""});
        validateCall = abi.encodeCall(ISeaport.validate, (orders));
        emit Prepared(orderHash, msg.sender, collection, tokenId, price);
    }

    /// @notice The `cancel` call its offerer sends to Seaport to take a listing down.
    function cancelCall(bytes32 orderHash) external view returns (bytes memory) {
        OrderComponents[] memory orders = new OrderComponents[](1);
        orders[0] = _componentsOf(orderHash);
        return abi.encodeCall(ISeaport.cancel, (orders));
    }

    /// @notice A listing's order as a buyer passes it to Seaport (with an empty signature: its
    ///         offerer validated it; through OpenSea, with the zone's, where there is one).
    function orderOf(bytes32 orderHash) external view returns (OrderParameters memory) {
        return _parameters(_componentsOf(orderHash));
    }

    function listingOf(bytes32 orderHash) external view returns (Listing memory) {
        return _listings[orderHash];
    }

    /// @notice What a listing of `collection` pays on top of the seller's share: its own fees, or the default ones.
    function feesOf(address collection) external view returns (Fee[] memory) {
        return _feesOf(collection);
    }

    /// @notice Sets what buyers of `collection` pay on top of the seller's share, as OpenSea asks
    ///         (its own fee, the creator's when enforced); under collection 0, the default for
    ///         every collection without fees of its own. Listings already up keep theirs.
    function setFees(address collection, Fee[] calldata fees) external onlyOwner {
        Fee[] storage stored = _fees[collection];
        delete _fees[collection];
        uint256 total;
        for (uint256 i; i < fees.length; ++i) {
            if (fees[i].recipient == address(0)) revert ZeroAddress();
            total += fees[i].bps;
            stored.push(fees[i]);
        }
        if (total > MAX_FEES_BPS) revert TooManyFees();
        emit FeesSet(collection, fees);
    }

    /// @dev A collection's own fees, or the default ones (collection 0) when it has none.
    function _feesOf(address collection) private view returns (Fee[] storage fees) {
        fees = _fees[collection];
        if (fees.length == 0) fees = _fees[address(0)];
    }

    function _componentsOf(bytes32 orderHash) private view returns (OrderComponents memory) {
        Listing storage l = _listings[orderHash];
        return _components(l.offerer, l.collection, l.tokenId, l.price, l.startTime, l.endTime, l.salt, l.counter, l.fees);
    }

    /// @dev The NFT on offer; the offerer's share, then each fee, in ETH.
    function _components(
        address offerer,
        address collection,
        uint256 tokenId,
        uint256 price,
        uint64 startTime,
        uint64 endTime,
        uint256 salt,
        uint256 counter,
        Fee[] storage fees
    ) private view returns (OrderComponents memory c) {
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem({itemType: ItemType.ERC721, token: collection, identifierOrCriteria: tokenId, startAmount: 1, endAmount: 1});
        ConsiderationItem[] memory consideration = new ConsiderationItem[](1 + fees.length);
        uint256 net = price;
        for (uint256 i; i < fees.length; ++i) {
            uint256 amount = (price * fees[i].bps) / 10_000;
            net -= amount;
            consideration[1 + i] = _eth(amount, fees[i].recipient);
        }
        consideration[0] = _eth(net, payable(offerer));
        c = OrderComponents({
            offerer: offerer,
            zone: zone,
            offer: offer,
            consideration: consideration,
            orderType: zone == address(0) ? OrderType.FULL_OPEN : OrderType.FULL_RESTRICTED,
            startTime: startTime,
            endTime: endTime,
            zoneHash: bytes32(0),
            salt: salt,
            conduitKey: conduitKey,
            counter: counter
        });
    }

    function _eth(uint256 amount, address payable recipient) private pure returns (ConsiderationItem memory) {
        return ConsiderationItem({
            itemType: ItemType.NATIVE,
            token: address(0),
            identifierOrCriteria: 0,
            startAmount: amount,
            endAmount: amount,
            recipient: recipient
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
}
