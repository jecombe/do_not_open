// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ConfidentialERC721} from "../confidential/ConfidentialERC721.sol";
import {IConfidentialERC721} from "../confidential/IConfidentialERC721.sol";

/// @title Test Confidential NFT
/// @notice The smallest collection on `ConfidentialERC721`, to test the standard on its own.
contract TestConfidentialNFT is ConfidentialERC721, ZamaEthereumConfig {
    mapping(address reader => bool) public trusted;

    constructor() ConfidentialERC721("Test Confidential NFT", "TCN") {}

    function mint(address to) external returns (uint256) {
        return _mint(to, FHE.asEbool(true));
    }

    /// @notice A token id nobody owns, minted "to" `to`: from outside it looks like `mint`.
    function mintEmpty(address to) external returns (uint256) {
        return _mint(to, FHE.asEbool(false));
    }

    function setTrusted(address reader, bool value) external {
        trusted[reader] = value;
    }

    function _isTrustedReader(address reader) internal view override returns (bool) {
        return trusted[reader];
    }
}

/// @title Test escrow
/// @notice How a marketplace holds a confidential NFT: it pulls the token as an operator, keeps
///         the encrypted "it arrived" bit, and later sends the token on. It never learns in the
///         clear whether the seller really held the token; a sale built on it would make that bit
///         part of what it decrypts at settlement.
contract TestConfidentialEscrow is ZamaEthereumConfig {
    IConfidentialERC721 public immutable nft;
    mapping(uint256 tokenId => ebool) public escrowed;
    ebool public lastCheck;

    constructor(IConfidentialERC721 nft_) {
        nft = nft_;
    }

    function deposit(address seller, uint256 tokenId) external {
        ebool arrived = nft.confidentialTransferFrom(seller, address(this), tokenId);
        // The token granted this contract the bit for the transaction; keeping it needs allowThis.
        FHE.allowThis(arrived);
        FHE.allow(arrived, seller);
        escrowed[tokenId] = arrived;
    }

    /// @dev Moves the token on. If it never arrived, this moves nothing either.
    function release(address to, uint256 tokenId) external returns (ebool moved) {
        moved = nft.confidentialTransfer(to, tokenId);
        FHE.allowThis(moved);
    }

    /// @notice "Does `account` hold `tokenId`", asked as a trusted reader.
    function check(uint256 tokenId, address account) external returns (ebool owns) {
        owns = nft.isOwner(tokenId, account);
        FHE.allowThis(owns);
        FHE.makePubliclyDecryptable(owns);
        lastCheck = owns;
    }
}
