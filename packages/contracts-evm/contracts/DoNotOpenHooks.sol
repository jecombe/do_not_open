// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICollectionHooks} from "./market/ICollectionHooks.sol";
import {DoNotOpen} from "./DoNotOpen.sol";

/// @title DoNotOpen hooks for the confidential marketplace
/// @notice What a buyer bids on is a box in a given public state: sealed or opened, entangled
///         or not, checked by the vet or not. If that state changes while the box sits in escrow
///         (an entangled partner's holder opens it, say), the sale fails and everyone is refunded.
/// @dev Who holds the box is encrypted; the market escrows it with `confidentialTransferFrom` and
///      proves the arrival itself. These hooks only read public state.
contract DoNotOpenHooks is ICollectionHooks {
    DoNotOpen public immutable boxes;

    error WrongCollection(address nft);
    error StateChanged(uint256 tokenId);

    constructor(DoNotOpen boxes_) {
        boxes = boxes_;
    }

    function beforeList(address nft, uint256 tokenId, address, address) external view returns (bytes32) {
        if (nft != address(boxes)) revert WrongCollection(nft);
        return snapshotOf(tokenId);
    }

    function beforeSettle(address nft, uint256 tokenId, address, address, bytes32 snapshot) external view {
        if (nft != address(boxes)) revert WrongCollection(nft);
        if (snapshotOf(tokenId) != snapshot) revert StateChanged(tokenId);
    }

    function afterSettle(address, uint256, address, address) external {}

    /// @notice The public state a buyer bids on: status, entangled partner, vet check.
    function snapshotOf(uint256 tokenId) public view returns (bytes32) {
        (bool entangled, uint256 partner) = boxes.partnerOf(tokenId);
        return keccak256(abi.encode(boxes.status(tokenId), entangled, partner, boxes.aliveCheck(tokenId)));
    }
}
