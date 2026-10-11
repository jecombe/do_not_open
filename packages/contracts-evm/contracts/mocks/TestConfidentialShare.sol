// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Test confidential vault shares
/// @notice Local networks only: stands for Zama's `cShare`, the ERC-7984 wrapper of a vault's
///         shares that a deposit batcher pays out. Anyone mints it, so a test batcher can pay its
///         claims; `underlying` and `rate` answer as the wrapper does.
contract TestConfidentialShare is ERC7984, ZamaEthereumConfig {
    address private immutable _underlying;

    constructor(IERC20Metadata shares) ERC7984(string.concat("Confidential ", shares.name()), string.concat("c", shares.symbol()), "") {
        _underlying = address(shares);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function underlying() external view returns (address) {
        return _underlying;
    }

    /// @notice Plain share units per confidential unit.
    function rate() external view returns (uint256) {
        return 10 ** (IERC20Metadata(_underlying).decimals() - 6);
    }

    function mint(address to, uint64 amount) external {
        _mint(to, FHE.asEuint64(amount));
    }
}
