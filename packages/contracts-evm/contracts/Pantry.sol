// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
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

    /// @dev Encrypted "does `account` hold `tokenId`", allowed to the Pantry for the transaction.
    ///      The Pantry must be one of the collection's trusted readers.
    function isOwner(uint256 tokenId, address account) external returns (ebool);
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
///     is opened. A feeder may read what their own meals added today. The treasury reads its share
///     only as what `collect` pays it, at most once a week: a share readable after every meal
///     would tell it who fed which cat, and how much.
///
///  3. A cat eats at most `mealsPerDay` meals and `maxEatenPerDay` croquettes per UTC day,
///     however they are spread. Who holds a box is encrypted (see `ConfidentialERC721`), so
///     the holder check, the meal count and the amount are all encrypted: a meal past the
///     limits, or served by someone who does not hold the cat, moves 0, silently. Nothing
///     about a meal reverts on them, and the meal count is not public.
///
///  4. A feeder who holds less than the (capped) offer moves 0. The meal still counts, still
///     costs gas, and nothing on-chain tells it apart from a real one.
///
///  7. Welcome bags and purrs are paid into the box, not to whoever asks: `claim` first tops up
///     each listed box's encrypted stash (anyone may, the clock is public), then pays the caller
///     the stashes of the boxes they hold, and 0 for the others. So nobody can spend another
///     holder's day, and a claim says nothing about what the caller holds.
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
    uint8 private constant REVEALED = 1;

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

    /// @dev What a feeder may read about today's meals of one cat: masked to 0 for a feeder who
    ///      does not hold it.
    struct Seen {
        uint32 day;
        euint8 meals;
        euint64 eaten;
    }

    error InvalidParams();
    error NotHolder();
    error NotSealed();
    error NotRevealed();
    error AlreadyWeighed();
    error WeighInNotPending();
    error NothingToClaim();
    error NothingToCollect();
    error InvalidBoxCount();
    error CollectTooSoon();

    event Funded(address indexed from, uint64 amount);
    event MealServed(uint256 indexed tokenId, address indexed feeder);
    event WelcomeBag(uint256 indexed tokenId);
    event Purred(uint256 indexed tokenId, uint256 days_);
    event Claimed(address indexed caller, uint256 boxes);
    event WeighInRequested(uint256 indexed tokenId, bytes32 weightHandle);
    event Weighed(uint256 indexed tokenId, uint64 weight, uint8 build, bool sick, uint8 disease);
    event Collected(address indexed treasury);

    IDoNotOpen public immutable boxes;
    ConfidentialCroq public immutable cCroq;
    IERC20 public immutable croq;
    /// @notice Receives the treasury's share of every meal, through `collect`.
    address public immutable treasury;
    uint256 public immutable startedAt;
    /// @notice The least time between two collections, so the treasury only ever learns its
    ///         share in weekly sums.
    uint64 public constant COLLECT_INTERVAL = 7 days;

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
    /// @notice When the treasury last collected (the deployment counts as one).
    uint64 public lastCollected;
    mapping(uint256 tokenId => euint64) private _weight;
    mapping(uint256 tokenId => euint64) private _eatenToday;
    mapping(uint256 tokenId => euint8) private _mealsToday;
    /// @dev The UTC day `_eatenToday` and `_mealsToday` are about.
    mapping(uint256 tokenId => uint32) private _day;
    mapping(uint256 tokenId => mapping(address feeder => Seen)) private _seen;
    /// @dev Welcome bag and purrs paid into a box, waiting for its holder.
    mapping(uint256 tokenId => euint64) private _stash;
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
        lastCollected = uint64(block.timestamp);
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
    ///         down to it, and a meal past the limits, or from someone who does not hold the cat,
    ///         moves 0. The caller must have made the Pantry an operator on cCROQ.
    /// @param amount encrypted amount, made for this contract and the caller with the Relayer SDK
    /// @param inputProof the proof that comes with it
    function feed(uint256 tokenId, externalEuint64 amount, bytes calldata inputProof) external {
        if (boxes.status(tokenId) != SEALED) revert NotSealed();
        ebool holds = boxes.isOwner(tokenId, msg.sender);

        uint32 today = uint32(block.timestamp / 1 days);
        if (_day[tokenId] != today) {
            _day[tokenId] = today;
            _mealsToday[tokenId] = FHE.asEuint8(0);
            _eatenToday[tokenId] = FHE.asEuint64(0);
        }
        ebool served = FHE.and(holds, FHE.lt(_mealsToday[tokenId], mealsPerDay));
        euint64 moved = _serve(tokenId, served, FHE.fromExternal(amount, inputProof));
        _countMeal(tokenId, today, holds, served, moved);

        euint64 weight = FHE.add(_weight[tokenId], moved);
        FHE.allowThis(weight);
        _weight[tokenId] = weight;

        _split(moved);
        emit MealServed(tokenId, msg.sender);
    }

    /// @dev Pulls the offer, cut down to what is left of the day, or 0 if the meal is not served.
    ///      Returns what arrived.
    function _serve(uint256 tokenId, ebool served, euint64 offered) internal returns (euint64) {
        euint64 left = FHE.sub(maxEatenPerDay, _eatenToday[tokenId]);
        euint64 capped = FHE.select(served, FHE.min(offered, left), FHE.asEuint64(0));
        FHE.allowTransient(capped, address(cCroq));
        // Moves `capped` if the caller holds it, 0 otherwise.
        return cCroq.confidentialTransferFrom(msg.sender, address(this), capped);
    }

    /// @dev Adds the meal to today's count and lets the feeder read back today's totals: the
    ///      real ones if they hold the cat, zeros otherwise.
    function _countMeal(uint256 tokenId, uint32 today, ebool holds, ebool served, euint64 moved) internal {
        euint8 meals = FHE.add(_mealsToday[tokenId], FHE.select(served, FHE.asEuint8(1), FHE.asEuint8(0)));
        euint64 eaten = FHE.add(_eatenToday[tokenId], moved);
        FHE.allowThis(meals);
        FHE.allowThis(eaten);
        _mealsToday[tokenId] = meals;
        _eatenToday[tokenId] = eaten;

        euint8 seenMeals = FHE.select(holds, meals, FHE.asEuint8(0));
        euint64 seenEaten = FHE.select(holds, eaten, FHE.asEuint64(0));
        FHE.allowThis(seenMeals);
        FHE.allowThis(seenEaten);
        FHE.allow(seenMeals, msg.sender);
        FHE.allow(seenEaten, msg.sender);
        _seen[tokenId][msg.sender] = Seen(today, seenMeals, seenEaten);
    }

    /// @notice Handles of what `feeder` may read about `tokenId` today: meals and croquettes
    ///         eaten, both 0 unless they hold it. Zero handles on a new day or for a stranger.
    function todayHandles(uint256 tokenId, address feeder) external view returns (bytes32 meals, bytes32 eaten) {
        Seen storage s = _seen[tokenId][feeder];
        if (s.day != uint32(block.timestamp / 1 days)) return (bytes32(0), bytes32(0));
        return (FHE.toBytes32(s.meals), FHE.toBytes32(s.eaten));
    }

    /// @notice Sends the treasury its share of every meal so far. Anyone may call it, at most
    ///         once per `COLLECT_INTERVAL`.
    function collect() external {
        euint64 owed = _treasuryShare;
        if (!FHE.isInitialized(owed)) revert NothingToCollect();
        if (block.timestamp < lastCollected + COLLECT_INTERVAL) revert CollectTooSoon();
        lastCollected = uint64(block.timestamp);
        euint64 zero = FHE.asEuint64(0);
        FHE.allowThis(zero);
        _treasuryShare = zero;
        _pay(treasury, owed);
        emit Collected(treasury);
    }

    // ----------------------------------------------------------------- claim

    /// @notice For each listed box: pays into it its welcome bag the first time, then its purr
    ///         for every whole day since (up to `purrMaxDays`), whoever asks. Then pays the caller,
    ///         as one encrypted cCROQ transfer, what waits in the listed boxes they hold.
    /// @dev One encrypted draw per purring box, multiplied by the days owed. When the reserve can
    ///      no longer pay a whole claim, that claim pays nothing into the boxes.
    function claim(uint256[] calldata tokenIds) external {
        uint256 count = tokenIds.length;
        if (count == 0 || count > maxBoxesPerClaim) revert InvalidBoxCount();

        uint256 era = (block.timestamp - startedAt) / halvingPeriod;
        euint64[] memory dues = new euint64[](count);
        euint64 totalDue;
        for (uint256 i = 0; i < count; i++) {
            dues[i] = _accrue(tokenIds[i], era);
            // An id nobody holds (a mint's empty ids) gets nothing: its stash could never be
            // claimed, and free empty ids would drain the reserve.
            if (FHE.isInitialized(dues[i])) dues[i] = FHE.select(boxes.isOwner(tokenIds[i], address(0)), FHE.asEuint64(0), dues[i]);
            if (FHE.isInitialized(dues[i])) totalDue = FHE.isInitialized(totalDue) ? FHE.add(totalDue, dues[i]) : dues[i];
        }
        // The reserve pays all of this claim or, once it can no longer, none of it.
        ebool funded;
        if (FHE.isInitialized(totalDue)) {
            funded = FHE.le(totalDue, _reserve);
            euint64 reserve = FHE.sub(_reserve, FHE.select(funded, totalDue, FHE.asEuint64(0)));
            FHE.allowThis(reserve);
            _reserve = reserve;
        }

        euint64 payout = FHE.asEuint64(0);
        bool anything;
        for (uint256 i = 0; i < count; i++) {
            uint256 tokenId = tokenIds[i];
            euint64 stash = _stash[tokenId];
            if (FHE.isInitialized(dues[i])) {
                euint64 paid = FHE.select(funded, dues[i], FHE.asEuint64(0));
                stash = FHE.isInitialized(stash) ? FHE.add(stash, paid) : paid;
            }
            if (!FHE.isInitialized(stash)) continue;
            anything = true;
            ebool owns = boxes.isOwner(tokenId, msg.sender);
            euint64 mine = FHE.select(owns, stash, FHE.asEuint64(0));
            // The holder takes it all: what stays is the stash, or nothing.
            stash = FHE.select(owns, FHE.asEuint64(0), stash);
            FHE.allowThis(stash);
            _stash[tokenId] = stash;
            payout = FHE.add(payout, mine);
        }
        if (!anything) revert NothingToClaim();
        _pay(msg.sender, payout);
        emit Claimed(msg.sender, count);
    }

    /// @dev What `tokenId` is owed since its last claim, moving its clock. Uninitialized when
    ///      nothing is owed or the purr has halved to nothing.
    function _accrue(uint256 tokenId, uint256 era) internal returns (euint64 due) {
        uint64 last = lastPurr[tokenId];
        if (last == 0) {
            lastPurr[tokenId] = uint64(block.timestamp);
            emit WelcomeBag(tokenId);
            return FHE.asEuint64(welcomeBag);
        }
        uint256 owed = (block.timestamp - last) / 1 days;
        if (owed == 0) return due;
        if (owed > purrMaxDays) {
            owed = purrMaxDays;
            lastPurr[tokenId] = uint64(block.timestamp);
        } else {
            // Keeps the part of a day already started.
            lastPurr[tokenId] = uint64(last + owed * 1 days);
        }
        emit Purred(tokenId, owed);

        uint256 factor = owed * (boxes.vetCertified(tokenId) ? vetMultiplier : 1);
        // Past the point where even the best draw halves to zero, skip the FHE work.
        if (era >= 64 || (uint256(purrMaxPerDay) * factor) >> era == 0) return due;
        return _purrDraw(factor, uint8(era));
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

    /// @notice Handle of what waits in a box for its holder. Nobody may decrypt it: the holder
    ///         learns it by claiming.
    function stashHandle(uint256 tokenId) external view returns (bytes32) {
        return FHE.toBytes32(_stash[tokenId]);
    }

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

    /// @notice Handle of the treasury's uncollected share, readable by nobody.
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
