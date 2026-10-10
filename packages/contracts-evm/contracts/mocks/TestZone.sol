// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Test zone
/// @notice Local networks only: put at the address of OpenSea's signed zone, so a restricted
///         order fills without OpenSea's server signing it. Seaport asks the zone
///         `authorizeOrder` before an order's transfers and `validateOrder` after; this one
///         answers every call with its own selector, which is Seaport's "yes".
contract TestZone {
    fallback() external {
        assembly {
            mstore(0, shl(224, shr(224, calldataload(0))))
            return(0, 32)
        }
    }
}
