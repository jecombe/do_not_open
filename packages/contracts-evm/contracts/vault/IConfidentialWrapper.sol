// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {euint64} from "@fhevm/solidity/lib/FHE.sol";

/// @notice The calls `SealedPositions` makes on an ERC-7984 wrapper of an ERC-20 (OpenZeppelin's
///         `ERC7984ERC20Wrapper`, which Zama's cUSDC, cUSDT, cWETH and cZAMA are). `wrap` is
///         declared without its return value: older wrappers return none.
interface IConfidentialWrapper {
    function underlying() external view returns (address);

    function rate() external view returns (uint256);

    function wrap(address to, uint256 amount) external;

    function unwrap(address from, address to, euint64 amount) external returns (bytes32 unwrapRequestId);

    function finalizeUnwrap(bytes32 unwrapRequestId, uint64 unwrapAmountCleartext, bytes calldata decryptionProof) external;

    function unwrapRequester(bytes32 unwrapRequestId) external view returns (address);

    function setOperator(address operator, uint48 until) external;
}
