// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {euint8} from "@fhevm/solidity/lib/FHE.sol";

/// @title What DoNotOpen asks before handing out a shake
/// @notice The rats' tricks (`RatTricks`) can shield a box from strangers' shakes or jam its
///         holder's. DoNotOpen passes every shake's encrypted pick and roll through `filter`,
///         transiently allowed, and hands out what comes back.
interface IShakeGuard {
    /// @param paid a paid shake (a stranger's, or a rat's sniff): shields apply. Otherwise the
    ///        holder's own shake: jams apply.
    /// @return pick the pick, or SCRAMBLED when a jam hides it
    /// @return roll the roll, a random byte when a shield hides it, or 0 when a jam does
    function filter(uint256 tokenId, bool paid, euint8 pick, euint8 roll) external returns (euint8, euint8);
}
