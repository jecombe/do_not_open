// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ebool, eaddress, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title Confidential ERC-721 (draft)
/// @notice A non-fungible token whose owners are encrypted. Token ids, metadata and transfer
///         attempts are public; who holds what is not. Nobody can count another account's tokens.
///
/// @dev The rules every implementation follows:
///
///  1. Each token has one encrypted owner (`eaddress`). An empty token has owner address(0).
///
///  2. A transfer never reverts on ownership. It moves the token if the sender owns it, and does
///     nothing otherwise, and returns an encrypted bool saying which. So a transfer by someone
///     who does not hold the token looks exactly like a real one: every transfer is a "maybe".
///
///  3. Every change of ownership, mints included, emits `ConfidentialTransfer` with that bool.
///     Only `from`, `to` and the calling contract may decrypt it. An account finds its tokens by
///     reading the events where it is `from` or `to`, decrypting their bools, and replaying them
///     in order: a moved `to` adds the token, a moved `from` removes it. Nobody else can.
///
///  4. Ownership is proven to contracts with `isOwner`, which returns an encrypted bool. Who may
///     ask is restricted, so no contract can probe who holds a token.
///
///  5. Approvals are operators with an expiry, as in ERC-7984: a holder lets one address move any
///     of their tokens until a date. There are no per-token approvals: they would name the owner.
///
///  6. A holder may send a decoy: a transfer with an encrypted `really` set to false moves nothing,
///     though it looks like any other. Once something public shows that an address holds a token,
///     its next plain transfer of it is certainly real; decoys sent with the real one keep the
///     doubt. Optional: a plain transfer is a transfer with `really` true.
interface IConfidentialERC721 is IERC165 {
    /// @notice `tokenId` may have moved from `from` to `to`. `moved` says if it did; `from`, `to`
    ///         and the contract that asked can decrypt it. A mint has `from` = address(0).
    event ConfidentialTransfer(uint256 indexed tokenId, address indexed from, address indexed to, ebool moved);

    event OperatorSet(address indexed holder, address indexed operator, uint48 until);

    error ConfidentialERC721NonexistentToken(uint256 tokenId);
    error ConfidentialERC721InvalidReceiver(address receiver);
    error ConfidentialERC721UnauthorizedSpender(address from, address spender);
    error ConfidentialERC721UnauthorizedReader(address reader, address account);

    function name() external view returns (string memory);

    function symbol() external view returns (string memory);

    function tokenURI(uint256 tokenId) external view returns (string memory);

    /// @notice How many token ids exist: they are 0 to `tokenCount() - 1`. Empty ones included,
    ///         so this is not a supply.
    function tokenCount() external view returns (uint256);

    /// @notice Handle of the encrypted owner. Nobody but the contract may decrypt it.
    function confidentialOwnerOf(uint256 tokenId) external view returns (eaddress);

    function isOperator(address holder, address operator) external view returns (bool);

    /// @notice Lets `operator` move any of the caller's tokens until `until` (a timestamp).
    function setOperator(address operator, uint48 until) external;

    /// @notice Moves `tokenId` to `to` if the caller holds it. Never reverts on ownership.
    function confidentialTransfer(address to, uint256 tokenId) external returns (ebool moved);

    /// @notice `confidentialTransfer`, but moves nothing unless `really`, encrypted by the caller,
    ///         is true: false sends a decoy. `really` is made for this contract and the caller
    ///         with the Relayer SDK.
    function confidentialTransferIf(address to, uint256 tokenId, externalEbool really, bytes calldata inputProof)
        external
        returns (ebool moved);

    /// @notice Moves `tokenId` from `from` to `to` if `from` holds it. The caller must be `from`
    ///         or one of `from`'s operators.
    function confidentialTransferFrom(address from, address to, uint256 tokenId) external returns (ebool moved);

    /// @notice "Does `account` hold `tokenId`?", encrypted. Allowed to `account` and, for this
    ///         transaction only, to the caller. The caller must be `account`, one of its operators,
    ///         or a contract the collection trusts.
    function isOwner(uint256 tokenId, address account) external returns (ebool);
}
