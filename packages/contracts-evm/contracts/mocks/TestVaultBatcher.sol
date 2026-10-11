// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IVaultBatcher} from "../vault/IVaultBatcher.sol";

/// @title Test vault batcher
/// @notice Local networks only: one of Zama's confidential vault batchers, with its lifecycle
///         (join, dispatch, the decrypted total's callback, claim, recover) and none of the vault.
///         It pays its claims from its own balance of the output token, which a test or the deploy
///         funds, at a rate set by hand; `cancel` plays a batch the vault refused.
contract TestVaultBatcher is IVaultBatcher, ZamaEthereumConfig {
    struct Batch {
        BatchState state;
        euint64 total;
        uint64 rate;
        uint256 createdAt;
    }

    address public immutable vault;
    IERC7984 private immutable _from;
    IERC7984 private immutable _to;
    /// @notice The rate the next finalized batch gets: output per input, times 1e6.
    uint64 public nextRate;
    uint256 public minBatchAge;
    uint256 public currentBatchId = 1;
    bool public paused;
    mapping(uint256 => Batch) private _batches;
    mapping(uint256 batchId => mapping(address => euint64)) public deposits;

    event Joined(uint256 indexed batchId, address indexed account, euint64 amount);
    event BatchDispatched(uint256 indexed batchId);
    event BatchFinalized(uint256 indexed batchId, uint64 exchangeRate);
    event BatchCanceled(uint256 indexed batchId);
    event Claimed(uint256 indexed batchId, address indexed account, euint64 amount);

    error BatchUnexpectedState(uint256 batchId, BatchState current);
    error BatchTooYoung(uint256 batchId);
    error ZeroDeposits(uint256 batchId, address account);
    error EnforcedPause();

    constructor(address vault_, IERC7984 from_, IERC7984 to_, uint64 rate_, uint256 minBatchAge_) {
        vault = vault_;
        _from = from_;
        _to = to_;
        nextRate = rate_;
        minBatchAge = minBatchAge_;
        _batches[1].createdAt = block.timestamp;
    }

    function setNextRate(uint64 rate_) external {
        nextRate = rate_;
    }

    function setPaused(bool paused_) external {
        paused = paused_;
    }

    function join(address beneficiary, externalEuint64 encryptedAmount, bytes calldata inputProof) external returns (euint64) {
        if (paused) revert EnforcedPause();
        euint64 amount = inputProof.length == 0 ? euint64.wrap(externalEuint64.unwrap(encryptedAmount)) : FHE.fromExternal(encryptedAmount, inputProof);
        FHE.allowTransient(amount, address(_from));
        euint64 got = _from.confidentialTransferFrom(msg.sender, address(this), amount);
        uint256 batchId = currentBatchId;
        Batch storage b = _batches[batchId];
        euint64 had = deposits[batchId][beneficiary];
        euint64 now_ = FHE.isInitialized(had) ? FHE.add(had, got) : got;
        FHE.allowThis(now_);
        FHE.allow(now_, beneficiary);
        deposits[batchId][beneficiary] = now_;
        b.total = FHE.isInitialized(b.total) ? FHE.add(b.total, got) : got;
        FHE.allowThis(b.total);
        emit Joined(batchId, beneficiary, got);
        return got;
    }

    function dispatchBatch() external {
        if (paused) revert EnforcedPause();
        uint256 batchId = currentBatchId;
        Batch storage b = _batches[batchId];
        if (block.timestamp < b.createdAt + minBatchAge) revert BatchTooYoung(batchId);
        b.state = BatchState.Dispatched;
        if (FHE.isInitialized(b.total)) FHE.makePubliclyDecryptable(b.total);
        currentBatchId = batchId + 1;
        _batches[batchId + 1].createdAt = block.timestamp;
        emit BatchDispatched(batchId);
    }

    /// @notice Settles with the decrypted total and its proof: finalized at `nextRate`, or
    ///         canceled when nothing was joined.
    function dispatchBatchCallback(uint256 batchId, uint64 unwrapAmountCleartext, bytes calldata decryptionProof) external {
        Batch storage b = _batches[batchId];
        if (b.state != BatchState.Dispatched) revert BatchUnexpectedState(batchId, b.state);
        if (FHE.isInitialized(b.total)) {
            bytes32[] memory handles = new bytes32[](1);
            handles[0] = FHE.toBytes32(b.total);
            FHE.checkSignatures(handles, abi.encode(unwrapAmountCleartext), decryptionProof);
        }
        if (unwrapAmountCleartext == 0) {
            b.state = BatchState.Canceled;
            emit BatchCanceled(batchId);
            return;
        }
        b.rate = nextRate;
        b.state = BatchState.Finalized;
        emit BatchFinalized(batchId, b.rate);
    }

    /// @notice Test only: the vault refused the batch past its deadline.
    function cancel(uint256 batchId) external {
        Batch storage b = _batches[batchId];
        if (b.state == BatchState.Finalized) revert BatchUnexpectedState(batchId, b.state);
        if (b.state == BatchState.Pending) {
            currentBatchId = batchId + 1;
            _batches[batchId + 1].createdAt = block.timestamp;
        }
        b.state = BatchState.Canceled;
        emit BatchCanceled(batchId);
    }

    function claim(uint256 batchId, address account) external returns (euint64) {
        Batch storage b = _batches[batchId];
        if (b.state != BatchState.Finalized) revert BatchUnexpectedState(batchId, b.state);
        euint64 d = deposits[batchId][account];
        if (!FHE.isInitialized(d)) revert ZeroDeposits(batchId, account);
        deposits[batchId][account] = euint64.wrap(0);
        euint64 out = FHE.asEuint64(FHE.div(FHE.mul(FHE.asEuint128(d), uint128(b.rate)), 1_000_000));
        FHE.allowTransient(out, address(_to));
        euint64 paid = _to.confidentialTransfer(account, out);
        emit Claimed(batchId, account, paid);
        return paid;
    }

    function recover(uint256 batchId, address account) external returns (euint64) {
        Batch storage b = _batches[batchId];
        if (b.state != BatchState.Canceled) revert BatchUnexpectedState(batchId, b.state);
        euint64 d = deposits[batchId][account];
        if (!FHE.isInitialized(d)) revert ZeroDeposits(batchId, account);
        deposits[batchId][account] = euint64.wrap(0);
        FHE.allowTransient(d, address(_from));
        return _from.confidentialTransfer(account, d);
    }

    function fromToken() external view returns (address) {
        return address(_from);
    }

    function toToken() external view returns (address) {
        return address(_to);
    }

    function batchState(uint256 batchId) external view returns (uint8) {
        return uint8(_batches[batchId].state);
    }

    function exchangeRate(uint256 batchId) external view returns (uint64) {
        return _batches[batchId].rate;
    }

    function totalDeposits(uint256 batchId) external view returns (euint64) {
        return _batches[batchId].total;
    }

    function batchCreatedAt(uint256 batchId) external view returns (uint256) {
        return _batches[batchId].createdAt;
    }

    function batchMinBatchAge(uint256) external view returns (uint256) {
        return minBatchAge;
    }
}
