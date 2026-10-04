// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Studio packs
/// @notice The studio draws cats from a prompt through paid AI services. Its units are sold
///         here in packs, before anything is generated: so many sketches (cartoon pictures)
///         and so many 3D models for a fixed USDC price. The app's backend reads `PackBought`
///         and spends the units off-chain, one before each call to a service.
/// @dev Paid in plain USDC for the same reason as the decryption credits: `transferFrom`
///      moves the whole price or reverts. What is bought is public; what it is spent on is
///      counted by the backend, which never lets an account spend more than it bought.
///      Unrelated to the collection: it never reads or writes DoNotOpen.
contract StudioPacks is Ownable {
    using SafeERC20 for IERC20;

    /// @notice A pack above 100 USDC is refused, whatever the owner asks.
    uint256 public constant MAX_PRICE = 100_000_000;

    struct Pack {
        /// @dev USDC, in its smallest unit. 0 means the pack is not for sale.
        uint256 price;
        uint32 sketches;
        uint32 models;
    }

    IERC20 public immutable usdc;
    /// @notice Where payments go, at once: the contract never holds funds.
    address public treasury;
    /// @notice The packs, by id. A pack with a zero price is not sold.
    mapping(uint256 packId => Pack) public packs;
    /// @notice Units ever bought for each account.
    mapping(address account => uint256) public sketchesBought;
    mapping(address account => uint256) public modelsBought;

    error NotForSale();
    error PriceChanged();
    error PriceTooHigh();
    error EmptyPack();
    error ZeroAddress();

    event PackBought(address indexed payer, address indexed account, uint256 indexed packId, uint256 sketches, uint256 models, uint256 paid);
    event PackSet(uint256 indexed packId, uint256 price, uint256 sketches, uint256 models);
    event TreasurySet(address treasury);

    constructor(IERC20 usdc_, address treasury_, address owner_, Pack[] memory packs_) Ownable(owner_) {
        usdc = usdc_;
        _setTreasury(treasury_);
        for (uint256 i = 0; i < packs_.length; i++) _setPack(i, packs_[i]);
    }

    /// @notice Buys pack `packId` for `account` (usually the caller), refusing to pay more than
    ///         `maxPrice` should the owner change the price meanwhile. The caller must have
    ///         approved this contract for the price.
    function buy(address account, uint256 packId, uint256 maxPrice) external returns (uint256 paid) {
        if (account == address(0)) revert ZeroAddress();
        Pack memory pack = packs[packId];
        if (pack.price == 0) revert NotForSale();
        if (pack.price > maxPrice) revert PriceChanged();
        paid = pack.price;
        sketchesBought[account] += pack.sketches;
        modelsBought[account] += pack.models;
        usdc.safeTransferFrom(msg.sender, treasury, paid);
        emit PackBought(msg.sender, account, packId, pack.sketches, pack.models, paid);
    }

    /// @notice Sets, changes or (with a zero price) withdraws a pack.
    function setPack(uint256 packId, Pack calldata pack) external onlyOwner {
        _setPack(packId, pack);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function _setPack(uint256 packId, Pack memory pack) private {
        if (pack.price > MAX_PRICE) revert PriceTooHigh();
        // A pack on sale must hold something; a withdrawn one may be anything.
        if (pack.price != 0 && pack.sketches == 0 && pack.models == 0) revert EmptyPack();
        packs[packId] = pack;
        emit PackSet(packId, pack.price, pack.sketches, pack.models);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }
}
