// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Decryption credits
/// @notice Every decryption and every encrypted input goes through Zama's relayer, which bills
///         the collection for it. Each wallet gets a free allowance a day; past it, the app's
///         backend spends credits bought here, one credit per decrypted value.
/// @dev Paid in plain USDC on purpose: `transferFrom` either moves the whole price or reverts,
///      where a cUSDC payment that falls short moves 0 without a revert. What is bought is
///      public; what the credits are spent on is counted off-chain by the backend, which only
///      ever adds `bought` up and never lets an account spend more than it.
contract DecryptionCredits is Ownable {
    using SafeERC20 for IERC20;

    /// @notice A price above 1 USDC a credit is refused, whatever the owner asks.
    uint256 public constant MAX_PRICE = 1_000_000;

    IERC20 public immutable usdc;
    /// @notice USDC, in its smallest unit, per credit.
    uint256 public price;
    /// @notice Where payments go, at once: the contract never holds funds.
    address public treasury;
    /// @notice Credits ever bought for each account.
    mapping(address account => uint256) public bought;

    error NoCredits();
    error PriceTooHigh();
    error PriceChanged();
    error ZeroAddress();

    event CreditsBought(address indexed payer, address indexed account, uint256 credits, uint256 paid);
    event PriceSet(uint256 price);
    event TreasurySet(address treasury);

    constructor(IERC20 usdc_, uint256 price_, address treasury_, address owner_) Ownable(owner_) {
        usdc = usdc_;
        _setPrice(price_);
        _setTreasury(treasury_);
    }

    /// @notice Buys `credits` for `account` (usually the caller) at the current price, refusing
    ///         to pay more than `maxPrice` a credit should the owner change it meanwhile. The
    ///         caller must have approved this contract for the total.
    function buy(address account, uint256 credits, uint256 maxPrice) external returns (uint256 paid) {
        if (credits == 0) revert NoCredits();
        if (account == address(0)) revert ZeroAddress();
        if (price > maxPrice) revert PriceChanged();
        paid = credits * price;
        bought[account] += credits;
        usdc.safeTransferFrom(msg.sender, treasury, paid);
        emit CreditsBought(msg.sender, account, credits, paid);
    }

    function setPrice(uint256 price_) external onlyOwner {
        _setPrice(price_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function _setPrice(uint256 price_) private {
        if (price_ > MAX_PRICE) revert PriceTooHigh();
        price = price_;
        emit PriceSet(price_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }
}
