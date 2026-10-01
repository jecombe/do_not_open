// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

/// @title Confidential Croquettes (cCROQ)
/// @notice CROQ with encrypted balances and transfer amounts (ERC-7984). One CROQ wraps into one
///         cCROQ; unwrapping goes through a public decryption of the amount and back.
/// @dev Unmodified OpenZeppelin wrapper. Wrapping and unwrapping amounts are public by nature:
///      the plain ERC-20 moves in the clear. Everything that happens between is not.
contract ConfidentialCroq is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(
        IERC20 croq,
        string memory contractURI_
    ) ERC7984("Confidential Croquettes", "cCROQ", contractURI_) ERC7984ERC20Wrapper(croq) {}
}
