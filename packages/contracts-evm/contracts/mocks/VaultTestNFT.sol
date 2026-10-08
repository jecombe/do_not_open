// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Vault test NFT
/// @notice Test networks only: an NFT anyone can mint, for free, to try the sealed vault with.
///         Its picture is drawn on-chain from its id, so a marketplace shows something.
contract VaultTestNFT is ERC721 {
    using Strings for uint256;

    constructor() ERC721("Sealed Vault Test NFT", "VTEST") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        uint256 hue = uint256(keccak256(abi.encode(tokenId))) % 360;
        string memory id = tokenId.toString();
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="hsl(',
            hue.toString(),
            ',70%,62%)"/><rect x="60" y="120" width="280" height="200" rx="10" fill="#c8a165" stroke="#1d1b18" stroke-width="8"/><path d="M60 170h280" stroke="#1d1b18" stroke-width="8"/><text x="200" y="260" font-family="monospace" font-size="34" font-weight="700" text-anchor="middle" fill="#1d1b18">#',
            id,
            "</text></svg>"
        );
        string memory json = string.concat(
            '{"name":"Vault test #',
            id,
            '","description":"A free test NFT to try the DO NOT OPEN sealed vault with.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
