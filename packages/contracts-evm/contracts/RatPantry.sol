// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IRats {
    function ownerOf(uint256 tokenId) external view returns (address);
    function mintedAt(uint256 tokenId) external view returns (uint64);
}

/// @title The rats' pantry
/// @notice Each rat earns `perDay` plain CROQ a day from its mint, claimed by whoever owns it.
///         At most `maxDays` are kept between two claims. Funded with a plain CROQ transfer from
///         the treasury; anyone may top it up the same way. While it is empty a claim reverts, so
///         nobody loses the days they earned; when it runs low a claim pays what is left. No
///         owner, nothing to change: the numbers are immutable.
/// @dev Plain CROQ, not cCROQ: a rat's owner is public, so its earnings may be too. The game's
///      bureau de change wraps them into cCROQ for the boxes.
contract RatPantry {
    using SafeERC20 for IERC20;

    IERC20 public immutable croq;
    IRats public immutable rats;
    uint256 public immutable perDay;
    uint256 public immutable maxDays;

    /// @notice Up to when each rat has been paid. 0 until its first claim: then it counts from its mint.
    mapping(uint256 tokenId => uint64) public paidUntil;

    error NotYourRat(uint256 tokenId);
    error NoRats();
    error PantryEmpty();

    event RatsFed(address indexed owner, uint256[] ids, uint256 amount);

    constructor(IERC20 croq_, IRats rats_, uint256 perDay_, uint256 maxDays_) {
        croq = croq_;
        rats = rats_;
        perDay = perDay_;
        maxDays = maxDays_;
    }

    /// @notice What `tokenId` would get if claimed now.
    function claimable(uint256 tokenId) public view returns (uint256) {
        (uint256 days_, ) = _due(tokenId);
        return days_ * perDay;
    }

    /// @notice CROQ left to pay out.
    function reserve() external view returns (uint256) {
        return croq.balanceOf(address(this));
    }

    /// @notice Pays the caller's rats `ids` what they earned, or what is left in the reserve.
    function claim(uint256[] calldata ids) external returns (uint256 paid) {
        if (ids.length == 0) revert NoRats();
        uint256 owed;
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (rats.ownerOf(id) != msg.sender) revert NotYourRat(id);
            (uint256 days_, uint64 until) = _due(id);
            if (days_ == 0) continue;
            paidUntil[id] = until;
            owed += days_ * perDay;
        }
        uint256 left = croq.balanceOf(address(this));
        // Empty: nothing is paid, so nothing is marked paid either.
        if (owed > 0 && left == 0) revert PantryEmpty();
        paid = owed < left ? owed : left;
        if (paid > 0) croq.safeTransfer(msg.sender, paid);
        emit RatsFed(msg.sender, ids, paid);
    }

    /// @dev Whole days owed, at most maxDays, and the time they are paid up to: the remainder of a
    ///      day is kept, but days past the cap are lost.
    function _due(uint256 tokenId) private view returns (uint256 days_, uint64 until) {
        uint64 from = paidUntil[tokenId];
        if (from == 0) from = rats.mintedAt(tokenId);
        uint256 elapsed = block.timestamp > from ? block.timestamp - from : 0;
        days_ = elapsed / 1 days;
        if (days_ > maxDays) {
            days_ = maxDays;
            until = uint64(block.timestamp);
        } else {
            until = uint64(from + days_ * 1 days);
        }
    }
}
