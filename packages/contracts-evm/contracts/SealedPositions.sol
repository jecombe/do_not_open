// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint32, euint64, euint256, externalEuint32, externalEuint64, externalEuint256} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SealedPockets} from "./SealedPockets.sol";
import {IConfidentialWrapper} from "./vault/IConfidentialWrapper.sol";
import {IPositionManager} from "./vault/IPositionManager.sol";

/// @title The sealed vault's liquidity positions
/// @notice Uniswap V3 positions nobody can tie to a wallet. A position is opened with tokens out
///         of the vault's pockets, held by this contract, steered by an address its holder's page
///         derives from one signature (its controller, which never holds ETH nor sends a
///         transaction), and pays its fees and its liquidity back into pockets. Everything a
///         position does on Uniswap is public, as any position's is; who it belongs to is not.
///
/// @dev Design notes.
///
///  1. Funding comes from two pockets, one per token, through the pockets' desk calls: `open` (or
///     `add`, for more liquidity) names a set of pockets on each side (the real one and decoys),
///     the encrypted amounts, and each pocket's key XOR `openHash(...)` (`addHash`), the hash of
///     every term: the controller, the pool and range, both sets, the handles of the amounts and
///     of where leftovers go, the slippage limits and the deadline. A relayer can neither change a
///     term (the keys would not match) nor send it twice (each bound key's handle is spent once).
///     Both sides are taken or neither: a wrong key or a short pocket on one side gives the other
///     side back under encryption, and the funding settles with nothing.
///
///  2. Uniswap needs plain ERC-20s, so the confidential tokens taken are unwrapped: the amounts
///     become public there, as every position's amounts are on Uniswap. The unwrap waits for
///     Zama's public decryption; `settle` (anyone may send it, with the KMS's proofs) receives the
///     ERC-20s and mints the position (or adds to it). Whatever Uniswap did not use goes back,
///     wrapped again, into the pocket of each set an encrypted target names. A mint Uniswap
///     refuses (the price left the slippage limits, the deadline passed) gives everything back
///     the same way: a settle never reverts on Uniswap's account, so no funding is ever stuck.
///
///  3. A position's holder acts on it by signing with its controller (EIP-712: the position, the
///     action, the action's terms, a nonce and a deadline); a relayer, or any wallet, sends it.
///     The controller is an address the page derives from the wallet's signature and the
///     position's number in the wallet's list, so nothing ties two positions of one wallet
///     together, nor any of them to the wallet. No decryption is needed to decide an action:
///     what a position does on Uniswap is public anyway, so a signature, checked in the clear,
///     says as little as an encrypted key would, without waiting for the KMS.
///
///  4. Fees and liquidity come out into pockets: `collect` and `decrease` name a set of pockets
///     per token and an encrypted target in each; the tokens are wrapped and credited to the
///     target's pocket under encryption. `feeBps` of the trading fees (never of the liquidity)
///     goes to the treasury, in the clear, as Uniswap's amounts are. Taking all the liquidity out
///     closes the position (the Uniswap NFT is burnt). `give` hands a position to another
///     holder's controller; `takeOut` sends the Uniswap NFT to any address, out of this contract.
///
///  5. An existing Uniswap position can come in (`safeTransferFrom` with the controller as data):
///     the deposit names the wallet that sent it, as the vault's deposits do.
///
///  6. What is public: each position's pool, range, liquidity, amounts and fees (Uniswap's),
///     which sets of pockets funded it and were paid, the controller (an address tied to
///     nothing), a deposit's sender, a take-out's address, and who sent each transaction (the
///     relayer). Never public: which pocket of a set paid or was paid, who holds a position, and
///     which positions belong to the same holder. Funding both sides at once does say that one
///     pocket of each set belongs to the same holder.
contract SealedPositions is ZamaEthereumConfig, Ownable, ReentrancyGuard, EIP712, IERC721Receiver {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        /// Its funding waits for its proofs.
        Funding,
        Open,
        /// All its liquidity came out: the Uniswap NFT is burnt.
        Closed,
        /// Its funding came to nothing (a wrong key, a short pocket, a mint Uniswap refused).
        Failed,
        /// The Uniswap NFT was taken out of this contract.
        Out
    }

    enum FundingStatus {
        None,
        Pending,
        /// The liquidity went in; the leftovers went back.
        Done,
        /// Nothing went in; everything went back.
        Refunded
    }

    enum Action {
        Collect,
        Decrease,
        Give,
        TakeOut
    }

    /// @dev A token positions take: its pockets and its confidential wrapper.
    struct Side {
        SealedPockets pockets;
        IConfidentialWrapper token;
        /// Plain units of the ERC-20 per confidential unit.
        uint256 rate;
    }

    /// @notice A pool and a price range, as Uniswap V3 names them (token0 below token1).
    struct Range {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
    }

    /// @notice What funds a position, out of pockets: a set per side, the encrypted amounts (in the
    ///         confidential tokens' units) and the encrypted pocket of each set that gets the
    ///         leftovers back, in one input; Uniswap's slippage limits and deadline.
    struct Funds {
        uint256[] set0;
        uint256[] set1;
        externalEuint64 amount0;
        externalEuint64 amount1;
        externalEuint32 target0;
        externalEuint32 target1;
        bytes inputProof;
        /// In the ERC-20s' own units, as Uniswap reads them.
        uint256 amount0Min;
        uint256 amount1Min;
        uint64 deadline;
    }

    /// @notice Each side's pocket key XOR the funding's hash, encrypted after `Funds`.
    struct Keys {
        externalEuint256 boundKey0;
        externalEuint256 boundKey1;
        bytes keyProof;
    }

    /// @notice Where tokens coming out go: a set of pockets per side and the encrypted target in each.
    struct Out {
        uint256[] set0;
        uint256[] set1;
        externalEuint32 target0;
        externalEuint32 target1;
        bytes inputProof;
    }

    struct Position {
        /// Signs its holder's actions: an address derived by the holder's page, tied to no wallet.
        address controller;
        uint64 nonce;
        Status status;
        /// Uniswap's NFT, 0 until the first funding settles.
        uint256 tokenId;
        Range range;
    }

    struct Funding {
        uint256 positionId;
        /// The two unwraps' request ids: the handles of what was taken, publicly decryptable.
        bytes32 unwrap0;
        bytes32 unwrap1;
        euint32 target0;
        euint32 target1;
        uint256 amount0Min;
        uint256 amount1Min;
        uint64 deadline;
        FundingStatus status;
        uint256[] set0;
        uint256[] set1;
    }

    bytes32 private constant ACT_TYPEHASH = keccak256("Act(uint256 positionId,uint8 action,bytes32 terms,uint64 nonce,uint64 deadline)");
    /// @notice At most 10% of the trading fees.
    uint16 public constant MAX_FEE_BPS = 1000;
    uint8 private constant OPEN = 0;
    uint8 private constant ADD = 1;

    IPositionManager public immutable positionManager;
    /// @notice Where the share of trading fees goes.
    address public treasury;
    /// @notice The share of each collect's trading fees kept, in basis points.
    uint16 public feeBps;

    mapping(address underlying => Side) private _sides;
    address[] private _underlyings;

    uint256 public positionCount;
    mapping(uint256 positionId => Position) private _positions;
    /// @notice The position a controller steers, + 1: how a page finds its positions on any device.
    mapping(address controller => uint256 positionIdPlusOne) public positionOf;
    /// @notice Controllers ever used: each steers one position, once.
    mapping(address controller => bool) public controllerUsed;

    uint256 public fundingCount;
    mapping(uint256 fundingId => Funding) private _fundings;
    /// @notice Bound keys already used: a relayed funding runs once.
    mapping(bytes32 handle => bool) public spent;

    error ZeroAddress();
    error NotATokenHere(address token);
    error SideSet(address token);
    error BadRange();
    error ControllerUsed(address controller);
    error NotOpen(uint256 positionId);
    error NotAPosition(uint256 positionId);
    error FundingNotPending(uint256 fundingId);
    error NotController();
    error Expired();
    error KeyUsed();
    error FeeTooHigh();
    error NotPositionManager();

    event PocketsAdded(address indexed token, address pockets);
    event Opened(uint256 indexed positionId, address indexed controller, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper);
    /// @notice A pocket of each set may have paid `fundingId`; how much is public once it settles.
    event Funded(uint256 indexed fundingId, uint256 indexed positionId, uint256[] set0, uint256[] set1);
    /// @notice `amount0` and `amount1` went into Uniswap (0 when `ok` is false); the rest went back.
    event Settled(uint256 indexed fundingId, uint256 indexed positionId, bool ok, uint256 amount0, uint256 amount1, uint128 liquidity);
    event Deposited(uint256 indexed positionId, address indexed from, uint256 tokenId);
    /// @notice Trading fees came out: `fee0` and `fee1` to the treasury, the rest to a pocket of each set.
    event Collected(uint256 indexed positionId, uint256 amount0, uint256 amount1, uint256 fee0, uint256 fee1, uint256[] set0, uint256[] set1);
    /// @notice `liquidity` came out as `amount0` and `amount1`, to a pocket of each set.
    event Decreased(uint256 indexed positionId, uint128 liquidity, uint256 amount0, uint256 amount1, uint256[] set0, uint256[] set1);
    event Closed(uint256 indexed positionId);
    event Given(uint256 indexed positionId, address indexed controller);
    event TakenOut(uint256 indexed positionId, address indexed to);
    event FeeSet(uint16 feeBps);
    event TreasurySet(address treasury);

    constructor(IPositionManager positionManager_, address treasury_, address owner_, uint16 feeBps_)
        Ownable(owner_)
        EIP712("DO NOT OPEN Positions", "1")
    {
        if (address(positionManager_) == address(0)) revert ZeroAddress();
        positionManager = positionManager_;
        _setTreasury(treasury_);
        _setFee(feeBps_);
    }

    // ---------------------------------------------------------------- funding

    /// @notice Opens a position on `r` steered by `controller` (a fresh address), funded out of
    ///         pockets. Anyone may send it: a relayer keeps the holder's wallet out of it. The
    ///         position opens when `settle` brings the unwraps' proofs.
    function open(Range calldata r, address controller, Funds calldata f, Keys calldata k)
        external
        nonReentrant
        returns (uint256 positionId, uint256 fundingId)
    {
        if (r.token0 >= r.token1 || r.tickLower >= r.tickUpper) revert BadRange();
        _side(r.token0);
        _side(r.token1);
        uint256 terms = openHash(controller, r, f);
        _claim(controller);
        positionId = positionCount++;
        Position storage p = _positions[positionId];
        p.controller = controller;
        p.status = Status.Funding;
        p.range = r;
        positionOf[controller] = positionId + 1;
        emit Opened(positionId, controller, r.token0, r.token1, r.fee, r.tickLower, r.tickUpper);
        fundingId = _fund(positionId, r, f, k, terms);
    }

    /// @notice Adds liquidity to an open position, out of pockets: anyone's, as anyone may give.
    function add(uint256 positionId, Funds calldata f, Keys calldata k) external nonReentrant returns (uint256 fundingId) {
        Position storage p = _open(positionId);
        fundingId = _fund(positionId, p.range, f, k, addHash(positionId, f));
    }

    /// @notice Brings the unwraps' proofs (one per side: `publicDecrypt` of `fundingInfo`'s
    ///         `unwrap0` and `unwrap1`), receives the ERC-20s and puts them in Uniswap, or gives
    ///         them back. Anyone may send it.
    function settle(uint256 fundingId, uint64 clear0, bytes calldata proof0, uint64 clear1, bytes calldata proof1) external nonReentrant {
        Funding storage fd = _fundings[fundingId];
        if (fd.status != FundingStatus.Pending) revert FundingNotPending(fundingId);
        Position storage p = _positions[fd.positionId];
        uint256 in0 = _receive(_sides[p.range.token0], fd.unwrap0, clear0, proof0);
        uint256 in1 = _receive(_sides[p.range.token1], fd.unwrap1, clear1, proof1);
        _settle(fundingId, fd, p, in0, in1);
    }

    // ---------------------------------------------------------------- holders

    /// @notice Sends the position's trading fees to `o`'s pockets, `feeBps` to the treasury.
    function collect(uint256 positionId, Out calldata o, uint64 deadline, bytes calldata signature) external nonReentrant {
        Position storage p = _open(positionId);
        _authorize(positionId, p, Action.Collect, outHash(o), deadline, signature);
        (uint256 net0, uint256 net1) = _collectFees(positionId, p, o);
        _payOut(p, o, net0, net1);
    }

    /// @notice Takes `liquidity` out (and the fees earned so far) into `o`'s pockets. All of it
    ///         closes the position.
    function decrease(uint256 positionId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, Out calldata o, uint64 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        Position storage p = _open(positionId);
        _authorize(positionId, p, Action.Decrease, keccak256(abi.encode(liquidity, amount0Min, amount1Min, outHash(o))), deadline, signature);
        (uint256 net0, uint256 net1) = _collectFees(positionId, p, o);
        positionManager.decreaseLiquidity(IPositionManager.DecreaseLiquidityParams(p.tokenId, liquidity, amount0Min, amount1Min, deadline));
        (uint256 c0, uint256 c1) = _collect(p.tokenId);
        _payOut(p, o, net0 + c0, net1 + c1);
        emit Decreased(positionId, liquidity, c0, c1, o.set0, o.set1);
        if (_liquidity(p.tokenId) == 0) {
            positionManager.burn(p.tokenId);
            p.status = Status.Closed;
            positionOf[p.controller] = 0;
            emit Closed(positionId);
        }
    }

    /// @notice Hands the position to `to`, another holder's fresh controller.
    function give(uint256 positionId, address to, uint64 deadline, bytes calldata signature) external {
        Position storage p = _open(positionId);
        _authorize(positionId, p, Action.Give, keccak256(abi.encode(to)), deadline, signature);
        _claim(to);
        positionOf[p.controller] = 0;
        positionOf[to] = positionId + 1;
        p.controller = to;
        emit Given(positionId, to);
    }

    /// @notice Sends the Uniswap NFT to `to`: the position leaves this contract, and `to` is public.
    function takeOut(uint256 positionId, address to, uint64 deadline, bytes calldata signature) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        Position storage p = _open(positionId);
        _authorize(positionId, p, Action.TakeOut, keccak256(abi.encode(to)), deadline, signature);
        p.status = Status.Out;
        positionOf[p.controller] = 0;
        positionManager.safeTransferFrom(address(this), to, p.tokenId);
        emit TakenOut(positionId, to);
    }

    /// @notice Takes an existing Uniswap position sent with `safeTransferFrom`, `data` naming its
    ///         controller (`abi.encode(address)`). Both its tokens must have pockets here.
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4) {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        // Our own mints land here too.
        if (operator == address(this)) return IERC721Receiver.onERC721Received.selector;
        address controller = abi.decode(data, (address));
        Range memory r = _rangeOf(tokenId);
        _side(r.token0);
        _side(r.token1);
        _claim(controller);
        uint256 positionId = positionCount++;
        Position storage p = _positions[positionId];
        p.controller = controller;
        p.status = Status.Open;
        p.tokenId = tokenId;
        p.range = r;
        positionOf[controller] = positionId + 1;
        emit Opened(positionId, controller, r.token0, r.token1, r.fee, r.tickLower, r.tickUpper);
        emit Deposited(positionId, from, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    // ------------------------------------------------------------------ owner

    /// @notice Takes positions in `pockets`' token. The pockets' owner must add this contract as a desk.
    function addPockets(SealedPockets pockets) external onlyOwner {
        IConfidentialWrapper token = IConfidentialWrapper(address(pockets.token()));
        address underlying = token.underlying();
        if (address(_sides[underlying].pockets) != address(0)) revert SideSet(underlying);
        _sides[underlying] = Side(pockets, token, token.rate());
        _underlyings.push(underlying);
        IERC20(underlying).forceApprove(address(positionManager), type(uint256).max);
        IERC20(underlying).forceApprove(address(token), type(uint256).max);
        // The pockets pull what this contract pays in.
        token.setOperator(address(pockets), type(uint48).max);
        emit PocketsAdded(underlying, address(pockets));
    }

    function setFee(uint16 feeBps_) external onlyOwner {
        _setFee(feeBps_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    // ------------------------------------------------------------------ views

    /// @notice What an `open`'s pocket keys are bound to: each side's key XOR this.
    function openHash(address controller, Range calldata r, Funds calldata f) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), OPEN, controller, r, _fundsHash(f))));
    }

    /// @notice What an `add`'s pocket keys are bound to.
    function addHash(uint256 positionId, Funds calldata f) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), ADD, positionId, _fundsHash(f))));
    }

    /// @notice The terms of a `collect`, and part of a `decrease`'s: where the tokens go.
    function outHash(Out calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(o.set0, o.set1, externalEuint32.unwrap(o.target0), externalEuint32.unwrap(o.target1)));
    }

    /// @notice What the controller signs for `action` on `positionId` with these `terms`, at its current nonce.
    function actDigest(uint256 positionId, Action action, bytes32 terms, uint64 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ACT_TYPEHASH, positionId, uint8(action), terms, _positions[positionId].nonce, deadline)));
    }

    function positionInfo(uint256 positionId) external view returns (Position memory) {
        if (positionId >= positionCount) revert NotAPosition(positionId);
        return _positions[positionId];
    }

    function fundingInfo(uint256 fundingId) external view returns (Funding memory) {
        return _fundings[fundingId];
    }

    /// @notice The pockets and wrapper of an ERC-20 positions take (zero when they take none).
    function sideOf(address underlying) external view returns (Side memory) {
        return _sides[underlying];
    }

    /// @notice Every ERC-20 positions take, in the order they were added.
    function tokens() external view returns (address[] memory) {
        return _underlyings;
    }

    // -------------------------------------------------------------- internals

    function _side(address underlying) private view returns (Side storage s) {
        s = _sides[underlying];
        if (address(s.pockets) == address(0)) revert NotATokenHere(underlying);
    }

    function _open(uint256 positionId) private view returns (Position storage p) {
        if (positionId >= positionCount) revert NotAPosition(positionId);
        p = _positions[positionId];
        if (p.status != Status.Open) revert NotOpen(positionId);
    }

    function _claim(address controller) private {
        if (controller == address(0)) revert ZeroAddress();
        if (controllerUsed[controller]) revert ControllerUsed(controller);
        controllerUsed[controller] = true;
    }

    function _authorize(uint256 positionId, Position storage p, Action action, bytes32 terms, uint64 deadline, bytes calldata signature) private {
        if (deadline < block.timestamp) revert Expired();
        if (ECDSA.recover(actDigest(positionId, action, terms, deadline), signature) != p.controller) revert NotController();
        p.nonce++;
    }

    function _fundsHash(Funds calldata f) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                f.set0,
                f.set1,
                externalEuint64.unwrap(f.amount0),
                externalEuint64.unwrap(f.amount1),
                externalEuint32.unwrap(f.target0),
                externalEuint32.unwrap(f.target1),
                f.amount0Min,
                f.amount1Min,
                f.deadline
            )
        );
    }

    /// @dev Takes both sides out of pockets (or neither) and starts their unwraps.
    function _fund(uint256 positionId, Range memory r, Funds calldata f, Keys calldata k, uint256 terms) private returns (uint256 fundingId) {
        if (f.deadline < block.timestamp) revert Expired();
        Side storage s0 = _side(r.token0);
        Side storage s1 = _side(r.token1);
        fundingId = fundingCount++;
        Funding storage fd = _fundings[fundingId];
        fd.positionId = positionId;
        fd.set0 = f.set0;
        fd.set1 = f.set1;
        fd.amount0Min = f.amount0Min;
        fd.amount1Min = f.amount1Min;
        fd.deadline = f.deadline;
        fd.status = FundingStatus.Pending;
        fd.target0 = FHE.fromExternal(f.target0, f.inputProof);
        fd.target1 = FHE.fromExternal(f.target1, f.inputProof);
        FHE.allowThis(fd.target0);
        FHE.allowThis(fd.target1);
        (euint64 u0, euint64 u1) = _take(s0, s1, f, k, terms, fd);
        fd.unwrap0 = _unwrap(s0, u0);
        fd.unwrap1 = _unwrap(s1, u1);
        emit Funded(fundingId, positionId, f.set0, f.set1);
    }

    /// @dev What each side's pocket paid, if both paid what was asked; what one side paid goes
    ///      back to it, under encryption, when the other did not.
    function _take(Side storage s0, Side storage s1, Funds calldata f, Keys calldata k, uint256 terms, Funding storage fd)
        private
        returns (euint64 u0, euint64 u1)
    {
        euint64 a0 = FHE.fromExternal(f.amount0, f.inputProof);
        euint64 a1 = FHE.fromExternal(f.amount1, f.inputProof);
        euint64 got0 = _takeSide(s0, f.set0, _key(k.boundKey0, k.keyProof, terms), a0);
        euint64 got1 = _takeSide(s1, f.set1, _key(k.boundKey1, k.keyProof, terms), a1);
        ebool ok = FHE.and(FHE.eq(got0, a0), FHE.eq(got1, a1));
        euint64 zero = FHE.asEuint64(0);
        _giveEnc(s0, f.set0, fd.target0, FHE.select(ok, zero, got0));
        _giveEnc(s1, f.set1, fd.target1, FHE.select(ok, zero, got1));
        u0 = FHE.select(ok, got0, zero);
        u1 = FHE.select(ok, got1, zero);
    }

    /// @dev The key from a bound key, which then can never be used again.
    function _key(externalEuint256 boundKey, bytes calldata keyProof, uint256 terms) private returns (euint256) {
        bytes32 h = externalEuint256.unwrap(boundKey);
        if (spent[h]) revert KeyUsed();
        spent[h] = true;
        return FHE.xor(FHE.fromExternal(boundKey, keyProof), terms);
    }

    function _takeSide(Side storage s, uint256[] calldata set, euint256 key, euint64 amount) private returns (euint64) {
        FHE.allowTransient(key, address(s.pockets));
        FHE.allowTransient(amount, address(s.pockets));
        return s.pockets.deskTakeFrom(set, key, amount);
    }

    function _unwrap(Side storage s, euint64 amount) private returns (bytes32) {
        FHE.allowTransient(amount, address(s.token));
        return s.token.unwrap(address(this), address(this), amount);
    }

    /// @dev The ERC-20s of an unwrap, in their own units: finalized here, or by whoever finalized
    ///      it first (the wrapper sends them here either way), in which case the proof is checked here.
    function _receive(Side storage s, bytes32 unwrapId, uint64 clear, bytes calldata proof) private returns (uint256) {
        if (s.token.unwrapRequester(unwrapId) != address(0)) {
            s.token.finalizeUnwrap(unwrapId, clear, proof);
        } else {
            bytes32[] memory handles = new bytes32[](1);
            handles[0] = unwrapId;
            FHE.checkSignatures(handles, abi.encode(clear), proof);
        }
        return uint256(clear) * s.rate;
    }

    /// @dev Puts what arrived into Uniswap, and gives back what it did not take.
    function _settle(uint256 fundingId, Funding storage fd, Position storage p, uint256 in0, uint256 in1) private {
        (bool ok, uint256 used0, uint256 used1, uint128 liquidity) = (in0 == 0 && in1 == 0) ? (false, 0, 0, 0) : _provide(p, fd, in0, in1);
        if (!ok && p.status == Status.Funding) p.status = Status.Failed;
        fd.status = ok ? FundingStatus.Done : FundingStatus.Refunded;
        _givePlain(_sides[p.range.token0], fd.set0, fd.target0, in0 - used0);
        _givePlain(_sides[p.range.token1], fd.set1, fd.target1, in1 - used1);
        emit Settled(fundingId, fd.positionId, ok, used0, used1, liquidity);
    }

    /// @dev Mints the position, or adds to it. Uniswap refusing is not a revert: the funding goes back.
    function _provide(Position storage p, Funding storage fd, uint256 in0, uint256 in1)
        private
        returns (bool ok, uint256 used0, uint256 used1, uint128 liquidity)
    {
        if (p.status == Status.Funding) {
            Range memory r = p.range;
            try positionManager.mint(
                IPositionManager.MintParams(r.token0, r.token1, r.fee, r.tickLower, r.tickUpper, in0, in1, fd.amount0Min, fd.amount1Min, address(this), fd.deadline)
            ) returns (uint256 tokenId, uint128 l, uint256 a0, uint256 a1) {
                p.tokenId = tokenId;
                p.status = Status.Open;
                return (true, a0, a1, l);
            } catch {
                return (false, 0, 0, 0);
            }
        }
        if (p.status != Status.Open) return (false, 0, 0, 0);
        try positionManager.increaseLiquidity(
            IPositionManager.IncreaseLiquidityParams(p.tokenId, in0, in1, fd.amount0Min, fd.amount1Min, fd.deadline)
        ) returns (uint128 l, uint256 a0, uint256 a1) {
            return (true, a0, a1, l);
        } catch {
            return (false, 0, 0, 0);
        }
    }

    function _collect(uint256 tokenId) private returns (uint256, uint256) {
        return positionManager.collect(IPositionManager.CollectParams(tokenId, address(this), type(uint128).max, type(uint128).max));
    }

    /// @dev Collects the trading fees earned so far and sends the treasury its share. Returns the rest.
    function _collectFees(uint256 positionId, Position storage p, Out calldata o) private returns (uint256 net0, uint256 net1) {
        (uint256 a0, uint256 a1) = _collect(p.tokenId);
        uint256 fee0 = (a0 * feeBps) / 10_000;
        uint256 fee1 = (a1 * feeBps) / 10_000;
        if (fee0 > 0) IERC20(p.range.token0).safeTransfer(treasury, fee0);
        if (fee1 > 0) IERC20(p.range.token1).safeTransfer(treasury, fee1);
        if (a0 > 0 || a1 > 0) emit Collected(positionId, a0, a1, fee0, fee1, o.set0, o.set1);
        return (a0 - fee0, a1 - fee1);
    }

    function _payOut(Position storage p, Out calldata o, uint256 amount0, uint256 amount1) private {
        _givePlain(_sides[p.range.token0], o.set0, FHE.fromExternal(o.target0, o.inputProof), amount0);
        _givePlain(_sides[p.range.token1], o.set1, FHE.fromExternal(o.target1, o.inputProof), amount1);
    }

    /// @dev Wraps `amount` of the ERC-20 and pays it into the pocket of `set` numbered `target`.
    ///      What is below one confidential unit (`rate`) stays here.
    function _givePlain(Side storage s, uint256[] memory set, euint32 target, uint256 amount) private {
        uint256 units = amount / s.rate;
        if (units == 0) return;
        s.token.wrap(address(this), units * s.rate);
        _giveEnc(s, set, target, FHE.asEuint64(SafeCast.toUint64(units)));
    }

    function _giveEnc(Side storage s, uint256[] memory set, euint32 target, euint64 amount) private {
        FHE.allowTransient(amount, address(s.pockets));
        FHE.allowTransient(target, address(s.pockets));
        s.pockets.deskGiveTo(set, target, amount);
    }

    function _liquidity(uint256 tokenId) private view returns (uint128 liquidity) {
        (, , , , , , , liquidity, , , , ) = positionManager.positions(tokenId);
    }

    function _rangeOf(uint256 tokenId) private view returns (Range memory r) {
        (, , r.token0, r.token1, r.fee, r.tickLower, r.tickUpper, , , , , ) = positionManager.positions(tokenId);
    }

    function _setFee(uint16 feeBps_) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }
}
