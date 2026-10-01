// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Test USDC
/// @notice Local networks only: a 6-decimal dollar anyone can mint, like Zama's USDCMock on Sepolia.
contract TestUSDC is ERC20 {
    constructor() ERC20("USD Coin (Test)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
