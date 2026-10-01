// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestUSDC} from "./TestUSDC.sol";

/// @title Test swap router
/// @notice Local networks only: sells TestUSDC for ETH at a fixed price, with Uniswap V2's
///         `swapExactETHForTokens` and `getAmountsOut` signatures.
contract TestSwapRouter {
    /// @dev Never used as a token: the path's first hop, like Uniswap's WETH.
    address public constant WETH = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);
    TestUSDC public immutable usdc;
    /// @notice USDC units (6 decimals) per whole ETH.
    uint256 public immutable usdcPerEth;

    error Slippage();

    constructor(TestUSDC usdc_, uint256 usdcPerEth_) {
        usdc = usdc_;
        usdcPerEth = usdcPerEth_;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata) public view returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = (amountIn * usdcPerEth) / 1 ether;
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external payable returns (uint256[] memory amounts) {
        amounts = getAmountsOut(msg.value, path);
        if (amounts[1] < amountOutMin) revert Slippage();
        usdc.mint(to, amounts[1]);
    }
}
