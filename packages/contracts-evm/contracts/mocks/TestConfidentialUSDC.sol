// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

/// @title Test cUSDC
/// @notice Local networks only: the same OpenZeppelin wrapper as Zama's cUSDCMock on Sepolia.
contract TestConfidentialUSDC is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(IERC20 usdc) ERC7984("Confidential USDC (Test)", "cUSDC", "") ERC7984ERC20Wrapper(usdc) {}
}
