// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ITokenURIs} from "./ITokenURIs.sol";

/// @title The boxes' token URIs
/// @notice `DoNotOpen.tokenURI` asks this contract: the base URI followed by the token id, the
///         usual ERC-721 shape. The base can move (the API's domain, a gateway); nothing else
///         lives here.
/// @dev Out of DoNotOpen to keep it under the 24,576-byte limit.
contract BoxMetadata is ITokenURIs, Ownable {
    string public baseURI;

    event BaseURISet(string baseURI);

    constructor(string memory baseURI_, address owner_) Ownable(owner_) {
        baseURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        baseURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return bytes(baseURI).length == 0 ? "" : string.concat(baseURI, Strings.toString(tokenId));
    }
}
