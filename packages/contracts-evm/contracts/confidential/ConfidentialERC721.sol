// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, eaddress, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IConfidentialERC721} from "./IConfidentialERC721.sol";

/// @title ConfidentialERC721
/// @notice Base implementation of `IConfidentialERC721`: encrypted owners, transfers that are
///         always a "maybe", and discovery through the holder's own transfer receipts.
/// @dev The inheriting contract supplies the FHEVM configuration (e.g. `ZamaEthereumConfig`),
///      decides how tokens are minted (`_mint`) and which contracts may read ownership
///      (`_isTrustedReader`).
///
///      HCU: a transfer is one `eq` and one `select` on an `eaddress`, about 200,000; a transfer
///      that may be a decoy adds one `and`.
///      `isOwner` is one `eq`, about 115,000. A mint is one `select`, about 83,000.
abstract contract ConfidentialERC721 is IConfidentialERC721 {
    string private _name;
    string private _symbol;
    uint256 private _tokenCount;

    mapping(uint256 tokenId => eaddress) private _owners;
    mapping(address holder => mapping(address operator => uint48 until)) private _operators;

    constructor(string memory name_, string memory symbol_) {
        _name = name_;
        _symbol = symbol_;
    }

    // ------------------------------------------------------------------ views

    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == type(IConfidentialERC721).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function name() public view virtual returns (string memory) {
        return _name;
    }

    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    function tokenURI(uint256 tokenId) public view virtual returns (string memory) {
        _requireExists(tokenId);
        string memory base = _baseURI();
        return bytes(base).length == 0 ? "" : string.concat(base, _toString(tokenId));
    }

    function tokenCount() public view virtual returns (uint256) {
        return _tokenCount;
    }

    function confidentialOwnerOf(uint256 tokenId) public view virtual returns (eaddress) {
        _requireExists(tokenId);
        return _owners[tokenId];
    }

    function isOperator(address holder, address operator) public view virtual returns (bool) {
        return holder == operator || block.timestamp <= _operators[holder][operator];
    }

    // -------------------------------------------------------------- transfers

    function setOperator(address operator, uint48 until) public virtual {
        _operators[msg.sender][operator] = until;
        emit OperatorSet(msg.sender, operator, until);
    }

    function confidentialTransfer(address to, uint256 tokenId) public virtual returns (ebool moved) {
        moved = _transfer(msg.sender, to, tokenId, ebool.wrap(0));
    }

    function confidentialTransferIf(address to, uint256 tokenId, externalEbool really, bytes calldata inputProof)
        public
        virtual
        returns (ebool moved)
    {
        moved = _transfer(msg.sender, to, tokenId, FHE.fromExternal(really, inputProof));
    }

    function confidentialTransferFrom(address from, address to, uint256 tokenId) public virtual returns (ebool moved) {
        if (!isOperator(from, msg.sender)) revert ConfidentialERC721UnauthorizedSpender(from, msg.sender);
        moved = _transfer(from, to, tokenId, ebool.wrap(0));
    }

    function isOwner(uint256 tokenId, address account) public virtual returns (ebool owns) {
        if (msg.sender != account && !isOperator(account, msg.sender) && !_isTrustedReader(msg.sender)) {
            revert ConfidentialERC721UnauthorizedReader(msg.sender, account);
        }
        owns = _isOwner(tokenId, account);
        FHE.allowThis(owns);
        FHE.allow(owns, account);
        FHE.allowTransient(owns, msg.sender);
    }

    // --------------------------------------------------------------- internal

    /// @dev Contracts allowed to ask `isOwner` about any account, e.g. the collection's own game
    ///      modules. None by default. Whatever they learn they must not make public.
    function _isTrustedReader(address) internal view virtual returns (bool) {
        return false;
    }

    function _baseURI() internal view virtual returns (string memory) {
        return "";
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return tokenId < _tokenCount;
    }

    function _requireExists(uint256 tokenId) internal view {
        if (!_exists(tokenId)) revert ConfidentialERC721NonexistentToken(tokenId);
    }

    /// @dev "Does `account` hold `tokenId`?", with no ACL granted to anyone.
    function _isOwner(uint256 tokenId, address account) internal returns (ebool) {
        _requireExists(tokenId);
        return FHE.eq(_owners[tokenId], account);
    }

    /// @dev Creates the next token id, owned by `to` if `real`, empty otherwise. `to` can decrypt
    ///      `real`; to everyone else the two cases look the same.
    function _mint(address to, ebool real) internal returns (uint256 tokenId) {
        return _mint(to, real, FHE.asEaddress(to), FHE.asEaddress(address(0)));
    }

    /// @dev Same, with `to` and address(0) already encrypted: a batch encrypts them once.
    function _mint(address to, ebool real, eaddress encryptedTo, eaddress nobody) internal returns (uint256 tokenId) {
        if (to == address(0)) revert ConfidentialERC721InvalidReceiver(address(0));
        tokenId = _tokenCount++;
        eaddress owner = FHE.select(real, encryptedTo, nobody);
        FHE.allowThis(owner);
        _owners[tokenId] = owner;
        _share(real, address(0), to);
        emit ConfidentialTransfer(tokenId, address(0), to, real);
    }

    /// @dev Moves `tokenId` from `from` to `to` if `from` holds it and `really` is true or left
    ///      uninitialized; nothing happens otherwise.
    function _transfer(address from, address to, uint256 tokenId, ebool really) internal virtual returns (ebool moved) {
        if (to == address(0)) revert ConfidentialERC721InvalidReceiver(address(0));
        moved = _isOwner(tokenId, from);
        if (FHE.isInitialized(really)) moved = FHE.and(moved, really);
        eaddress owner = FHE.select(moved, FHE.asEaddress(to), _owners[tokenId]);
        FHE.allowThis(owner);
        _owners[tokenId] = owner;
        _share(moved, from, to);
        emit ConfidentialTransfer(tokenId, from, to, moved);
    }

    /// @dev The receipt of a transfer: readable by both sides for good, and by the calling
    ///      contract for this transaction, so it can build on the result.
    function _share(ebool moved, address from, address to) private {
        FHE.allowThis(moved);
        if (from != address(0)) FHE.allow(moved, from);
        FHE.allow(moved, to);
        if (msg.sender != from && msg.sender != to) FHE.allowTransient(moved, msg.sender);
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) digits++;
        bytes memory out = new bytes(digits);
        for (; value != 0; value /= 10) out[--digits] = bytes1(uint8(48 + (value % 10)));
        return string(out);
    }
}
