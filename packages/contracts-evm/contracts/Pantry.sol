// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint8, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ConfidentialCroq} from "./ConfidentialCroq.sol";

/// @dev The slice of DoNotOpen the Pantry reads. Nothing here writes to it.
interface IDoNotOpen {
    struct Revealed {
        uint64 seed;
        uint8 state;
        uint8[5] traits;
        uint16 score;
        uint32 affection;
        bool golden;
    }

    function ownerOf(uint256 tokenId) external view returns (address);
    function status(uint256 tokenId) external view returns (uint8);
    function vetCertified(uint256 tokenId) external view returns (bool);
    function contentsOf(uint256 tokenId) external view returns (Revealed memory);
}

/// @title Pantry
/// @notice Runs the croquette economy next to DO NOT OPEN, without touching it.
///         Feed a sealed box cCROQ and the croquettes pile up in its encrypted stash. Nobody can
///         read or withdraw a stash while the box is sealed. Once the box is opened, the cat
///         decides: the living and the sleeping pay the stash to the holder, a ghost burns it
///         all, a quantum cat burns half. Holders also collect a welcome bag and a daily purr.
///
/// @dev Design notes.
///
///  1. Every croquette the Pantry holds belongs to exactly one encrypted bucket: the reserve
///     (welcome bags and purrs), a box's stash, or the burnt pile. Buckets only move between
///     each other or out to a player, so the Pantry's cCROQ balance always covers them.
///
///  2. NOBODY is allowed on a stash, the reserve or the burnt pile, holder and deployer
///     included. FHE.allow grants are permanent, so a stash readable by its holder would stay
///     readable by every past holder after a sale. The only amounts a player can decrypt are
///     their own transfers, which cCROQ grants them.
///
///  3. "Burnt" means locked here for good: no function moves the burnt pile. Real burning would
///     strand the same ERC-20 inside the wrapper anyway, at a higher FHE cost.
///
///  4. A feeder who holds less than they offer moves 0. The meal still counts, still costs
///     gas, and nothing on-chain tells it apart from a real one.
///
///  HCU per function (protocol limit 20,000,000 per transaction), measured in tests:
///    feed            ~2,152,000   confidential transferFrom, mul + div for the burn
///    claim           ~680,000 per purring box, ~6.8M for the 10-box maximum
///                    0 once the purr has halved to nothing
///    settle          0 (never fed), ~162,000 (ghost), ~586,000 (alive, asleep),
///                    ~1,990,000 (quantum: mul + div for the half)
contract Pantry is ZamaEthereumConfig {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;
    uint8 private constant SEALED = 0;
    uint8 private constant REVEALED = 2;

    struct Params {
        /// Paid once per box, on its first claim.
        uint64 welcomeBag;
        /// A purr draws an encrypted amount in [0, purrMaxPerDay] per box and per day.
        uint8 purrMaxPerDay;
        /// Purr multiplier for Vet Certified boxes.
        uint8 vetMultiplier;
        /// Days of purr one claim can collect; older days are lost.
        uint8 purrMaxDays;
        /// The purr halves every `halvingPeriod` seconds after deployment.
        uint32 halvingPeriod;
        /// Share of each meal that is burnt.
        uint16 mealBurnBps;
        /// Share of the stash paid to the holder at settlement, by state id.
        uint16[4] payoutBps;
        /// Boxes one claim may cover, to keep it under the HCU limit.
        uint8 maxBoxesPerClaim;
    }

    error InvalidParams();
    error NotHolder();
    error NotSealed();
    error NotRevealed();
    error AlreadySettled();
    error NothingToClaim();
    error InvalidBoxCount();

    event Funded(address indexed from, uint64 amount);
    event MealServed(uint256 indexed tokenId, address indexed feeder, uint32 meals);
    event WelcomeBag(uint256 indexed tokenId, address indexed holder);
    event Purred(address indexed holder, uint256 boxes);
    event Settled(uint256 indexed tokenId, address indexed holder, uint8 state, uint16 payoutBps);

    IDoNotOpen public immutable boxes;
    ConfidentialCroq public immutable cCroq;
    IERC20 public immutable croq;
    uint256 public immutable startedAt;

    uint64 public immutable welcomeBag;
    uint8 public immutable purrMaxPerDay;
    uint8 public immutable vetMultiplier;
    uint8 public immutable purrMaxDays;
    uint32 public immutable halvingPeriod;
    uint16 public immutable mealBurnBps;
    uint8 public immutable maxBoxesPerClaim;
    uint16 private immutable _payoutAlive;
    uint16 private immutable _payoutAsleep;
    uint16 private immutable _payoutGhost;
    uint16 private immutable _payoutQuantum;

    euint64 private _reserve;
    euint64 private _burnt;
    mapping(uint256 tokenId => euint64) private _stash;
    /// @notice How many meals each box was served. Public; what they held is not.
    mapping(uint256 tokenId => uint32) public meals;
    /// @notice When a box last purred. Zero until its welcome bag is collected.
    mapping(uint256 tokenId => uint64) public lastPurr;
    mapping(uint256 tokenId => bool) public settled;

    constructor(IDoNotOpen boxes_, ConfidentialCroq cCroq_, Params memory p) {
        if (
            p.purrMaxPerDay == type(uint8).max ||
            p.vetMultiplier == 0 ||
            p.purrMaxDays == 0 ||
            p.halvingPeriod == 0 ||
            p.mealBurnBps > BPS ||
            p.maxBoxesPerClaim == 0
        ) revert InvalidParams();
        for (uint256 i = 0; i < 4; i++) if (p.payoutBps[i] > BPS) revert InvalidParams();

        boxes = boxes_;
        cCroq = cCroq_;
        croq = IERC20(cCroq_.underlying());
        startedAt = block.timestamp;
        welcomeBag = p.welcomeBag;
        purrMaxPerDay = p.purrMaxPerDay;
        vetMultiplier = p.vetMultiplier;
        purrMaxDays = p.purrMaxDays;
        halvingPeriod = p.halvingPeriod;
        mealBurnBps = p.mealBurnBps;
        maxBoxesPerClaim = p.maxBoxesPerClaim;
        _payoutAlive = p.payoutBps[0];
        _payoutAsleep = p.payoutBps[1];
        _payoutGhost = p.payoutBps[2];
        _payoutQuantum = p.payoutBps[3];
    }

    // ------------------------------------------------------------------ fund

    /// @notice Adds plain CROQ to the game reserve. The caller must have approved the Pantry.
    ///         Public amount: it moves as a plain ERC-20 before being wrapped.
    function fund(uint64 amount) external {
        croq.safeTransferFrom(msg.sender, address(this), amount);
        croq.forceApprove(address(cCroq), amount);
        cCroq.wrap(address(this), amount);

        euint64 reserve = FHE.add(_reserve, amount);
        FHE.allowThis(reserve);
        _reserve = reserve;
        emit Funded(msg.sender, amount);
    }

    // ------------------------------------------------------------------ feed

    /// @notice Serves a sealed box an encrypted amount of the caller's cCROQ. A share is burnt,
    ///         the rest joins the box's stash. The caller must have made the Pantry an operator
    ///         on cCROQ (`setOperator`).
    /// @param amount encrypted amount, made for this contract and the caller with the Relayer SDK
    /// @param inputProof the proof that comes with it
    function feed(uint256 tokenId, externalEuint64 amount, bytes calldata inputProof) external {
        boxes.ownerOf(tokenId); // reverts for a box that does not exist
        if (boxes.status(tokenId) != SEALED) revert NotSealed();

        euint64 offered = FHE.fromExternal(amount, inputProof);
        FHE.allowTransient(offered, address(cCroq));
        // Moves `offered` if the caller holds it, 0 otherwise.
        euint64 moved = cCroq.confidentialTransferFrom(msg.sender, address(this), offered);

        euint64 burnt = _share(moved, mealBurnBps);
        euint64 stash = FHE.add(_stash[tokenId], FHE.sub(moved, burnt));
        FHE.allowThis(stash);
        _stash[tokenId] = stash;
        _addBurnt(burnt);

        uint32 served = meals[tokenId] + 1;
        meals[tokenId] = served;
        emit MealServed(tokenId, msg.sender, served);
    }

    // ----------------------------------------------------------------- claim

    /// @notice Collects, for each listed box the caller holds: its welcome bag the first time,
    ///         then its purr for every whole day since its last claim (up to `purrMaxDays`).
    ///         Everything arrives as one encrypted cCROQ transfer that only the caller can read.
    /// @dev One encrypted draw per box, multiplied by the days owed. Boxes with nothing owed
    ///      are skipped; a claim where every box is skipped reverts.
    function claim(uint256[] calldata tokenIds) external {
        if (tokenIds.length == 0 || tokenIds.length > maxBoxesPerClaim) revert InvalidBoxCount();

        uint256 era = (block.timestamp - startedAt) / halvingPeriod;
        uint64 bags;
        euint64 purr;
        bool paid;
        uint256 purring;

        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (boxes.ownerOf(tokenId) != msg.sender) revert NotHolder();

            uint64 last = lastPurr[tokenId];
            if (last == 0) {
                lastPurr[tokenId] = uint64(block.timestamp);
                bags += welcomeBag;
                paid = true;
                emit WelcomeBag(tokenId, msg.sender);
                continue;
            }

            uint256 owed = (block.timestamp - last) / 1 days;
            if (owed == 0) continue;
            if (owed > purrMaxDays) {
                owed = purrMaxDays;
                lastPurr[tokenId] = uint64(block.timestamp);
            } else {
                // Keeps the part of a day already started.
                lastPurr[tokenId] = uint64(last + owed * 1 days);
            }
            paid = true;

            uint256 factor = owed * (boxes.vetCertified(tokenId) ? vetMultiplier : 1);
            // Past the point where even the best draw halves to zero, skip the FHE work.
            if (era >= 64 || (uint256(purrMaxPerDay) * factor) >> era == 0) continue;

            purring++;
            purr = FHE.add(purr, _purrDraw(factor, uint8(era)));
        }
        if (!paid) revert NothingToClaim();
        // Days were owed but the purr has halved down to nothing: no transfer to make.
        if (bags == 0 && purring == 0) return;

        euint64 owedTotal = FHE.add(purr, bags);
        // The reserve can run dry: then the purr shrinks to what is left, down to zero.
        euint64 total = FHE.min(owedTotal, _reserve);
        euint64 reserve = FHE.sub(_reserve, total);
        FHE.allowThis(reserve);
        _reserve = reserve;

        _pay(msg.sender, total);
        if (purring != 0) emit Purred(msg.sender, purring);
    }

    /// @dev Uniform-ish draw in [0, purrMaxPerDay] (a byte modulo n: 256 is not a multiple
    ///      of 5, so 0 is 1/256 more likely than the rest), times `factor`, halved `era` times.
    function _purrDraw(uint256 factor, uint8 era) internal returns (euint64 draw) {
        euint8 roll = FHE.rem(FHE.randEuint8(), purrMaxPerDay + 1);
        draw = FHE.asEuint64(roll);
        if (factor != 1) draw = FHE.mul(draw, uint64(factor));
        if (era != 0) draw = FHE.shr(draw, era);
    }

    // ---------------------------------------------------------------- settle

    /// @notice Settles an opened box's stash. Anyone may call it, once, after DoNotOpen has
    ///         finalized the reveal. Pays the holder of the moment their share and burns the rest.
    function settle(uint256 tokenId) external {
        if (settled[tokenId]) revert AlreadySettled();
        if (boxes.status(tokenId) != REVEALED) revert NotRevealed();
        settled[tokenId] = true;

        uint8 state = boxes.contentsOf(tokenId).state;
        address holder = boxes.ownerOf(tokenId);
        uint16 bps = payoutBps(state);

        euint64 stash = _stash[tokenId];
        if (FHE.isInitialized(stash)) {
            if (bps == 0) {
                _addBurnt(stash);
            } else if (bps == BPS) {
                _pay(holder, stash);
            } else {
                euint64 payout = _share(stash, bps);
                _addBurnt(FHE.sub(stash, payout));
                _pay(holder, payout);
            }
        }
        emit Settled(tokenId, holder, state, bps);
    }

    /// @notice Share of the stash a cat in `state` pays its holder, in basis points.
    function payoutBps(uint8 state) public view returns (uint16) {
        if (state == 0) return _payoutAlive;
        if (state == 1) return _payoutAsleep;
        if (state == 2) return _payoutGhost;
        return _payoutQuantum;
    }

    // ----------------------------------------------------------------- views

    /// @notice Handle of a box's encrypted stash. A handle is an identifier, not the value:
    ///         nobody is allowed to decrypt it.
    function stashHandle(uint256 tokenId) external view returns (bytes32) {
        return FHE.toBytes32(_stash[tokenId]);
    }

    function reserveHandle() external view returns (bytes32) {
        return FHE.toBytes32(_reserve);
    }

    function burntHandle() external view returns (bytes32) {
        return FHE.toBytes32(_burnt);
    }

    /// @notice When `tokenId` can next claim something: now for a box that never claimed.
    function nextClaimAt(uint256 tokenId) external view returns (uint256) {
        uint64 last = lastPurr[tokenId];
        return last == 0 ? block.timestamp : last + 1 days;
    }

    /// @notice How many times the purr has halved so far.
    function halvings() external view returns (uint256) {
        return (block.timestamp - startedAt) / halvingPeriod;
    }

    // -------------------------------------------------------------- internal

    function _share(euint64 amount, uint16 bps) internal returns (euint64) {
        // Amounts are whole croquettes bounded by the 20M supply: amount * bps cannot overflow.
        return FHE.div(FHE.mul(amount, uint64(bps)), BPS);
    }

    function _addBurnt(euint64 amount) internal {
        euint64 burnt = FHE.add(_burnt, amount);
        FHE.allowThis(burnt);
        _burnt = burnt;
    }

    function _pay(address to, euint64 amount) internal {
        FHE.allowTransient(amount, address(cCroq));
        cCroq.confidentialTransfer(to, amount);
    }
}
