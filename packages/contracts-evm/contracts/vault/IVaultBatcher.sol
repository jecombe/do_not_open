// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";

/// @title A confidential vault batcher, as Zama deploys them in front of Morpho's vaults
/// @notice The slice of `DepositVaultBatcherConfidential` / `RedeemVaultBatcherConfidential`
///         (OpenZeppelin's `BatcherConfidential` under Zama's `IVaultBatcherConfidential`) the
///         pockets' savings use. Participants join a batch with an encrypted amount of the input
///         token; once the batch is old enough anyone dispatches it, only its total is decrypted,
///         the batcher settles it against the ERC-4626 vault and publishes an exchange rate; each
///         participant then claims its share of the output token, computed under encryption.
///         https://docs.zama.org/protocol/confidential-vault/reference/batcher-interface
interface IVaultBatcher {
    enum BatchState {
        Pending,
        Dispatched,
        Finalized,
        Canceled
    }

    /// @notice Pulls `encryptedAmount` of `fromToken()` from the caller (the batcher must be its
    ///         operator) and credits `beneficiary` in the current batch. An empty `inputProof`
    ///         takes an already-allowed handle.
    function join(address beneficiary, externalEuint64 encryptedAmount, bytes calldata inputProof) external returns (euint64);

    /// @notice Pays `account` its share of a finalized batch, in `toToken()`. Anyone may call it.
    function claim(uint256 batchId, address account) external returns (euint64);

    /// @notice Refunds `account` its deposit in a canceled batch, in `fromToken()`. Anyone may call it.
    function recover(uint256 batchId, address account) external returns (euint64);

    function vault() external view returns (address);

    function fromToken() external view returns (address);

    function toToken() external view returns (address);

    /// @notice The sole pending batch; ids start at 1.
    function currentBatchId() external view returns (uint256);

    function batchState(uint256 batchId) external view returns (uint8);

    /// @notice Output units per input unit, times 1e6. Zero until finalized.
    function exchangeRate(uint256 batchId) external view returns (uint64);

    function batchCreatedAt(uint256 batchId) external view returns (uint256);

    function batchMinBatchAge(uint256 batchId) external view returns (uint256);

    function minBatchAge() external view returns (uint256);

    function paused() external view returns (bool);
}
