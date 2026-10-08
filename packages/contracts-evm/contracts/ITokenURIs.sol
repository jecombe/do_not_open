// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Builds a collection's token URIs, out of the collection so they can move freely.
interface ITokenURIs {
    function tokenURI(uint256 tokenId) external view returns (string memory);
}
