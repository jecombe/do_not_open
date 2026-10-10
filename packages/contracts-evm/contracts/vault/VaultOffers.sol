// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {
    AdvancedOrder,
    ConsiderationItem,
    CriteriaResolver,
    ISeaport,
    ItemType,
    OfferItem,
    Order,
    OrderComponents,
    OrderParameters,
    Side
} from "./ISeaport.sol";
import {IWETH} from "./IWETH.sol";

/// @title Writes and fills buyers' Seaport offers for the sealed vault
/// @notice The vault accepts an offer by sending Seaport the `fulfillAdvancedOrder` call this
///         contract writes for it (`fillCall`): the NFT's holder is the one that calls Seaport,
///         which is what OpenSea's signed zone wants (OpenSea signs a fill for the address that
///         holds the NFT, and Seaport's caller must be that address). The offer's WETH comes to
///         the holder, Seaport takes the NFT and the order's fees, and the holder unwraps the rest.
///         `fill` does the same for a holder that would rather hand this contract the NFT for one
///         call (nothing stays here between two calls).
///
///         It is also where buyers post their offers (`post`): validated on Seaport, then logged
///         by NFT, so the vault's page finds the offers on a box without a marketplace's API.
/// @dev Stateless and open to anyone. An offer travels as abi.encode(AdvancedOrder, bytes32[]
///      criteriaProof), so the vault passes it on without decoding it.
contract VaultOffers is ReentrancyGuard {
    ISeaport public immutable seaport;
    IWETH public immutable weth;

    /// @notice `tokenId` in `OfferPosted` for an offer on any token of the collection.
    uint256 public constant ANY_TOKEN = type(uint256).max;

    error NotFilled();
    error SendFailed();
    error NotAnOffer();

    /// @notice A buyer's Seaport offer for `tokenId` of `collection` (or `ANY_TOKEN`), validated on
    ///         Seaport: it fills with no signature. `order` is what `fill` takes, as the order's
    ///         parameters.
    event OfferPosted(address indexed collection, uint256 indexed tokenId, bytes32 indexed orderHash, OrderParameters order);

    constructor(ISeaport seaport_, IWETH weth_) {
        seaport = seaport_;
        weth = weth_;
    }

    /// @dev Only WETH, unwrapped here.
    receive() external payable {
        if (msg.sender != address(weth)) revert SendFailed();
    }

    /// @notice Validates a buyer's offer on Seaport with their `signature` (anyone may send it:
    ///         the buyer's page, or a relayer) and logs it by the NFT it asks for. The offer must
    ///         pay WETH for one ERC-721 token, or for any token of a collection (criteria root 0).
    ///         Whether the buyer can pay is Seaport's to check when it fills.
    function post(OrderParameters calldata p, bytes calldata signature) external returns (bytes32 orderHash) {
        (bool good,, uint256 units, uint256 nftIndex) = _items(p, address(0), 0);
        if (!good || units == 0) revert NotAnOffer();
        ConsiderationItem calldata nft = p.consideration[nftIndex];
        if (nft.itemType == ItemType.ERC721_WITH_CRITERIA && nft.identifierOrCriteria != 0) revert NotAnOffer();
        Order[] memory orders = new Order[](1);
        orders[0] = Order({parameters: p, signature: signature});
        seaport.validate(orders);
        orderHash = seaport.getOrderHash(_components(p));
        uint256 tokenId = nft.itemType == ItemType.ERC721 ? nft.identifierOrCriteria : ANY_TOKEN;
        emit OfferPosted(nft.token, tokenId, orderHash, p);
    }

    /// @notice The offer's Seaport order hash, its buyer, and whether it can still fill one
    ///         `tokenId` of `collection` for at least `least` WETH net of its own fees: alive (not
    ///         cancelled, filled or ended), paying only WETH, asking only WETH (its fees) and that
    ///         one token (or any token of the collection, with criteria), with fixed amounts and
    ///         no tips.
    function inspect(bytes calldata offer, address collection, uint256 tokenId, uint256 least)
        external
        view
        returns (bytes32 orderHash, address buyer, bool fillable)
    {
        (AdvancedOrder memory order,) = abi.decode(offer, (AdvancedOrder, bytes32[]));
        OrderParameters memory p = order.parameters;
        buyer = p.offerer;
        orderHash = seaport.getOrderHash(_components(p));
        (, bool cancelled, uint256 filled, uint256 size) = seaport.getOrderStatus(orderHash);
        if (cancelled || (size != 0 && filled == size) || block.timestamp >= p.endTime) return (orderHash, buyer, false);
        if (p.totalOriginalConsiderationItems != p.consideration.length) return (orderHash, buyer, false);
        (bool good, uint256 fees, uint256 units,) = _items(p, collection, tokenId);
        uint256 paid = _paid(p);
        fillable = good && paid >= fees && (paid - fees) / units >= least;
    }

    /// @notice The `fulfillAdvancedOrder` call the NFT's holder sends to Seaport to fill one
    ///         token's share of the offer with `tokenId` of `collection`, the WETH coming to
    ///         `recipient` (the holder), and the WETH `fee` the holder lets Seaport take for the
    ///         order's own fees (out of what arrives: Seaport moves the offer first). The holder
    ///         approves Seaport on the NFT first. For an item with criteria, the offer's
    ///         `criteriaProof` proves the token is one the order takes (empty when it takes any).
    function fillCall(bytes calldata offer, address collection, uint256 tokenId, address recipient)
        external
        view
        returns (bytes memory call, uint256 fee)
    {
        (AdvancedOrder memory order, CriteriaResolver[] memory resolvers, uint256 fees, uint256 units) = _order(offer, collection, tokenId);
        fee = fees / units;
        call = abi.encodeCall(ISeaport.fulfillAdvancedOrder, (order, resolvers, bytes32(0), recipient));
    }

    /// @notice Fills one token's share of the offer's order with `tokenId` of `collection`, which
    ///         this contract must hold, and sends the caller the WETH left, unwrapped. Reverts if
    ///         the order does not fill or the NFT stays.
    function fill(bytes calldata offer, address collection, uint256 tokenId) external nonReentrant returns (uint256 amount) {
        (AdvancedOrder memory order, CriteriaResolver[] memory resolvers, uint256 fees, uint256 units) = _order(offer, collection, tokenId);
        IERC721(collection).approve(address(seaport), tokenId);
        weth.approve(address(seaport), fees / units);
        seaport.fulfillAdvancedOrder(order, resolvers, bytes32(0), address(this));
        weth.approve(address(seaport), 0);
        if (IERC721(collection).ownerOf(tokenId) == address(this)) revert NotFilled();
        amount = weth.balanceOf(address(this));
        weth.withdraw(amount);
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert SendFailed();
    }

    /// @dev The order for one token's share (1/units), its criteria resolved to `tokenId`.
    function _order(bytes calldata offer, address collection, uint256 tokenId)
        private
        view
        returns (AdvancedOrder memory order, CriteriaResolver[] memory resolvers, uint256 fees, uint256 units)
    {
        bytes32[] memory criteriaProof;
        (order, criteriaProof) = abi.decode(offer, (AdvancedOrder, bytes32[]));
        bool good;
        uint256 nftIndex;
        (good, fees, units, nftIndex) = _items(order.parameters, collection, tokenId);
        if (!good) revert NotFilled();
        order.numerator = 1;
        order.denominator = uint120(units);
        if (order.parameters.consideration[nftIndex].itemType == ItemType.ERC721_WITH_CRITERIA) {
            resolvers = new CriteriaResolver[](1);
            resolvers[0] = CriteriaResolver({
                orderIndex: 0,
                side: Side.CONSIDERATION,
                index: nftIndex,
                identifier: tokenId,
                criteriaProof: criteriaProof
            });
        }
    }

    /// @dev Every consideration item is WETH (the order's fees) or the one NFT, with fixed
    ///      amounts; `units` is how many tokens the NFT item is for. `collection` 0: any one NFT.
    function _items(OrderParameters memory p, address collection, uint256 tokenId)
        private
        view
        returns (bool good, uint256 fees, uint256 units, uint256 nftIndex)
    {
        for (uint256 i = 0; i < p.offer.length; i++) {
            OfferItem memory o = p.offer[i];
            if (o.itemType != ItemType.ERC20 || o.token != address(weth) || o.startAmount != o.endAmount) {
                return (false, 0, 0, 0);
            }
        }
        for (uint256 i = 0; i < p.consideration.length; i++) {
            ConsiderationItem memory c = p.consideration[i];
            if (c.startAmount != c.endAmount) return (false, 0, 0, 0);
            if (c.itemType == ItemType.ERC20 && c.token == address(weth)) {
                fees += c.startAmount;
            } else if (
                (collection == address(0) || c.token == collection) && units == 0
                    && (
                        (c.itemType == ItemType.ERC721 && (collection == address(0) || c.identifierOrCriteria == tokenId))
                            || c.itemType == ItemType.ERC721_WITH_CRITERIA
                    )
            ) {
                units = c.startAmount;
                nftIndex = i;
            } else {
                return (false, 0, 0, 0);
            }
        }
        good = units != 0;
    }

    function _paid(OrderParameters memory p) private pure returns (uint256 paid) {
        for (uint256 i = 0; i < p.offer.length; i++) {
            paid += p.offer[i].startAmount;
        }
    }

    function _components(OrderParameters memory p) private view returns (OrderComponents memory) {
        return OrderComponents({
            offerer: p.offerer,
            zone: p.zone,
            offer: p.offer,
            consideration: p.consideration,
            orderType: p.orderType,
            startTime: p.startTime,
            endTime: p.endTime,
            zoneHash: p.zoneHash,
            salt: p.salt,
            conduitKey: p.conduitKey,
            counter: seaport.getCounter(p.offerer)
        });
    }
}
