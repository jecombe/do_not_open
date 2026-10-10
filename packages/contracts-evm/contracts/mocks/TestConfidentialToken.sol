// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

/// @title Test confidential token
/// @notice Local networks only: the same OpenZeppelin wrapper as Zama's cUSDT, cWETH and cZAMA on
///         Sepolia, over any ERC-20 (6 decimals at most, 10^(decimals - 6) plain units each above).
contract TestConfidentialToken is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(IERC20 underlying_, string memory name_, string memory symbol_) ERC7984(name_, symbol_, "") ERC7984ERC20Wrapper(underlying_) {}
}
