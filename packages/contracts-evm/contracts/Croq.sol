// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Croquettes (CROQ)
/// @notice The public face of the game currency: a plain ERC-20, so any market can list it.
///         The game itself only uses the confidential wrapper, cCROQ.
/// @dev The whole supply is minted once, in the constructor. There is no mint function, no
///      owner and no pause: what exists at deployment is all that will ever exist.
///      No decimals: one CROQ is one croquette.
contract Croq is ERC20 {
    constructor(uint256 totalSupply_, address recipient) ERC20("Croquettes", "CROQ") {
        _mint(recipient, totalSupply_);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }
}
