// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Test yield vault
/// @notice Local networks only: the public face of an ERC-4626 vault, as much of it as the pages
///         read to price its shares. Its price per share is set by hand (`setPrice`), to play a
///         vault that earns.
contract TestYieldVault is ERC20 {
    address public immutable asset;
    /// @notice Assets per share, in asset units per 10^decimals shares.
    uint256 public price;

    constructor(address asset_, uint256 price_) ERC20("Test Yield USDC", "tyUSDC") {
        asset = asset_;
        price = price_;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return (shares * price) / 1e18;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / price;
    }
}
