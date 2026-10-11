// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint64, euint128, euint256, externalEuint64, externalEuint256} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {SealedPockets} from "../SealedPockets.sol";
import {IVaultBatcher} from "./IVaultBatcher.sol";

/// @title The pockets' savings
/// @notice Puts a pocket's cUSDC to work in one of Zama's confidential vaults on Morpho, and
///         brings it back, without a wallet, an amount or a pocket ever showing. A pocket's holder
///         asks it with the pocket's key, as for a send: the amount leaves the pocket under
///         encryption and waits in the open window; anyone (the API's relayer, in practice) then
///         joins the window as one participant of the vault's next batch, and once Zama's batcher
///         has settled the batch, claims the shares and credits each pocket its part, computed
///         under encryption from the batch's public rate. The way back mirrors it through the
///         redeem batcher. Shares never leave this contract: a pocket's savings are an encrypted
///         share balance only its viewer reads.
///
/// @dev Design notes.
///
///  1. One participant for every pocket. The batcher sees this contract join with one encrypted
///     total per batch and side; inside, each pocket's part is a handle only its viewer reads.
///     A save names a set of pockets, the real one and decoys, like a send: the key's pocket is
///     debited, every other pocket of the set gets a zero commitment that looks the same.
///
///  2. Windows, not transactions. Saves and unsaves pile up in the open window of their side;
///     `join` sends the window's total to the current batch and opens the next window. One window
///     joins per batch and side, so a save is tied to a batch, never to a join of its own, and the
///     batch's total mixes this contract's part with the other participants'. Zama publishes the
///     participants and the decrypted total of each batch: the sum of every pocket's saves in a
///     window is what an observer can bound, never one pocket's.
///
///  3. Settling needs no decryption of ours. The batch's exchange rate is public (output per input,
///     times 1e6); each pocket's part is `committed * rate / 1e6`, computed on 128 bits so no
///     amount overflows. Rounding dust stays here, unowned. A canceled batch gives every pocket its
///     commitment back the same way.
///
///  4. Keys. A spend is asked with the pocket's key XOR `saveHash(...)`, the hash of the side, the
///     set and the amount's handle, so the relayer that sends it can change nothing and replay
///     nothing. The pockets check the key under encryption (`deskTake` for a save, `deskCheck`
///     for an unsave): a wrong key or a short balance commits zero, without a revert.
///
///  5. What is public: which sets saved or unsaved and in which window, when each window joined
///     and which batch it joined, each batch's rate, and (from the batcher) this contract's
///     address among the batch's participants and the batch's total. Never public: a pocket's
///     saved amount, its share balance, which pocket of a set moved, and who holds a pocket.
contract PocketSavings is ZamaEthereumConfig, ReentrancyGuard {
    /// @notice Save: cUSDC to shares, through the deposit batcher. Unsave: shares back to cUSDC.
    enum Side {
        Save,
        Unsave
    }

    enum WindowState {
        /// Taking saves (or unsaves).
        Open,
        /// Joined a batch, waiting for it to settle.
        Joined,
        /// The batch settled and the shares (or the cUSDC) were claimed: pockets can be settled.
        Settled,
        /// The batch was canceled and the commitments recovered: pockets get them back.
        Canceled
    }

    /// @dev A save's encrypted inputs: the amount in one input, the bound key in another (its
    ///      terms hash the first one's handle, so it is encrypted after it).
    struct SpendInput {
        externalEuint64 amount;
        bytes inputProof;
        externalEuint256 boundKey;
        bytes keyProof;
    }

    struct Window {
        Side side;
        WindowState state;
        /// The batch it joined, 0 until then.
        uint256 batchId;
        /// The batch's rate once settled: output per input, times 1e6.
        uint64 rate;
        uint256 openedAt;
        /// The pockets with a commitment in it, each once.
        uint256[] pockets;
        /// Pockets not settled yet.
        uint256 left;
        euint64 total;
    }

    /// @notice The rate's scale: one input unit gives `rate / RATE_ONE` output units.
    uint64 public constant RATE_ONE = 1_000_000;

    SealedPockets public immutable pockets;
    /// @notice cUSDC: the pockets' token, the deposit batcher's input and the redeem batcher's output.
    IERC7984 public immutable token;
    /// @notice The vault's confidential shares: the deposit batcher's output and the redeem batcher's input.
    IERC7984 public immutable share;
    IVaultBatcher public immutable depositBatcher;
    IVaultBatcher public immutable redeemBatcher;

    uint256 public windowCount;
    mapping(uint256 windowId => Window) private _windows;
    /// @notice The window taking saves (or unsaves) now, per side.
    mapping(Side => uint256) public openWindow;
    /// @notice The last batch a window of this side joined: one window per batch.
    mapping(Side => uint256) public lastBatch;
    /// @dev What each pocket committed to a window: cUSDC for a save, shares for an unsave.
    mapping(uint256 windowId => mapping(uint256 pocketId => euint64)) private _committed;
    /// @dev Each pocket's shares, readable by its viewer.
    mapping(uint256 pocketId => euint64) private _shares;
    /// @notice Bound keys already used: a relayed spend runs once.
    mapping(bytes32 handle => bool) public spent;

    error ZeroAddress();
    error WrongRoute();
    error NotAPocket(uint256 pocketId);
    error BadSet();
    error KeyUsed();
    error EmptyWindow();
    error BatchAlreadyJoined(uint256 batchId);
    error NoWindow(uint256 windowId);
    error WindowNotJoined(uint256 windowId);
    error BatchNotDone(uint256 windowId, uint8 state);
    error WindowNotSettled(uint256 windowId);
    error NotCommitted(uint256 windowId, uint256 pocketId);

    /// @notice A pocket of `from` may have put tokens aside in `windowId`.
    event Saved(uint256 indexed windowId, uint256[] from);
    /// @notice A pocket of `from` may have asked its savings back in `windowId`.
    event Unsaved(uint256 indexed windowId, uint256[] from);
    event WindowOpened(uint256 indexed windowId, Side side);
    event WindowJoined(uint256 indexed windowId, uint256 indexed batchId);
    /// @notice The window's batch settled (`Settled`, at `rate`) or was canceled.
    event WindowSettled(uint256 indexed windowId, WindowState state, uint64 rate);
    /// @notice `pocketId` got its part of `windowId`: shares, or cUSDC back in the pocket.
    event PocketSettled(uint256 indexed windowId, uint256 indexed pocketId);

    constructor(SealedPockets pockets_, IVaultBatcher depositBatcher_, IVaultBatcher redeemBatcher_) {
        if (address(pockets_) == address(0) || address(depositBatcher_) == address(0) || address(redeemBatcher_) == address(0)) revert ZeroAddress();
        pockets = pockets_;
        token = pockets_.token();
        depositBatcher = depositBatcher_;
        redeemBatcher = redeemBatcher_;
        share = IERC7984(depositBatcher_.toToken());
        if (depositBatcher_.fromToken() != address(token) || redeemBatcher_.fromToken() != address(share) || redeemBatcher_.toToken() != address(token)) {
            revert WrongRoute();
        }
        // The batchers pull what a window joins with.
        token.setOperator(address(depositBatcher_), type(uint48).max);
        share.setOperator(address(redeemBatcher_), type(uint48).max);
        _open(Side.Save);
        _open(Side.Unsave);
    }

    // ----------------------------------------------------------------- spends

    /// @notice Puts `s.amount` cUSDC of the pocket of `from` whose key matches aside, into the open
    ///         save window. `s.boundKey` is the key XOR `saveHash(Save, from, amount)`, in its own
    ///         input. A wrong key or a short balance puts nothing aside, without a revert.
    function save(uint256[] calldata from, SpendInput calldata s) external nonReentrant {
        _checkSet(from);
        euint256 k = _key(s, saveHash(Side.Save, from, externalEuint64.unwrap(s.amount)));
        euint64 a = FHE.fromExternal(s.amount, s.inputProof);
        uint256 windowId = openWindow[Side.Save];
        FHE.allowTransient(k, address(pockets));
        FHE.allowTransient(a, address(pockets));
        euint64 total = FHE.asEuint64(0);
        for (uint256 i = 0; i < from.length; i++) {
            euint64 taken = pockets.deskTake(from[i], k, a);
            _commit(windowId, from[i], taken);
            total = FHE.add(total, taken);
        }
        _addTotal(windowId, total);
        emit Saved(windowId, from);
    }

    /// @notice Asks `s.amount` shares of the pocket of `from` whose key matches back, into the
    ///         open unsave window. `s.boundKey` is the key XOR `saveHash(Unsave, from, amount)`.
    ///         A wrong key or a short share balance asks nothing, without a revert.
    function unsave(uint256[] calldata from, SpendInput calldata s) external nonReentrant {
        _checkSet(from);
        euint256 k = _key(s, saveHash(Side.Unsave, from, externalEuint64.unwrap(s.amount)));
        euint64 a = FHE.fromExternal(s.amount, s.inputProof);
        uint256 windowId = openWindow[Side.Unsave];
        euint64 zero = FHE.asEuint64(0);
        FHE.allowTransient(k, address(pockets));
        FHE.allowTransient(zero, address(pockets));
        euint64 total = zero;
        for (uint256 i = 0; i < from.length; i++) {
            euint64 held = _sharesOf(from[i]);
            ebool ok = FHE.and(pockets.deskCheck(from[i], k, zero), FHE.ge(held, a));
            euint64 d = FHE.select(ok, a, zero);
            _setShares(from[i], FHE.sub(held, d));
            _commit(windowId, from[i], d);
            total = FHE.add(total, d);
        }
        _addTotal(windowId, total);
        emit Unsaved(windowId, from);
    }

    // ---------------------------------------------------------------- windows

    /// @notice Joins the open window of `side` to the batcher's current batch, as this contract,
    ///         and opens the next window. Anyone may send it, once per batch: the relayer does,
    ///         shortly before the batch can be dispatched, when it holds the most participants.
    function join(Side side) external nonReentrant {
        uint256 windowId = openWindow[side];
        Window storage w = _windows[windowId];
        if (w.pockets.length == 0) revert EmptyWindow();
        IVaultBatcher batcher = _batcher(side);
        uint256 batchId = batcher.currentBatchId();
        if (lastBatch[side] == batchId) revert BatchAlreadyJoined(batchId);
        lastBatch[side] = batchId;
        w.batchId = batchId;
        w.state = WindowState.Joined;
        FHE.allowTransient(w.total, address(batcher));
        batcher.join(address(this), externalEuint64.wrap(euint64.unwrap(w.total)), "");
        _open(side);
        emit WindowJoined(windowId, batchId);
    }

    /// @notice Once the window's batch is finalized, claims what it gave; once canceled, recovers
    ///         what it took. Anyone may send it. The pockets are settled next, with `settlePockets`.
    function settle(uint256 windowId) external nonReentrant {
        Window storage w = _window(windowId);
        if (w.state != WindowState.Joined) revert WindowNotJoined(windowId);
        IVaultBatcher batcher = _batcher(w.side);
        uint8 state = batcher.batchState(w.batchId);
        if (state == uint8(IVaultBatcher.BatchState.Finalized)) {
            batcher.claim(w.batchId, address(this));
            w.rate = batcher.exchangeRate(w.batchId);
            w.state = WindowState.Settled;
        } else if (state == uint8(IVaultBatcher.BatchState.Canceled)) {
            batcher.recover(w.batchId, address(this));
            w.state = WindowState.Canceled;
        } else {
            revert BatchNotDone(windowId, state);
        }
        w.left = w.pockets.length;
        emit WindowSettled(windowId, w.state, w.rate);
    }

    /// @notice Gives each of `ids` its part of a settled window: shares for a save, cUSDC back in
    ///         the pocket for an unsave, or its commitment back when the batch was canceled. Anyone
    ///         may send it, for any pockets of the window, each once; the relayer settles them all,
    ///         a few per transaction (each costs FHE compute), decoys included: a pocket settled
    ///         alone would be the one that moved.
    function settlePockets(uint256 windowId, uint256[] calldata ids) external nonReentrant {
        Window storage w = _window(windowId);
        if (w.state != WindowState.Settled && w.state != WindowState.Canceled) revert WindowNotSettled(windowId);
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 pocketId = ids[i];
            euint64 committed = _committed[windowId][pocketId];
            if (!FHE.isInitialized(committed)) revert NotCommitted(windowId, pocketId);
            _committed[windowId][pocketId] = euint64.wrap(0);
            w.left--;
            if (w.state == WindowState.Settled) {
                euint64 out = _convert(committed, w.rate);
                if (w.side == Side.Save) _setShares(pocketId, FHE.add(_sharesOf(pocketId), out));
                else _giveBack(pocketId, out);
            } else {
                if (w.side == Side.Save) _giveBack(pocketId, committed);
                else _setShares(pocketId, FHE.add(_sharesOf(pocketId), committed));
            }
            emit PocketSettled(windowId, pocketId);
        }
    }

    // ------------------------------------------------------------------ views

    /// @notice What a spend's key is bound to: the holder sends key XOR this.
    function saveHash(Side side, uint256[] memory from, bytes32 amount) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), side, from, amount)));
    }

    /// @notice The pocket's shares: only its viewer can decrypt it. A zero handle is no shares.
    function sharesOf(uint256 pocketId) external view returns (euint64) {
        return _shares[pocketId];
    }

    /// @notice What the pocket committed to a window and has not been settled for: only its viewer
    ///         can decrypt it. A zero handle is nothing.
    function committedOf(uint256 windowId, uint256 pocketId) external view returns (euint64) {
        return _committed[windowId][pocketId];
    }

    function windowInfo(uint256 windowId)
        external
        view
        returns (Side side, WindowState state, uint256 batchId, uint64 rate, uint256 openedAt, uint256 pocketCount, uint256 left)
    {
        Window storage w = _window(windowId);
        return (w.side, w.state, w.batchId, w.rate, w.openedAt, w.pockets.length, w.left);
    }

    /// @notice The pockets with a commitment in the window, in the order they came.
    function windowPockets(uint256 windowId) external view returns (uint256[] memory) {
        return _window(windowId).pockets;
    }

    // -------------------------------------------------------------- internals

    function _batcher(Side side) private view returns (IVaultBatcher) {
        return side == Side.Save ? depositBatcher : redeemBatcher;
    }

    function _window(uint256 windowId) private view returns (Window storage w) {
        if (windowId >= windowCount) revert NoWindow(windowId);
        return _windows[windowId];
    }

    function _open(Side side) private {
        uint256 windowId = windowCount++;
        Window storage w = _windows[windowId];
        w.side = side;
        w.openedAt = block.timestamp;
        openWindow[side] = windowId;
        emit WindowOpened(windowId, side);
    }

    /// @dev Strictly increasing pocket numbers, 1 to MAX_SET of them, all opened (as the pockets check).
    function _checkSet(uint256[] memory set) private view {
        uint256 count = pockets.pocketCount();
        if (set.length == 0 || set.length > pockets.MAX_SET()) revert BadSet();
        for (uint256 i = 0; i < set.length; i++) {
            if (set[i] >= count) revert NotAPocket(set[i]);
            if (i > 0 && set[i] <= set[i - 1]) revert BadSet();
        }
    }

    /// @dev The key from a bound key, which then can never be used again.
    function _key(SpendInput calldata s, uint256 terms) private returns (euint256) {
        bytes32 h = externalEuint256.unwrap(s.boundKey);
        if (spent[h]) revert KeyUsed();
        spent[h] = true;
        return FHE.xor(FHE.fromExternal(s.boundKey, s.keyProof), terms);
    }

    /// @dev Adds `amount` to what `pocketId` committed to the window; lists the pocket the first time.
    function _commit(uint256 windowId, uint256 pocketId, euint64 amount) private {
        euint64 had = _committed[windowId][pocketId];
        euint64 now_ = amount;
        if (FHE.isInitialized(had)) now_ = FHE.add(had, amount);
        else _windows[windowId].pockets.push(pocketId);
        FHE.allowThis(now_);
        FHE.allow(now_, pockets.viewerOf(pocketId));
        _committed[windowId][pocketId] = now_;
    }

    function _addTotal(uint256 windowId, euint64 amount) private {
        Window storage w = _windows[windowId];
        euint64 total = FHE.isInitialized(w.total) ? FHE.add(w.total, amount) : amount;
        FHE.allowThis(total);
        w.total = total;
    }

    /// @dev `amount * rate / 1e6`, on 128 bits so nothing overflows, rounded down.
    function _convert(euint64 amount, uint64 rate) private returns (euint64) {
        return FHE.asEuint64(FHE.div(FHE.mul(FHE.asEuint128(amount), uint128(rate)), uint128(RATE_ONE)));
    }

    function _sharesOf(uint256 pocketId) private returns (euint64) {
        euint64 s = _shares[pocketId];
        return FHE.isInitialized(s) ? s : FHE.asEuint64(0);
    }

    function _setShares(uint256 pocketId, euint64 shares) private {
        FHE.allowThis(shares);
        FHE.allow(shares, pockets.viewerOf(pocketId));
        _shares[pocketId] = shares;
    }

    /// @dev Pays `amount` cUSDC back into the pocket: the tokens first, then the balance.
    function _giveBack(uint256 pocketId, euint64 amount) private {
        FHE.allowTransient(amount, address(token));
        euint64 sent = token.confidentialTransfer(address(pockets), amount);
        FHE.allowTransient(sent, address(pockets));
        pockets.deskGive(pocketId, sent);
    }
}
