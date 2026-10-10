// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Tests only: an "ERC-721" whose `transferFrom` moves nothing, as a malicious collection
///      would, so the vault's deposit must see the NFT never arrived.
contract TestFakeNFT {
    function transferFrom(address, address, uint256) external {}

    function approve(address, uint256) external {}

    function ownerOf(uint256) external pure returns (address) {
        return address(0xdead);
    }

    function tokenURI(uint256) external pure returns (string memory) {
        return "";
    }
}
