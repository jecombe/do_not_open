// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of ERC-5564 (stealth addresses) the vault's pockets use: the announcer every
///         stealth payment is published through, so the recipient's page finds it. Deployed once
///         for everyone at 0x55649E01B5Df198D18D95b5cc5051630cfD45564 on Ethereum, Sepolia and
///         most other chains; a test one stands in on a local network.
interface IERC5564Announcer {
    /// @dev `schemeId` 1 is secp256k1 with view tags; `metadata` starts with the view tag.
    event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata);

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external;
}

/// @notice The slice of ERC-6538 (the stealth meta-address registry) the pockets use: where a
///         wallet publishes the meta-address a payer makes stealth addresses from. Deployed once
///         for everyone at 0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538 on the same chains.
interface IERC6538Registry {
    event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress);

    function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external;
    function stealthMetaAddressOf(address registrant, uint256 schemeId) external view returns (bytes memory);
}
