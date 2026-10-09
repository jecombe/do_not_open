// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The slice of delegate.xyz's Delegate Registry v2 the vault uses. It lives at
///      0x00000000000000447e69651d841bD8D104Bed493 on Ethereum, Sepolia and most other chains;
///      airdrops, token gates and claim sites ask it who may act for an NFT's owner.
interface IDelegateRegistry {
    /// @dev `to` may act for the caller on `tokenId` of `contract_`; `rights` 0 is every right.
    function delegateERC721(address to, address contract_, uint256 tokenId, bytes32 rights, bool enable)
        external
        payable
        returns (bytes32 delegationHash);

    function checkDelegateForERC721(address to, address from, address contract_, uint256 tokenId, bytes32 rights)
        external
        view
        returns (bool);
}
