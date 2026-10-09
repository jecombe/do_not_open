// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint32, euint64, euint256, externalEuint32, externalEuint64, externalEuint256} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/// @title The sealed vault's pockets
/// @notice Confidential tokens (cUSDC) held in pockets nobody can tie to a wallet. A pocket is a
///         balance locked by a key, not by an address: its balance is encrypted, and so are who
///         pays whom and how much. Anyone puts tokens in a pocket from a wallet; the pocket's
///         holder sends them to another pocket, or takes them out to any address, with the key.
///
/// @dev Design notes.
///
///  1. ERC-7984 tokens already hide balances and amounts, but every transfer names its sender and
///     its receiver. Here the address graph goes too: a pocket is a number with an encrypted
///     256-bit key, an encrypted balance and a `viewer`, an address the holder's page derives from
///     the same signature as the key, used only to read the balance (user decryption). Nothing
///     on-chain ties the viewer to the holder's wallet.
///
///  2. Every action names a set of pockets, not one: the real one and decoys (existing pockets the
///     page picks at random). Sending debits the set's pocket whose key matches, credits the
///     receiving set's pocket whose number matches an encrypted target, and gives every other
///     pocket of both sets a new handle for the same balance. Everyone sees which pockets were
///     named; nobody sees which ones moved, nor by how much.
///
///  3. A spend is asked with the key XOR `spendHash(...)`, the hash of the action, both sets, the
///     destination and the handles of the encrypted amount and target. A relayer (or any wallet)
///     sends it: it can neither change a term (the key would not match) nor send it twice (each
///     bound key's handle is spent once). A wrong key, a short balance or a target missing from
///     the receiving set moves nothing, without a revert: to everyone else, a spend that moved
///     and one that did not look the same. No decryption is needed, so nothing waits for a proof.
///
///  4. `desk` (`PocketDesk`) pays and is paid for the sealed vault's private sales out of pockets,
///     through `deskTake` and `deskGive`; it is the only other contract allowed to move a balance.
///
///  5. What is public: which wallet deposited into which set of pockets (not the amount when it
///     comes as cUSDC from a confidential balance), which sets each spend named, the address a
///     withdrawal went to, each pocket's viewer, and who sent each transaction. Never public: a
///     balance, an amount, which pocket of a set moved, and who holds a pocket.
contract SealedPockets is ZamaEthereumConfig, Ownable, ReentrancyGuard {
    enum Spend {
        Send,
        Withdraw
    }

    /// @dev A spend's encrypted inputs: the amount and the target in one input, the bound key in
    ///      another (its terms hash the first one's handles, so it is encrypted after them).
    struct SpendInput {
        externalEuint64 amount;
        externalEuint32 target;
        bytes inputProof;
        externalEuint256 boundKey;
        bytes keyProof;
    }

    struct Pocket {
        euint256 key;
        euint64 balance;
        /// Reads the balance (user decryption): an address the holder's page derives, no wallet's.
        address viewer;
    }

    /// @notice The most pockets one side of an action may name, the real one included.
    uint256 public constant MAX_SET = 5;

    IERC7984 public immutable token;
    /// @notice Pays and is paid for the vault's private sales out of pockets. Set once.
    address public desk;

    uint256 public pocketCount;
    mapping(uint256 pocketId => Pocket) private _pockets;
    /// @notice The pocket a viewer reads, + 1: how a page finds its pocket again on any device.
    mapping(address viewer => uint256 pocketIdPlusOne) public pocketOf;
    /// @notice Bound keys already used: a relayed spend runs once.
    mapping(bytes32 handle => bool) public spent;

    error ZeroAddress();
    error ViewerTaken(address viewer);
    error NotAPocket(uint256 pocketId);
    error BadSet();
    error KeyUsed();
    error OnlyDesk();
    error DeskSet();

    event Opened(uint256 indexed pocketId, address indexed viewer);
    /// @notice `from` put tokens in one of `pockets`; which one, and how much, is encrypted.
    event Deposited(address indexed from, uint256[] pockets);
    /// @notice A pocket of `from` may have paid a pocket of `to`.
    event Sent(uint256[] from, uint256[] to);
    /// @notice A pocket of `from` may have paid `to`.
    event Withdrawn(uint256[] from, address indexed to);
    event DeskSetTo(address desk);

    constructor(IERC7984 token_, address owner_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Opens a pocket locked by `key` (encrypted for this contract), whose balance `viewer`
    ///         reads. Anyone may send it: a relayer keeps the holder's wallet out of it.
    function open(externalEuint256 key, bytes calldata inputProof, address viewer) external returns (uint256 pocketId) {
        if (viewer == address(0)) revert ZeroAddress();
        if (pocketOf[viewer] != 0) revert ViewerTaken(viewer);
        pocketId = pocketCount++;
        Pocket storage p = _pockets[pocketId];
        p.key = FHE.fromExternal(key, inputProof);
        p.viewer = viewer;
        FHE.allowThis(p.key);
        _setBalance(p, FHE.asEuint64(0));
        pocketOf[viewer] = pocketId + 1;
        emit Opened(pocketId, viewer);
    }

    /// @notice Pulls `amount` of the caller's tokens (this contract must be their operator) into
    ///         the pocket of `pockets` whose number is `target`, both encrypted. The others are
    ///         decoys. A target outside the set gets nothing, and the tokens go back.
    function deposit(uint256[] calldata pockets, externalEuint32 target, externalEuint64 amount, bytes calldata inputProof)
        external
        nonReentrant
    {
        _checkSet(pockets);
        euint32 t = FHE.fromExternal(target, inputProof);
        euint64 a = FHE.fromExternal(amount, inputProof);
        FHE.allowTransient(a, address(token));
        euint64 pulled = token.confidentialTransferFrom(msg.sender, address(this), a);
        euint64 left = _credit(pockets, t, pulled);
        _pay(msg.sender, left);
        emit Deposited(msg.sender, pockets);
    }

    /// @notice Sends `s.amount` from the pocket of `from` whose key matches to the pocket of `to`
    ///         whose number is `s.target`. `s.boundKey` is the key XOR `spendHash(Send, from, to,
    ///         0, amount, target)`, in its own input. Nothing moves unless the key matches, the
    ///         balance covers it and the target is in `to`.
    function send(uint256[] calldata from, uint256[] calldata to, SpendInput calldata s) external {
        _checkSet(from);
        _checkSet(to);
        euint256 k = _key(s, spendHash(Spend.Send, from, to, address(0), externalEuint64.unwrap(s.amount), externalEuint32.unwrap(s.target)));
        euint32 t = FHE.fromExternal(s.target, s.inputProof);
        _credit(to, t, _debit(from, k, FHE.fromExternal(s.amount, s.inputProof), _inSet(to, t)));
        emit Sent(from, to);
    }

    /// @notice Takes `s.amount` out of the pocket of `from` whose key matches, to `to`, as the
    ///         token itself (still confidential). `s.boundKey` is the key XOR `spendHash(Withdraw,
    ///         from, [], to, amount, 0)`; `s.target` is not read.
    function withdraw(uint256[] calldata from, address to, SpendInput calldata s) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _checkSet(from);
        uint256[] memory none;
        euint256 k = _key(s, spendHash(Spend.Withdraw, from, none, to, externalEuint64.unwrap(s.amount), bytes32(0)));
        _pay(to, _debit(from, k, FHE.fromExternal(s.amount, s.inputProof), FHE.asEbool(true)));
        emit Withdrawn(from, to);
    }

    // ------------------------------------------------------------------- desk

    /// @notice The desk takes `amount` out of `pocketId` if `key` is its key and the balance
    ///         covers it, nothing otherwise, and receives what it took.
    function deskTake(uint256 pocketId, euint256 key, euint64 amount) external returns (euint64 taken) {
        if (msg.sender != desk) revert OnlyDesk();
        Pocket storage p = _pocket(pocketId);
        ebool ok = FHE.and(FHE.eq(key, p.key), FHE.ge(p.balance, amount));
        taken = FHE.select(ok, amount, FHE.asEuint64(0));
        _setBalance(p, FHE.sub(p.balance, taken));
        _pay(msg.sender, taken);
        FHE.allowTransient(taken, msg.sender);
    }

    /// @notice Whether `key` is `pocketId`'s key and its balance covers `amount`, for the desk to
    ///         make public before a purchase.
    function deskCheck(uint256 pocketId, euint256 key, euint64 amount) external returns (ebool ok) {
        if (msg.sender != desk) revert OnlyDesk();
        Pocket storage p = _pocket(pocketId);
        ok = FHE.and(FHE.eq(key, p.key), FHE.ge(p.balance, amount));
        FHE.allowTransient(ok, msg.sender);
    }

    /// @notice The desk pays `amount` into `pocketId`: it sends the tokens first.
    function deskGive(uint256 pocketId, euint64 amount) external {
        if (msg.sender != desk) revert OnlyDesk();
        Pocket storage p = _pocket(pocketId);
        _setBalance(p, FHE.add(p.balance, amount));
    }

    function setDesk(address desk_) external onlyOwner {
        if (desk != address(0)) revert DeskSet();
        if (desk_ == address(0)) revert ZeroAddress();
        desk = desk_;
        emit DeskSetTo(desk_);
    }

    // ------------------------------------------------------------------ views

    /// @notice What a spend's key is bound to: the holder sends key XOR this.
    function spendHash(Spend action, uint256[] memory from, uint256[] memory to, address dest, bytes32 amount, bytes32 target)
        public
        view
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(block.chainid, address(this), action, from, to, dest, amount, target)));
    }

    /// @notice The pocket's balance handle: only its viewer can decrypt it.
    function balanceOf(uint256 pocketId) external view returns (euint64) {
        return _pocket(pocketId).balance;
    }

    function viewerOf(uint256 pocketId) external view returns (address) {
        return _pocket(pocketId).viewer;
    }

    // -------------------------------------------------------------- internals

    function _pocket(uint256 pocketId) private view returns (Pocket storage p) {
        if (pocketId >= pocketCount) revert NotAPocket(pocketId);
        return _pockets[pocketId];
    }

    /// @dev Strictly increasing pocket numbers, 1 to MAX_SET of them, all opened: a pocket named
    ///      twice would be paid twice.
    function _checkSet(uint256[] memory set) private view {
        if (set.length == 0 || set.length > MAX_SET) revert BadSet();
        for (uint256 i = 0; i < set.length; i++) {
            if (set[i] >= pocketCount) revert NotAPocket(set[i]);
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

    /// @dev True when `target` is one of `set`.
    function _inSet(uint256[] memory set, euint32 target) private returns (ebool hit) {
        hit = FHE.eq(target, uint32(set[0]));
        for (uint256 i = 1; i < set.length; i++) hit = FHE.or(hit, FHE.eq(target, uint32(set[i])));
    }

    /// @dev Takes `amount` from the pocket of `set` whose key is `key`, if `go` and its balance
    ///      covers it. Returns what was taken: `amount` or 0.
    function _debit(uint256[] memory set, euint256 key, euint64 amount, ebool go) private returns (euint64 taken) {
        euint64 zero = FHE.asEuint64(0);
        taken = zero;
        for (uint256 i = 0; i < set.length; i++) {
            Pocket storage p = _pockets[set[i]];
            ebool ok = FHE.and(FHE.and(FHE.eq(key, p.key), FHE.ge(p.balance, amount)), go);
            euint64 d = FHE.select(ok, amount, zero);
            _setBalance(p, FHE.sub(p.balance, d));
            taken = FHE.add(taken, d);
        }
    }

    /// @dev Pays `amount` into the pocket of `set` numbered `target`. Returns what found no pocket.
    function _credit(uint256[] memory set, euint32 target, euint64 amount) private returns (euint64 left) {
        euint64 zero = FHE.asEuint64(0);
        left = amount;
        for (uint256 i = 0; i < set.length; i++) {
            Pocket storage p = _pockets[set[i]];
            euint64 c = FHE.select(FHE.eq(target, uint32(set[i])), amount, zero);
            _setBalance(p, FHE.add(p.balance, c));
            left = FHE.sub(left, c);
        }
    }

    function _setBalance(Pocket storage p, euint64 balance) private {
        p.balance = balance;
        FHE.allowThis(balance);
        FHE.allow(balance, p.viewer);
    }

    function _pay(address to, euint64 amount) private {
        FHE.allowTransient(amount, address(token));
        token.confidentialTransfer(to, amount);
    }
}
