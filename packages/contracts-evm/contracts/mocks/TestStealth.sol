// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC5564Announcer, IERC6538Registry} from "../vault/IStealth.sol";

/// @notice Local networks only: ERC-5564's announcer as the reference one behaves (an event, no state).
contract TestStealthAnnouncer is IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}

/// @notice Local networks only: ERC-6538's registry, the part the pockets use (a wallet registers its own keys).
contract TestStealthRegistry is IERC6538Registry {
    mapping(address registrant => mapping(uint256 schemeId => bytes)) private _keys;

    function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external {
        _keys[msg.sender][schemeId] = stealthMetaAddress;
        emit StealthMetaAddressSet(msg.sender, schemeId, stealthMetaAddress);
    }

    function stealthMetaAddressOf(address registrant, uint256 schemeId) external view returns (bytes memory) {
        return _keys[registrant][schemeId];
    }
}
