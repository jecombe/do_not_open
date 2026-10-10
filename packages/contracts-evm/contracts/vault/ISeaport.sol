// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The slice of Seaport 1.5 the vault uses (its own listings, and the buyers' offers it
///      accepts), with its structs as Seaport defines them (seaport-types,
///      ConsiderationStructs.sol). OpenSea's marketplace runs on it; on Ethereum and Sepolia it
///      lives at 0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC.
enum ItemType {
    NATIVE,
    ERC20,
    ERC721,
    ERC1155,
    ERC721_WITH_CRITERIA,
    ERC1155_WITH_CRITERIA
}

enum OrderType {
    FULL_OPEN,
    PARTIAL_OPEN,
    FULL_RESTRICTED,
    PARTIAL_RESTRICTED,
    CONTRACT
}

struct OfferItem {
    ItemType itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
}

struct ConsiderationItem {
    ItemType itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
    address payable recipient;
}

struct OrderComponents {
    address offerer;
    address zone;
    OfferItem[] offer;
    ConsiderationItem[] consideration;
    OrderType orderType;
    uint256 startTime;
    uint256 endTime;
    bytes32 zoneHash;
    uint256 salt;
    bytes32 conduitKey;
    uint256 counter;
}

struct OrderParameters {
    address offerer;
    address zone;
    OfferItem[] offer;
    ConsiderationItem[] consideration;
    OrderType orderType;
    uint256 startTime;
    uint256 endTime;
    bytes32 zoneHash;
    uint256 salt;
    bytes32 conduitKey;
    uint256 totalOriginalConsiderationItems;
}

struct Order {
    OrderParameters parameters;
    bytes signature;
}

/// @dev An order with the share of it to fill (`numerator` / `denominator`) and what its zone
///      reads (`extraData`): what a fulfiller passes to `fulfillAdvancedOrder`.
struct AdvancedOrder {
    OrderParameters parameters;
    uint120 numerator;
    uint120 denominator;
    bytes signature;
    bytes extraData;
}

enum Side {
    OFFER,
    CONSIDERATION
}

/// @dev Names the token an item "with criteria" stands for (a collection offer, say): any token
///      when the item's criteria root is 0, else one proven against it.
struct CriteriaResolver {
    uint256 orderIndex;
    Side side;
    uint256 index;
    uint256 identifier;
    bytes32[] criteriaProof;
}

interface ISeaport {
    /// @dev An offerer validating its own orders needs no signature.
    function validate(Order[] calldata orders) external returns (bool validated);

    /// @dev Only the offerer (or the order's zone) may cancel.
    function cancel(OrderComponents[] calldata orders) external returns (bool cancelled);

    function getOrderHash(OrderComponents calldata order) external view returns (bytes32 orderHash);

    function getOrderStatus(bytes32 orderHash)
        external
        view
        returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize);

    function getCounter(address offerer) external view returns (uint256 counter);

    /// @dev Seaport's version ("1.5", "1.6"): what an order's EIP-712 domain names.
    function information()
        external
        view
        returns (string memory version, bytes32 domainSeparator, address conduitController);

    function fulfillOrder(Order calldata order, bytes32 fulfillerConduitKey) external payable returns (bool fulfilled);

    /// @dev The offer's items go to `recipient` first, then the fulfiller (msg.sender) hands over
    ///      the consideration's.
    function fulfillAdvancedOrder(
        AdvancedOrder calldata advancedOrder,
        CriteriaResolver[] calldata criteriaResolvers,
        bytes32 fulfillerConduitKey,
        address recipient
    ) external payable returns (bool fulfilled);
}
