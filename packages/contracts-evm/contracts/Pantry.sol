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
///         A holder feeds their sealed cat cCROQ. The croquettes are eaten: the cat puts on an
///         encrypted weight, and the meal is split between the collection's treasury, the game
///         reserve (which pays the daily purr, so croquettes go round) and the fire. Once the
///         box is opened, anyone weighs the cat: its weight becomes public and sets its build,
///         from thin to huge. Past a tolerance of its own, drawn from its seed and unknown to
///         all until then, the cat is sick: an ultra-rare trophy. Holders also collect a
///         welcome bag and a daily purr.
///
/// @dev Design notes.
///
///  1. Every croquette the Pantry holds belongs to exactly one encrypted bucket: the reserve
///     (welcome bags and purrs), the treasury's share, or the burnt pile. A meal leaves nothing
///     behind: its croquettes all go to one of the three. The Pantry's cCROQ balance always
///     equals the three buckets.
///
///  2. NOBODY is allowed on a weight, the reserve or the burnt pile, holder and deployer
///     included. FHE.allow grants are permanent, so a weight readable by its holder would stay
///     readable by every past holder after a sale. The weight is made public only once the box
///     is opened. A feeder may read what their own meals added today, and the treasury its share.
///
///  3. A cat eats at most `mealsPerDay` meals and `maxEatenPerDay` croquettes per UTC day,
///     however they are spread. The amount is encrypted, so an offer past what is left of the
///     day is cut down to it, silently: the meal never reverts on the amount. Only the holder
///     feeds: with a daily meal limit, anyone else could fill a cat's meals with empty bowls.
///
///  4. A feeder who holds less than the (capped) offer moves 0. The meal still counts, still
///     costs gas, and nothing on-chain tells it apart from a real one.
///
///  5. The tolerance is keccak256 of the seed, folded into [sickMinWeight, +sickWeightSpread).
///     The seed is encrypted until the box is opened, and by then the weight is final: nobody,
///     the holder included, can feed a cat up to just its tolerance.
///
///  6. "Burnt" means locked here for good: no function moves the burnt pile. Real burning would
///     strand the same ERC-20 inside the wrapper anyway, at a higher FHE cost.
///
///  HCU per function (protocol limit 20,000,000 per transaction), measured in tests:
///    feed            ~2,790,000 first meal of the day, ~3,180,000 the second (one more sub)
///                    confidential transferFrom, the daily cap, two mul + div for the split
///    claim           ~680,000 per purring box, ~6.8M for the 10-box maximum
///                    0 once the purr has halved to nothing
///    weigh           0: one public decryption request, the rest is plain arithmetic
///    collect         ~590,000     one confidential transfer
contract Pantry is ZamaEthereumConfig {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;
    uint8 private constant SEALED = 0;
    uint8 private constant REVEALED = 2;

    uint8 public constant NOT_WEIGHED = 0;
    uint8 public constant WEIGH_PENDING = 1;
    uint8 public constant WEIGHED = 2;

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
        /// Meals one cat may eat per UTC day.
        uint8 mealsPerDay;
        /// Croquettes one cat may eat per UTC day, across all its meals.
        uint64 maxEatenPerDay;
        /// Share of each meal paid to the treasury.
        uint16 mealTreasuryBps;
        /// Share of each meal that is burnt. The rest goes back to the game reserve.
        uint16 mealBurnBps;
        /// Lowest weight of each build past "thin": normal, chubby, fat, huge. Increasing.
        uint64[4] buildFloors;
        /// A cat's tolerance is drawn in [sickMinWeight, sickMinWeight + sickWeightSpread).
        uint64 sickMinWeight;
        uint64 sickWeightSpread;
        /// Upper bounds, out of 65,536, of every disease but the last.
        uint16[2] diseaseRollBelow;
        /// Boxes one claim may cover, to keep it under the HCU limit.
        uint8 maxBoxesPerClaim;
    }

    /// @notice What the scales said, once a box is opened and weighed.
    struct WeighIn {
        uint8 status;
        /// 0 thin (never ate), 1 normal, 2 chubby, 3 fat, 4 huge.
        uint8 build;
        bool sick;
        /// Index into the spec's diseases. Meaningful only when `sick`.
        uint8 disease;
        uint64 weight;
        uint64 tolerance;
    }

    struct Day {
        uint32 day;
        uint8 meals;
    }

    error InvalidParams();
    error NotHolder();
    error NotSealed();
    error NotRevealed();
    error NoMoreMealsToday();
    error AlreadyWeighed();
    error WeighInNotPending();
    error NothingToClaim();
    error NothingToCollect();
    error InvalidBoxCount();

    event Funded(address indexed from, uint64 amount);
    event MealServed(uint256 indexed tokenId, address indexed feeder, uint32 meals);
    event WelcomeBag(uint256 indexed tokenId, address indexed holder);
    event Purred(address indexed holder, uint256 boxes);
    event WeighInRequested(uint256 indexed tokenId, bytes32 weightHandle);
    event Weighed(uint256 indexed tokenId, uint64 weight, uint8 build, bool sick, uint8 disease);
    event Collected(address indexed treasury);

    IDoNotOpen public immutable boxes;
    ConfidentialCroq public immutable cCroq;
    IERC20 public immutable croq;
    /// @notice Receives the treasury's share of every meal, through `collect`.
    address public immutable treasury;
    uint256 public immutable startedAt;

    uint64 public immutable welcomeBag;
    uint8 public immutable purrMaxPerDay;
    uint8 public immutable vetMultiplier;
    uint8 public immutable purrMaxDays;
    uint32 public immutable halvingPeriod;
    uint8 public immutable mealsPerDay;
    uint64 public immutable maxEatenPerDay;
    uint16 public immutable mealTreasuryBps;
    uint16 public immutable mealBurnBps;
    uint64 public immutable sickMinWeight;
    uint64 public immutable sickWeightSpread;
    uint8 public immutable maxBoxesPerClaim;
    uint64 private immutable _floorNormal;
    uint64 private immutable _floorChubby;
    uint64 private immutable _floorFat;
    uint64 private immutable _floorHuge;
    uint16 private immutable _disease1;
    uint16 private immutable _disease2;

    euint64 private _reserve;
    euint64 private _burnt;
    euint64 private _treasuryShare;
    mapping(uint256 tokenId => euint64) private _weight;
    mapping(uint256 tokenId => euint64) private _eatenToday;
    mapping(uint256 tokenId => Day) private _days;
    /// @notice How many meals each box was served. Public; what they held is not.
    mapping(uint256 tokenId => uint32) public meals;
    /// @notice When a box last purred. Zero until its welcome bag is collected.
    mapping(uint256 tokenId => uint64) public lastPurr;
    mapping(uint256 tokenId => WeighIn) private _weighIns;

    constructor(IDoNotOpen boxes_, ConfidentialCroq cCroq_, address treasury_, Params memory p) {
        if (
            treasury_ == address(0) ||
            p.purrMaxPerDay == type(uint8).max ||
            p.vetMultiplier == 0 ||
            p.purrMaxDays == 0 ||
            p.halvingPeriod == 0 ||
            p.mealsPerDay == 0 ||
            p.maxEatenPerDay == 0 ||
            uint256(p.mealTreasuryBps) + p.mealBurnBps > BPS ||
            p.buildFloors[0] == 0 ||
            p.buildFloors[1] <= p.buildFloors[0] ||
            p.buildFloors[2] <= p.buildFloors[1] ||
            p.buildFloors[3] <= p.buildFloors[2] ||
            p.sickMinWeight <= p.buildFloors[3] ||
            p.sickWeightSpread == 0 ||
            p.diseaseRollBelow[1] <= p.diseaseRollBelow[0] ||
            p.maxBoxesPerClaim == 0
        ) revert InvalidParams();

        boxes = boxes_;
        cCroq = cCroq_;
        croq = IERC20(cCroq_.underlying());
        treasury = treasury_;
        startedAt = block.timestamp;
        welcomeBag = p.welcomeBag;
        purrMaxPerDay = p.purrMaxPerDay;
        vetMultiplier = p.vetMultiplier;
        purrMaxDays = p.purrMaxDays;
        halvingPeriod = p.halvingPeriod;
        mealsPerDay = p.mealsPerDay;
        maxEatenPerDay = p.maxEatenPerDay;
        mealTreasuryBps = p.mealTreasuryBps;
        mealBurnBps = p.mealBurnBps;
        sickMinWeight = p.sickMinWeight;
        sickWeightSpread = p.sickWeightSpread;
        maxBoxesPerClaim = p.maxBoxesPerClaim;
        _floorNormal = p.buildFloors[0];
        _floorChubby = p.buildFloors[1];
        _floorFat = p.buildFloors[2];
        _floorHuge = p.buildFloors[3];
        _disease1 = p.diseaseRollBelow[0];
        _disease2 = p.diseaseRollBelow[1];
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

    /// @notice The holder feeds their sealed cat an encrypted amount of cCROQ. The cat eats it
    ///         all: its hidden weight goes up, and the croquettes are split between the
    ///         treasury, the game reserve and the fire. At most `mealsPerDay` meals and
    ///         `maxEatenPerDay` croquettes a day; an offer past what is left of the day is cut
    ///         down to it. The caller must have made the Pantry an operator on cCROQ.
    /// @param amount encrypted amount, made for this contract and the caller with the Relayer SDK
    /// @param inputProof the proof that comes with it
    function feed(uint256 tokenId, externalEuint64 amount, bytes calldata inputProof) external {
        if (boxes.ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (boxes.status(tokenId) != SEALED) revert NotSealed();

        uint32 today = uint32(block.timestamp / 1 days);
        Day memory d = _days[tokenId];
        bool firstToday = d.day != today;
        if (firstToday) d = Day(today, 0);
        if (d.meals >= mealsPerDay) revert NoMoreMealsToday();
        d.meals += 1;
        _days[tokenId] = d;

        euint64 offered = FHE.fromExternal(amount, inputProof);
        euint64 capped = firstToday
            ? FHE.min(offered, maxEatenPerDay)
            : FHE.min(offered, FHE.sub(maxEatenPerDay, _eatenToday[tokenId]));
        FHE.allowTransient(capped, address(cCroq));
        // Moves `capped` if the caller holds it, 0 otherwise.
        euint64 moved = cCroq.confidentialTransferFrom(msg.sender, address(this), capped);

        euint64 eaten = firstToday ? moved : FHE.add(_eatenToday[tokenId], moved);
        FHE.allowThis(eaten);
        FHE.allow(eaten, msg.sender);
        _eatenToday[tokenId] = eaten;

        euint64 weight = FHE.add(_weight[tokenId], moved);
        FHE.allowThis(weight);
        _weight[tokenId] = weight;

        _split(moved);

        uint32 served = meals[tokenId] + 1;
        meals[tokenId] = served;
        emit MealServed(tokenId, msg.sender, served);
    }

    /// @notice Meals `tokenId` has eaten so far today (UTC).
    function mealsToday(uint256 tokenId) public view returns (uint8) {
        Day memory d = _days[tokenId];
        return d.day == uint32(block.timestamp / 1 days) ? d.meals : 0;
    }

    /// @notice Handle of what `tokenId` ate today, readable by whoever fed it. Zero on a new day.
    function eatenTodayHandle(uint256 tokenId) external view returns (bytes32) {
        return mealsToday(tokenId) == 0 ? bytes32(0) : FHE.toBytes32(_eatenToday[tokenId]);
    }

    /// @notice Sends the treasury its share of every meal so far. Anyone may call it.
    function collect() external {
        euint64 owed = _treasuryShare;
        if (!FHE.isInitialized(owed)) revert NothingToCollect();
        euint64 zero = FHE.asEuint64(0);
        FHE.allowThis(zero);
        FHE.allow(zero, treasury);
        _treasuryShare = zero;
        _pay(treasury, owed);
        emit Collected(treasury);
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

    // ----------------------------------------------------------------- weigh

    /// @notice Weighs an opened cat. Anyone may, once. A cat that never ate is weighed on the
    ///         spot; otherwise this makes its weight publicly decryptable, and `finalizeWeigh`
    ///         records it with the KMS proof.
    function weigh(uint256 tokenId) external {
        if (boxes.status(tokenId) != REVEALED) revert NotRevealed();
        if (_weighIns[tokenId].status != NOT_WEIGHED) revert AlreadyWeighed();

        euint64 weight = _weight[tokenId];
        if (!FHE.isInitialized(weight)) {
            _record(tokenId, 0);
            return;
        }
        _weighIns[tokenId].status = WEIGH_PENDING;
        FHE.makePubliclyDecryptable(weight);
        emit WeighInRequested(tokenId, FHE.toBytes32(weight));
    }

    /// @notice Step 2 of 2. Anyone may submit the decrypted weight with its KMS proof.
    function finalizeWeigh(uint256 tokenId, bytes calldata abiEncodedWeight, bytes calldata decryptionProof) external {
        if (_weighIns[tokenId].status != WEIGH_PENDING) revert WeighInNotPending();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(_weight[tokenId]);
        FHE.checkSignatures(handles, abiEncodedWeight, decryptionProof);
        _record(tokenId, abi.decode(abiEncodedWeight, (uint64)));
    }

    function _record(uint256 tokenId, uint64 weight) internal {
        // The seed is public once the box is open; until then nobody could compute this.
        uint256 h = uint256(keccak256(abi.encode(boxes.contentsOf(tokenId).seed)));
        uint64 tolerance = sickMinWeight + uint64(h % sickWeightSpread);
        bool sick = weight >= tolerance;
        uint8 disease;
        if (sick) {
            uint16 roll = uint16(h >> 128);
            disease = roll < _disease1 ? 0 : roll < _disease2 ? 1 : 2;
        }
        uint8 build = buildOf(weight);
        _weighIns[tokenId] = WeighIn(WEIGHED, build, sick, disease, weight, tolerance);
        emit Weighed(tokenId, weight, build, sick, disease);
    }

    /// @notice The build a weight gives: 0 thin, 1 normal, 2 chubby, 3 fat, 4 huge.
    function buildOf(uint64 weight) public view returns (uint8) {
        if (weight >= _floorHuge) return 4;
        if (weight >= _floorFat) return 3;
        if (weight >= _floorChubby) return 2;
        if (weight >= _floorNormal) return 1;
        return 0;
    }

    function weighIn(uint256 tokenId) external view returns (WeighIn memory) {
        return _weighIns[tokenId];
    }

    function buildFloors() external view returns (uint64[4] memory) {
        return [_floorNormal, _floorChubby, _floorFat, _floorHuge];
    }

    // ----------------------------------------------------------------- views

    /// @notice Handle of a cat's encrypted weight. A handle is an identifier, not the value:
    ///         nobody may decrypt it until `weigh` makes it public.
    function weightHandle(uint256 tokenId) external view returns (bytes32) {
        return FHE.toBytes32(_weight[tokenId]);
    }

    function reserveHandle() external view returns (bytes32) {
        return FHE.toBytes32(_reserve);
    }

    function burntHandle() external view returns (bytes32) {
        return FHE.toBytes32(_burnt);
    }

    /// @notice Handle of the treasury's uncollected share, readable by the treasury.
    function treasuryShareHandle() external view returns (bytes32) {
        return FHE.toBytes32(_treasuryShare);
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

    /// @dev Treasury and fire take their share, rounded down; the reserve gets the rest, so the
    ///      three always add up to the meal.
    function _split(euint64 moved) internal {
        euint64 toTreasury = _share(moved, mealTreasuryBps);
        euint64 toFire = mealBurnBps == mealTreasuryBps ? toTreasury : _share(moved, mealBurnBps);

        euint64 share = FHE.add(_treasuryShare, toTreasury);
        FHE.allowThis(share);
        FHE.allow(share, treasury);
        _treasuryShare = share;

        euint64 burnt = FHE.add(_burnt, toFire);
        FHE.allowThis(burnt);
        _burnt = burnt;

        euint64 reserve = FHE.add(_reserve, FHE.sub(FHE.sub(moved, toTreasury), toFire));
        FHE.allowThis(reserve);
        _reserve = reserve;
    }

    function _share(euint64 amount, uint16 bps) internal returns (euint64) {
        // Amounts are whole croquettes bounded by the 20M supply: amount * bps cannot overflow.
        return FHE.div(FHE.mul(amount, uint64(bps)), BPS);
    }

    function _pay(address to, euint64 amount) internal {
        FHE.allowTransient(amount, address(cCroq));
        cCroq.confidentialTransfer(to, amount);
    }
}
