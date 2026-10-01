// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Collection hooks, as the confidential marketplace defines them
/// @notice A copy of `ICollectionHooks` from marketplace_nft_confidential
///         (`packages/contracts/contracts/interfaces/ICollectionHooks.sol`): the dependency points
///         from the collection to the market, never back. Keep the two identical.
interface ICollectionHooks {
    function beforeList(address nft, uint256 tokenId, address seller, address module) external view returns (bytes32 snapshot);

    function beforeSettle(address nft, uint256 tokenId, address seller, address buyer, bytes32 snapshot) external view;

    function afterSettle(address nft, uint256 tokenId, address seller, address buyer) external;
}
