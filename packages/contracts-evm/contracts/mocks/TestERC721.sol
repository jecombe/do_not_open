// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title Test ERC-721
/// @notice Local networks only: an NFT anyone can mint, to check who a receiver accepts.
contract TestERC721 is ERC721 {
    constructor() ERC721("Test NFT", "TNFT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}
