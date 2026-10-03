// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, eaddress, euint8, euint16, euint32, euint64, externalEuint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ConfidentialERC721} from "./confidential/ConfidentialERC721.sol";
import {DoNotOpenConfig} from "./DoNotOpenConfig.sol";

/// @title DO NOT OPEN
/// @notice 10,000 sealed boxes. Each holds one encrypted 64-bit seed drawn at mint; the cat
///         inside (state, five traits, rarity) is a pure function of that seed. Nobody knows who
///         holds which box, how many boxes anyone holds, or how many were sold: only milestones
///         are announced.
///
/// @dev Design notes. Read these before changing anything.
///
///  1. ONE seed ciphertext per box. State and traits are not stored encrypted: they are
///     derived from the seed when a function needs them. The encrypted rarity score is
///     computed on a box's first duel and cached.
///
///  2. NOBODY but this contract is ever allowed on the seed, the score or the affection.
///     A holder allowed on them could decrypt everything through the relayer and skip the
///     game. `shake` hands out fresh ciphertexts holding one trait.
///
///  3. Owners are encrypted (`ConfidentialERC721`). Nothing reverts on ownership: an action
///     by someone who does not hold the box does nothing, and only they learn it. So every
///     shake, transfer or opening attempt is a "maybe" to everyone else.
///
///  4. A purchase is always in cUSDC, so no amount is public. The quantity of a mint is
///     encrypted too, and a mint creates `ids` token ids (the buyer picks 1 to `maxPerTx`), of
///     which only the bought ones are owned: the rest are empty. More ids hide the quantity
///     better and cost more gas. The number sold is an encrypted counter, capped at `maxSupply`
///     under encryption; a mint past the cap gets nothing and pays nothing.
///
///  5. What must become public (an opening, a duel, an alive check, an entanglement) is a
///     request in two steps. The request computes, encrypted, "the caller holds the box" and
///     the outcome masked by it, and makes both publicly decryptable. Anyone then submits the
///     cleartexts with their KMS proof to `finalize`. A request by someone who does not hold
///     the box decrypts to "no" and to zeros: it reveals nothing about the box. A successful
///     one reveals that the caller held it, which the action makes public anyway.
///
///  6. Milestones of the sold count are announced one by one: each mint makes the single bit
///     "the next milestone is reached" publicly decryptable, and `announceMilestone` proves it.
///
///  HCU per function (protocol limit 20,000,000 per transaction): see the table in
///  packages/contracts-evm/README.md, measured by the tests.
contract DoNotOpen is ConfidentialERC721, Ownable, ZamaEthereumConfig {
    enum BoxStatus {
        Sealed,
        Revealed
    }

    enum AliveCheck {
        None,
        Alive,
        NotAlive
    }

    enum DuelStatus {
        None,
        /// Posted, waiting for the proof that the challenger holds the box.
        Posted,
        /// Proven: on the duel shelf until accepted, cancelled or out of time.
        Open,
        /// Accepted, waiting for the outcome.
        Pending,
        Resolved,
        Cancelled,
        /// The challenger did not hold the box, at posting or at acceptance: nothing happened.
        Void
    }

    enum RequestKind {
        Open,
        AliveCheck,
        Entangle
    }

    enum RequestStatus {
        None,
        Pending,
        Done,
        /// The caller did not hold the box (or could not pay): nothing happened.
        Refused
    }

    /// @dev In cUSDC's smallest unit (6 decimals).
    struct Fees {
        uint64 mint;
        uint64 observe;
        uint64 feed;
        uint64 paidShake;
    }

    struct Revealed {
        uint64 seed;
        uint8 state;
        uint8[5] traits;
        /// Rarity score, golden bonus included.
        uint16 score;
        uint32 affection;
        bool golden;
    }

    /// @dev What one viewer got from their latest shake of one box.
    struct Shake {
        /// Bit offset of the picked trait inside the seed, or NOT_YOURS.
        euint8 pick;
        /// The picked trait's roll, or 0.
        euint8 roll;
    }

    struct Duel {
        uint32 tokenA;
        /// The box that accepted, or the only one allowed to when `reserved`.
        uint32 tokenB;
        address challenger;
        DuelStatus status;
        /// Only `tokenB` may accept. Otherwise any sealed box may.
        bool reserved;
        /// Last moment it can be accepted, set once the holding is proven.
        uint64 openUntil;
        address accepter;
        /// At posting: the challenger holds A. Published, it is what puts the box on the shelf.
        ebool posted;
        /// At acceptance: the challenger still holds A.
        ebool aHolds;
        /// At acceptance: both sides hold their boxes.
        ebool valid;
        /// scoreA > scoreB, masked by `valid`. Ties go to B.
        ebool aWins;
        /// Bit offset of the trait the loser must show, masked by `valid`.
        euint8 pick;
        /// The loser's roll for that trait, masked by `valid`.
        euint8 loserRoll;
    }

    struct Request {
        RequestKind kind;
        RequestStatus status;
        address requester;
        uint32 tokenId;
        /// The partner opened along with an entangled box, or B of an entanglement. Plus one.
        uint32 other;
        /// Openings: bit 0 set if the box was ever fed, bit 1 the same for the partner. An
        ///           unfed box publishes no affection.
        uint8 fed;
    }

    error NotSealed();
    error RequestNotPending();
    error NothingToAnnounce();
    error TooManyBoxes();
    error SameBox();
    error AlreadyEntangled();
    error NoSuchProposal();
    error WrongDuelStatus();
    error NotChallenger();
    error NotThisBox();
    error DuelExpired();
    error InvalidMilestones();
    error InvalidIdCount();
    error WithdrawTooSoon();

    /// @notice A mint created `count` token ids from `firstTokenId`. How many are owned is the
    ///         encrypted `quantity`, readable by the buyer.
    event MintPlaced(uint256 indexed firstTokenId, address indexed buyer, uint256 count, euint8 quantity);
    event MilestoneReached(uint256 indexed index, uint256 sold);
    /// @dev Which trait was picked is deliberately absent: only the viewer can decrypt it.
    event Shaken(uint256 indexed tokenId, address indexed viewer, bool paid);
    event Fed(uint256 indexed tokenId, address indexed feeder);
    event RequestPlaced(uint256 indexed requestId, uint256 indexed tokenId, address indexed requester, RequestKind kind);
    event RequestSettled(uint256 indexed requestId, RequestStatus status);
    /// @notice A box opened. `openedBy` asked for it, and held the box (or its entangled partner)
    ///         then: the one ownership fact an opening makes public.
    event Observed(uint256 indexed tokenId, address indexed openedBy, uint64 seed, uint8 state, uint16 rarityScore, bool golden);
    event AliveProven(uint256 indexed tokenId, bool alive);
    event EntangleProposed(uint256 indexed tokenIdA, uint256 indexed tokenIdB, address proposer);
    event Entangled(uint256 indexed tokenIdA, uint256 indexed tokenIdB);
    /// @notice A box put up for a duel. `tokenIdB` is the only box that may accept when
    ///         `reserved`, and meaningless otherwise.
    event DuelPosted(uint256 indexed duelId, uint256 indexed tokenIdA, uint256 indexed tokenIdB, address challenger, bool reserved);
    /// @notice The challenger proved they hold the box: it is on the duel shelf until `openUntil`.
    event DuelOpened(uint256 indexed duelId, uint64 openUntil);
    event DuelCancelled(uint256 indexed duelId);
    event DuelAccepted(uint256 indexed duelId, uint256 indexed tokenIdB, address accepter);
    /// @notice The accepter did not hold the box they brought: the duel is back on the shelf.
    event DuelReopened(uint256 indexed duelId);
    event DuelResolved(
        uint256 indexed duelId,
        uint256 indexed winnerTokenId,
        uint256 indexed loserTokenId,
        uint8 revealedTraitIndex,
        uint8 revealedTraitRoll
    );
    event DuelVoided(uint256 indexed duelId);

    /// @notice Shake results for someone who did not hold the box (or did not pay): no trait
    ///         sits at this offset, so the app can tell.
    uint8 public constant NOT_YOURS = 255;
    /// @notice Boxes one `claimEarnings` may cover.
    uint256 public constant MAX_CLAIM = 10;
    /// @notice How long a proven duel stays on the shelf.
    uint64 public constant DUEL_LIFETIME = 7 days;
    /// @dev The least time between two withdrawals: the owner learns the revenue only in
    ///         sums this long, never mint by mint.
    uint64 private constant WITHDRAW_INTERVAL = 7 days;

    DoNotOpenConfig public immutable config;
    /// @notice Plain USDC: what cUSDC wraps. Prices are in its smallest unit.
    IERC20 public immutable usdc;
    /// @notice Confidential USDC (ERC-7984), the only way to pay.
    IERC7984 public immutable confidentialUsdc;
    uint64 public immutable mintPrice;
    uint64 public immutable observeFee;
    uint64 public immutable feedFee;
    uint64 public immutable paidShakeFee;

    uint16 private immutable _maxSupply;
    uint8 private immutable _maxPerTx;
    uint16 private immutable _aliveBelow;
    uint32 private immutable _goldenThreshold;
    uint16 private immutable _goldenScoreBonus;
    uint8 private immutable _feedBound;
    uint64 private immutable _holderShare;
    // Trait bit offsets, cached so a shake makes no external call.
    uint8 private immutable _offset0;
    uint8 private immutable _offset1;
    uint8 private immutable _offset2;
    uint8 private immutable _offset3;
    uint8 private immutable _offset4;

    // Splits a uniform 16-bit draw into five buckets: 13108 + 4 * 13107 = 65536.
    uint16 private constant PICK_1 = 13108;
    uint16 private constant PICK_2 = 26215;
    uint16 private constant PICK_3 = 39322;
    uint16 private constant PICK_4 = 52429;

    uint16[] private _milestones;
    /// @notice How many milestones were announced so far.
    uint256 public milestonesReached;
    uint256 public duelCount;
    uint256 public requestCount;
    string private _baseTokenURI;

    /// @dev Boxes sold, never more than `_maxSupply`. Nobody is allowed on it.
    euint16 private _sold;
    /// @dev "The sold count reached the next milestone", publicly decryptable after each mint.
    ebool private _milestoneBit;
    /// @dev cUSDC the collection earned. Nobody may read it: a readable total would tell the
    ///      owner each mint's hidden quantity, one difference at a time.
    euint64 private _revenue;
    /// @dev When the revenue was last withdrawn (the deployment counts as one).
    uint64 private _lastWithdrawal;

    mapping(address reader => bool) public trustedReader;
    mapping(uint256 tokenId => euint64) private _seed;
    mapping(uint256 tokenId => euint32) private _affection;
    mapping(uint256 tokenId => euint16) private _score;
    /// @dev The holder's share of paid shakes, waiting in the box for whoever holds it.
    mapping(uint256 tokenId => euint64) private _earnings;
    mapping(uint256 tokenId => BoxStatus) public status;
    mapping(uint256 tokenId => Revealed) private _revealed;
    mapping(uint256 tokenId => AliveCheck) public aliveCheck;
    mapping(uint256 tokenId => mapping(address viewer => Shake)) private _shakes;
    /// @dev Partner token id plus one; zero means not entangled.
    mapping(uint256 tokenId => uint256) private _partner;
    mapping(uint256 tokenIdA => mapping(uint256 tokenIdB => address proposer)) private _entangleProposal;
    mapping(uint256 duelId => Duel) private _duels;
    /// @dev The box's open duel id plus one; zero means none. One per box: a newer proven
    ///      posting replaces it.
    mapping(uint256 tokenId => uint256) private _listing;
    mapping(uint256 tokenId => uint32) public wins;
    /// @dev Traits made public by lost duels: bit i set means trait i is known.
    mapping(uint256 tokenId => uint8) private _publicTraitMask;
    mapping(uint256 tokenId => uint8[5]) private _publicTraitRoll;
    mapping(uint256 requestId => Request) private _requests;
    mapping(uint256 requestId => bytes32[]) private _requestHandles;

    constructor(
        DoNotOpenConfig config_,
        Fees memory fees,
        IERC20 usdc_,
        IERC7984 confidentialUsdc_,
        uint16[] memory milestones_,
        address owner_
    ) ConfidentialERC721("DO NOT OPEN", "DNO") Ownable(owner_) {
        config = config_;
        usdc = usdc_;
        confidentialUsdc = confidentialUsdc_;
        mintPrice = fees.mint;
        observeFee = fees.observe;
        feedFee = fees.feed;
        paidShakeFee = fees.paidShake;
        _maxSupply = config_.maxSupply();
        _maxPerTx = config_.maxPerTx();
        _aliveBelow = config_.aliveBelow();
        _goldenThreshold = config_.goldenThreshold();
        _goldenScoreBonus = config_.goldenScoreBonus();
        _feedBound = config_.feedBound();
        _holderShare = uint64((uint256(fees.paidShake) * config_.paidShakeHolderBps()) / 10_000);
        uint8[5] memory offsets = config_.traitOffsets();
        _offset0 = offsets[0];
        _offset1 = offsets[1];
        _offset2 = offsets[2];
        _offset3 = offsets[3];
        _offset4 = offsets[4];

        // Increasing, the last one is the cap: reaching it means sold out.
        for (uint256 i = 0; i < milestones_.length; i++) {
            if (milestones_[i] == 0 || (i > 0 && milestones_[i] <= milestones_[i - 1])) revert InvalidMilestones();
        }
        if (milestones_.length == 0 || milestones_[milestones_.length - 1] != _maxSupply) revert InvalidMilestones();
        _milestones = milestones_;

        _sold = FHE.asEuint16(0);
        FHE.allowThis(_sold);
        _revenue = FHE.asEuint64(0);
        FHE.allowThis(_revenue);
        _lastWithdrawal = uint64(block.timestamp);
    }

    modifier onlySealed(uint256 tokenId) {
        _requireSealed(tokenId);
        _;
    }

    /// @dev Out of the modifier so its body is not copied into every function using it.
    function _requireSealed(uint256 tokenId) internal view {
        _requireExists(tokenId);
        if (status[tokenId] != BoxStatus.Sealed) revert NotSealed();
    }

    // ------------------------------------------------------------------ mint

    /// @notice Buys an encrypted number of boxes, at most `ids`, for `mintPrice` cUSDC each.
    ///         Creates `ids` token ids either way; the buyer owns the first `quantity` of them
    ///         and can tell which from the `ConfidentialTransfer` receipts. Gets nothing and pays
    ///         nothing if the boxes would pass the cap or the buyer holds too little.
    ///         The caller must have made this contract an operator on cUSDC (`setOperator`).
    /// @param encryptedQuantity made for this contract and the caller with the Relayer SDK
    /// @param ids how many token ids to hide the quantity among, 1 to `maxPerTx`: public
    function mint(externalEuint8 encryptedQuantity, bytes calldata inputProof, uint8 ids) external returns (uint256 firstTokenId) {
        if (ids == 0 || ids > _maxPerTx) revert InvalidIdCount();
        euint8 quantity = FHE.min(FHE.fromExternal(encryptedQuantity, inputProof), ids);
        // All or nothing: past the cap, the whole mint is empty.
        euint16 after_ = FHE.add(_sold, FHE.asEuint16(quantity));
        quantity = FHE.select(FHE.le(after_, _maxSupply), quantity, FHE.asEuint8(0));

        euint64 price = FHE.mul(FHE.asEuint64(quantity), mintPrice);
        euint64 paid = _pull(price);
        _addRevenue(paid);
        // The token moves the whole price or nothing.
        quantity = FHE.select(FHE.eq(paid, price), quantity, FHE.asEuint8(0));

        euint16 sold = FHE.add(_sold, FHE.asEuint16(quantity));
        FHE.allowThis(sold);
        _sold = sold;
        _checkMilestone(sold);

        firstTokenId = tokenCount();
        eaddress buyer = FHE.asEaddress(msg.sender);
        eaddress nobody = FHE.asEaddress(address(0));
        for (uint256 i = 0; i < ids; i++) {
            uint256 tokenId = _mint(msg.sender, FHE.gt(quantity, uint8(i)), buyer, nobody);
            euint64 seed = FHE.randEuint64();
            FHE.allowThis(seed);
            _seed[tokenId] = seed;
        }
        FHE.allowThis(quantity);
        FHE.allow(quantity, msg.sender);
        emit MintPlaced(firstTokenId, msg.sender, ids, quantity);
    }

    /// @dev One bit per mint: has the sold count reached the next milestone?
    function _checkMilestone(euint16 sold) internal {
        uint256 next = milestonesReached;
        if (next >= _milestones.length) return;
        ebool reached = FHE.ge(sold, _milestones[next]);
        FHE.allowThis(reached);
        FHE.makePubliclyDecryptable(reached);
        _milestoneBit = reached;
    }

    /// @notice Announces the next milestone with the decrypted bit and its KMS proof. Anyone may.
    function announceMilestone(bytes calldata abiEncodedReached, bytes calldata decryptionProof) external {
        uint256 next = milestonesReached;
        if (next >= _milestones.length || !FHE.isInitialized(_milestoneBit)) revert NothingToAnnounce();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(_milestoneBit);
        FHE.checkSignatures(handles, abiEncodedReached, decryptionProof);
        if (!abi.decode(abiEncodedReached, (bool))) revert NothingToAnnounce();

        milestonesReached = next + 1;
        emit MilestoneReached(next, _milestones[next]);
        // The bit was about this milestone; the next mint asks about the following one.
        _milestoneBit = ebool.wrap(0);
    }

    /// @notice Handle to pass to the relayer's publicDecrypt before `announceMilestone`. Zero
    ///         when there is nothing to ask.
    function milestoneHandle() external view returns (bytes32) {
        return FHE.toBytes32(_milestoneBit);
    }

    function milestones() external view returns (uint16[] memory) {
        return _milestones;
    }

    // ----------------------------------------------------------------- shake

    /// @notice The holder learns ONE trait, picked at random by the contract. Unlimited, free.
    ///         Anyone else gets `NOT_YOURS` and a zero.
    /// @dev Never touches the state roll: the five possible picks are the five trait bytes.
    function shake(uint256 tokenId) external onlySealed(tokenId) returns (euint8 pick, euint8 roll) {
        (pick, roll) = _shakeFor(tokenId, msg.sender, _isOwner(tokenId, msg.sender));
        emit Shaken(tokenId, msg.sender, false);
    }

    /// @notice Anyone pays `paidShakeFee` cUSDC to shake a box. Only the payer can read the
    ///         result. The holder's share waits in the box (`claimEarnings`).
    function paidShake(uint256 tokenId) external onlySealed(tokenId) returns (euint8 pick, euint8 roll) {
        euint64 fee = FHE.asEuint64(paidShakeFee);
        euint64 paid = _pull(fee);
        ebool ok = FHE.eq(paid, fee);
        // An empty id has no holder to claim its share: the whole fee is revenue then.
        euint64 share = FHE.select(FHE.and(ok, FHE.not(_isOwner(tokenId, address(0)))), FHE.asEuint64(_holderShare), FHE.asEuint64(0));
        euint64 earnings = FHE.add(_earnings[tokenId], share);
        FHE.allowThis(earnings);
        _earnings[tokenId] = earnings;
        _addRevenue(FHE.sub(paid, share));

        (pick, roll) = _shakeFor(tokenId, msg.sender, ok);
        emit Shaken(tokenId, msg.sender, true);
    }

    /// @notice Pays the caller what paid shakes earned the listed boxes they hold. Boxes they
    ///         do not hold pay 0 and keep their earnings.
    function claimEarnings(uint256[] calldata tokenIds) external {
        if (tokenIds.length > MAX_CLAIM) revert TooManyBoxes();
        euint64 total = FHE.asEuint64(0);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            euint64 earned = _earnings[tokenId];
            if (!FHE.isInitialized(earned)) continue;
            euint64 mine = FHE.select(_isOwner(tokenId, msg.sender), earned, FHE.asEuint64(0));
            euint64 left = FHE.sub(earned, mine);
            FHE.allowThis(left);
            _earnings[tokenId] = left;
            total = FHE.add(total, mine);
        }
        _pay(msg.sender, total);
    }

    /// @dev Uniform encrypted choice among the five trait offsets. Being encrypted, it
    ///      cannot be predicted, or ground by resubmitting.
    function _randomPick() internal returns (euint8 pick) {
        euint16 draw = FHE.randEuint16();
        pick = FHE.asEuint8(_offset0);
        pick = FHE.select(FHE.ge(draw, PICK_1), FHE.asEuint8(_offset1), pick);
        pick = FHE.select(FHE.ge(draw, PICK_2), FHE.asEuint8(_offset2), pick);
        pick = FHE.select(FHE.ge(draw, PICK_3), FHE.asEuint8(_offset3), pick);
        pick = FHE.select(FHE.ge(draw, PICK_4), FHE.asEuint8(_offset4), pick);
    }

    /// @dev Shifts the picked byte down to bits 0..7; the downcast keeps only those.
    function _rollAt(uint256 tokenId, euint8 pick) internal returns (euint8) {
        return FHE.asEuint8(FHE.shr(_seed[tokenId], pick));
    }

    /// @dev Both results are fresh ciphertexts; granting the viewer access to them says
    ///      nothing about the seed they were cut from. Masked when `ok` is false.
    function _shakeFor(uint256 tokenId, address viewer, ebool ok) internal returns (euint8 pick, euint8 roll) {
        euint8 picked = _randomPick();
        pick = FHE.select(ok, picked, FHE.asEuint8(NOT_YOURS));
        roll = FHE.select(ok, _rollAt(tokenId, picked), FHE.asEuint8(0));
        // The relayer requires the contract itself to be allowed on anything a user decrypts.
        FHE.allowThis(pick);
        FHE.allowThis(roll);
        FHE.allow(pick, viewer);
        FHE.allow(roll, viewer);
        _shakes[tokenId][viewer] = Shake(pick, roll);
    }

    /// @notice Handles of `viewer`'s latest shake of `tokenId`. Zero if they never shook it.
    function lastShake(uint256 tokenId, address viewer) external view returns (euint8 pick, euint8 roll) {
        Shake storage s = _shakes[tokenId][viewer];
        return (s.pick, s.roll);
    }

    // ------------------------------------------------------------------ feed

    /// @notice Anyone can feed a sealed box for `feedFee` cUSDC. The cat gains a hidden amount
    ///         of affection, possibly none. Past the golden threshold, its accessory turns golden.
    /// @dev A feed that was not paid adds nothing. So the number of feeds says nothing either,
    ///      and is not kept.
    function feed(uint256 tokenId) external onlySealed(tokenId) {
        euint64 fee = FHE.asEuint64(feedFee);
        euint64 paid = _pull(fee);
        _addRevenue(paid);
        euint32 gain = FHE.select(FHE.eq(paid, fee), FHE.asEuint32(FHE.randEuint8(_feedBound)), FHE.asEuint32(0));
        euint32 affection = FHE.add(_affection[tokenId], gain);
        FHE.allowThis(affection);
        _affection[tokenId] = affection;
        emit Fed(tokenId, msg.sender);
    }

    // --------------------------------------------------------------- observe

    /// @notice Opens the box for `observeFee` cUSDC. Irreversible. Step 1 of 2: makes "the caller
    ///         holds it and paid" publicly decryptable, with the seed and affection masked by it,
    ///         and those of an entangled partner. Anyone then calls `finalize`.
    function observe(uint256 tokenId) external onlySealed(tokenId) returns (uint256 requestId) {
        ebool holds = _isOwner(tokenId, msg.sender);
        euint64 fee = FHE.asEuint64(observeFee);
        // Only a holder is charged. The fee is revenue once the box opens, and goes back if its
        // entangled partner opened it first: until then it is in no account.
        euint64 paid = _pull(FHE.select(holds, fee, FHE.asEuint64(0)));
        ebool ok = FHE.and(holds, FHE.eq(paid, fee));

        uint256 partner = _partner[tokenId];
        bool withPartner = partner != 0 && status[partner - 1] == BoxStatus.Sealed;
        requestId = _newRequest(RequestKind.Open, tokenId, withPartner ? partner : 0);
        bytes32[] storage handles = _requestHandles[requestId];
        handles.push(_publish(ok));
        uint8 fed = _pushContents(handles, ok, tokenId) ? 1 : 0;
        if (withPartner && _pushContents(handles, ok, partner - 1)) fed |= 2;
        _requests[requestId].fed = fed;
    }

    /// @dev The seed, and the affection if the box was ever fed, masked by `ok`. An unfed box has
    ///      none: publishing a zero for it would put the same handle twice in one request.
    function _pushContents(bytes32[] storage handles, ebool ok, uint256 tokenId) internal returns (bool fed) {
        handles.push(_publish(FHE.select(ok, _seed[tokenId], FHE.asEuint64(0))));
        euint32 affection = _affection[tokenId];
        fed = FHE.isInitialized(affection);
        if (fed) handles.push(_publish(FHE.select(ok, affection, FHE.asEuint32(0))));
    }

    function _reveal(uint256 tokenId, uint64 seed, uint32 affection, address openedBy) internal {
        if (status[tokenId] != BoxStatus.Sealed) return;
        (uint8 state, uint8[5] memory traits, uint16 score) = config.decode(seed);
        bool golden = affection > _goldenThreshold;
        if (golden) score += _goldenScoreBonus;

        status[tokenId] = BoxStatus.Revealed;
        _revealed[tokenId] = Revealed({
            seed: seed,
            state: state,
            traits: traits,
            score: score,
            affection: affection,
            golden: golden
        });
        emit Observed(tokenId, openedBy, seed, state, score, golden);
    }

    /// @notice True once the box has been opened and its contents stored in the clear.
    function revealed(uint256 tokenId) external view returns (bool) {
        return status[tokenId] == BoxStatus.Revealed;
    }

    /// @notice Plaintext contents of an opened box. All zero while sealed.
    function contentsOf(uint256 tokenId) external view returns (Revealed memory) {
        return _revealed[tokenId];
    }

    /// @notice Handle of the encrypted seed. A handle is an identifier, not the value.
    function seedHandle(uint256 tokenId) external view returns (bytes32) {
        return FHE.toBytes32(_seed[tokenId]);
    }

    // ------------------------------------------------------------ proveAlive

    /// @notice Step 1 of 2. Computes the bit "is it alive", masked by "the caller holds it", and
    ///         makes both publicly decryptable. The answer becomes public whichever way it falls.
    function proveAlive(uint256 tokenId) external onlySealed(tokenId) returns (uint256 requestId) {
        if (aliveCheck[tokenId] != AliveCheck.None) revert NotSealed();
        ebool holds = _isOwner(tokenId, msg.sender);
        // The state roll is the low 16 bits of the seed; "alive" is the lowest range.
        ebool alive = FHE.and(holds, FHE.lt(FHE.asEuint16(_seed[tokenId]), _aliveBelow));
        requestId = _newRequest(RequestKind.AliveCheck, tokenId, 0);
        _requestHandles[requestId].push(_publish(holds));
        _requestHandles[requestId].push(_publish(alive));
    }

    /// @notice The "Vet Certified" badge: the box was proven alive while still sealed.
    function vetCertified(uint256 tokenId) external view returns (bool) {
        return aliveCheck[tokenId] == AliveCheck.Alive;
    }

    // -------------------------------------------------------------- entangle

    /// @notice Step 1 of 3: proposes to link A and B. Only counts if the caller holds A when
    ///         the holder of B accepts.
    function proposeEntangle(uint256 tokenIdA, uint256 tokenIdB) external {
        _checkEntangleable(tokenIdA, tokenIdB);
        _entangleProposal[tokenIdA][tokenIdB] = msg.sender;
        emit EntangleProposed(tokenIdA, tokenIdB, msg.sender);
    }

    /// @notice Step 2 of 3: the holder of B accepts. Makes "the proposer holds A and the caller
    ///         holds B" publicly decryptable. From `finalize` on, opening either opens both.
    function acceptEntangle(uint256 tokenIdA, uint256 tokenIdB) external returns (uint256 requestId) {
        address proposer = _entangleProposal[tokenIdA][tokenIdB];
        if (proposer == address(0)) revert NoSuchProposal();
        _checkEntangleable(tokenIdA, tokenIdB);
        ebool ok = FHE.and(_isOwner(tokenIdA, proposer), _isOwner(tokenIdB, msg.sender));
        requestId = _newRequest(RequestKind.Entangle, tokenIdA, tokenIdB + 1);
        _requestHandles[requestId].push(_publish(ok));
    }

    function _checkEntangleable(uint256 tokenIdA, uint256 tokenIdB) internal view {
        if (tokenIdA == tokenIdB) revert SameBox();
        _requireExists(tokenIdA);
        _requireExists(tokenIdB);
        if (status[tokenIdA] != BoxStatus.Sealed || status[tokenIdB] != BoxStatus.Sealed) revert NotSealed();
        if (_partner[tokenIdA] != 0 || _partner[tokenIdB] != 0) revert AlreadyEntangled();
    }

    /// @notice Who proposed to entangle A with B, or zero.
    function entangleProposer(uint256 tokenIdA, uint256 tokenIdB) external view returns (address) {
        return _entangleProposal[tokenIdA][tokenIdB];
    }

    /// @notice The box `tokenId` is entangled with, if any.
    function partnerOf(uint256 tokenId) external view returns (bool entangled, uint256 partner) {
        uint256 p = _partner[tokenId];
        return p == 0 ? (false, 0) : (true, p - 1);
    }

    // -------------------------------------------------------------- requests

    /// @notice Step 2 of 2 of an opening, an alive check or an entanglement. Anyone may submit
    ///         the decrypted values with their KMS proof.
    /// @param abiEncodedCleartexts `abiEncodedClearValues` returned by the relayer's publicDecrypt
    /// @param decryptionProof `decryptionProof` returned by the relayer's publicDecrypt
    /// @dev The handle list is the one stored at the request, never the caller's, so a valid
    ///      proof for another request cannot be replayed here.
    function finalize(uint256 requestId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof) external {
        Request storage r = _requests[requestId];
        if (r.status != RequestStatus.Pending) revert RequestNotPending();
        FHE.checkSignatures(_requestHandles[requestId], abiEncodedCleartexts, decryptionProof);

        bool ok = abi.decode(abiEncodedCleartexts[:32], (bool));
        r.status = ok ? RequestStatus.Done : RequestStatus.Refused;
        if (ok) {
            if (r.kind == RequestKind.Open) _settleOpen(r, abiEncodedCleartexts);
            else if (r.kind == RequestKind.AliveCheck) {
                (, bool alive) = abi.decode(abiEncodedCleartexts, (bool, bool));
                _settleAlive(r.tokenId, alive);
            } else _settleEntangle(r.tokenId, r.other - 1);
        }
        emit RequestSettled(requestId, r.status);
    }

    function _settleOpen(Request storage r, bytes calldata cleartexts) internal {
        euint64 fee = FHE.asEuint64(observeFee);
        if (status[r.tokenId] != BoxStatus.Sealed) {
            // Opened meanwhile, by its entangled partner: the fee goes back.
            _pay(r.requester, fee);
            return;
        }
        _addRevenue(fee);
        // Words after the "ok" bit: seed, [affection], then the partner's seed, [affection].
        uint256 at = 1;
        uint64 seed = uint64(_word(cleartexts, at++));
        uint32 affection = r.fed & 1 != 0 ? uint32(_word(cleartexts, at++)) : 0;
        _reveal(r.tokenId, seed, affection, r.requester);
        if (r.other != 0) {
            seed = uint64(_word(cleartexts, at++));
            affection = r.fed & 2 != 0 ? uint32(_word(cleartexts, at)) : 0;
            _reveal(r.other - 1, seed, affection, r.requester);
        }
    }

    function _word(bytes calldata data, uint256 i) internal pure returns (uint256) {
        return abi.decode(data[i * 32:(i + 1) * 32], (uint256));
    }

    function _settleAlive(uint256 tokenId, bool alive) internal {
        if (aliveCheck[tokenId] != AliveCheck.None || status[tokenId] != BoxStatus.Sealed) return;
        aliveCheck[tokenId] = alive ? AliveCheck.Alive : AliveCheck.NotAlive;
        emit AliveProven(tokenId, alive);
    }

    function _settleEntangle(uint256 tokenIdA, uint256 tokenIdB) internal {
        delete _entangleProposal[tokenIdA][tokenIdB];
        if (status[tokenIdA] != BoxStatus.Sealed || status[tokenIdB] != BoxStatus.Sealed) return;
        if (_partner[tokenIdA] != 0 || _partner[tokenIdB] != 0) return;
        _partner[tokenIdA] = tokenIdB + 1;
        _partner[tokenIdB] = tokenIdA + 1;
        emit Entangled(tokenIdA, tokenIdB);
    }

    function _newRequest(RequestKind kind, uint256 tokenId, uint256 other) internal returns (uint256 requestId) {
        requestId = requestCount++;
        _requests[requestId] = Request({
            kind: kind,
            status: RequestStatus.Pending,
            requester: msg.sender,
            tokenId: uint32(tokenId),
            other: uint32(other),
            fed: 0
        });
        emit RequestPlaced(requestId, tokenId, msg.sender, kind);
    }

    function _publish(ebool value) internal returns (bytes32) {
        FHE.allowThis(value);
        FHE.makePubliclyDecryptable(value);
        return FHE.toBytes32(value);
    }

    function _publish(euint64 value) internal returns (bytes32) {
        FHE.allowThis(value);
        FHE.makePubliclyDecryptable(value);
        return FHE.toBytes32(value);
    }

    function _publish(euint8 value) internal returns (bytes32) {
        FHE.allowThis(value);
        FHE.makePubliclyDecryptable(value);
        return FHE.toBytes32(value);
    }

    function _publish(euint32 value) internal returns (bytes32) {
        FHE.allowThis(value);
        FHE.makePubliclyDecryptable(value);
        return FHE.toBytes32(value);
    }

    /// @notice One request. `handles` is what to pass, in this order, to the relayer's
    ///         publicDecrypt before `finalize`. `other` is the partner or B, plus one.
    function requestInfo(
        uint256 requestId
    )
        external
        view
        returns (RequestKind kind, RequestStatus requestStatus, address requester, uint256 tokenId, uint256 other, bytes32[] memory handles)
    {
        Request storage r = _requests[requestId];
        return (r.kind, r.status, r.requester, r.tokenId, r.other, _requestHandles[requestId]);
    }

    // ------------------------------------------------------------------ duel

    /// @notice Step 1 of 4: puts box A up for a duel that any sealed box may accept, or only
    ///         box B when `reserved`. Makes "the caller holds A" publicly decryptable: a duel is
    ///         a public act, and the shelf only shows boxes their challenger was proven to hold.
    ///         Anyone then calls `finalizeDuel` with the proof.
    /// @param tokenIdB ignored unless `reserved`
    function postDuel(uint256 tokenIdA, uint256 tokenIdB, bool reserved) external onlySealed(tokenIdA) returns (uint256 duelId) {
        if (reserved) {
            if (tokenIdA == tokenIdB) revert SameBox();
            _requireSealed(tokenIdB);
        } else tokenIdB = 0;
        // The challenger pays for their own box's score; the accepter pays for theirs.
        _ensureScore(tokenIdA);
        duelId = duelCount++;
        Duel storage d = _duels[duelId];
        d.tokenA = uint32(tokenIdA);
        d.tokenB = uint32(tokenIdB);
        d.reserved = reserved;
        d.challenger = msg.sender;
        d.status = DuelStatus.Posted;
        d.posted = _isOwner(tokenIdA, msg.sender);
        _publish(d.posted);
        emit DuelPosted(duelId, tokenIdA, tokenIdB, msg.sender, reserved);
    }

    /// @notice Takes a duel off the shelf, before anyone accepts it.
    function cancelDuel(uint256 duelId) external {
        Duel storage d = _duels[duelId];
        if (d.status != DuelStatus.Posted && d.status != DuelStatus.Open) revert WrongDuelStatus();
        if (d.challenger != msg.sender) revert NotChallenger();
        _close(duelId, d, DuelStatus.Cancelled);
        emit DuelCancelled(duelId);
    }

    /// @notice Step 3 of 4: box B takes the duel up. Computes, encrypted, whether the challenger
    ///         still holds A, whether both sides hold their boxes, who wins and which trait the
    ///         loser must show, the last three masked by the second, and makes those five values
    ///         public.
    /// @dev The loser's roll is selected under encryption, so the winner's trait is never
    ///      decryptable by anyone. "B is held by the caller" only ever shows when A was held:
    ///      a duel voided by its challenger says nothing about the accepter.
    function acceptDuel(uint256 duelId, uint256 tokenIdB) external onlySealed(tokenIdB) {
        Duel storage d = _duels[duelId];
        if (d.status != DuelStatus.Open) revert WrongDuelStatus();
        if (block.timestamp > d.openUntil) revert DuelExpired();
        uint256 a = d.tokenA;
        if (tokenIdB == a) revert SameBox();
        if (d.reserved && tokenIdB != d.tokenB) revert NotThisBox();
        if (status[a] != BoxStatus.Sealed) revert NotSealed();

        ebool aHolds = _isOwner(a, d.challenger);
        ebool valid = FHE.and(aHolds, _isOwner(tokenIdB, msg.sender));
        ebool aWins = FHE.gt(_ensureScore(a), _ensureScore(tokenIdB));
        euint8 pick = _randomPick();
        euint8 loserRoll = FHE.select(aWins, _rollAt(tokenIdB, pick), _rollAt(a, pick));
        euint8 zero = FHE.asEuint8(0);

        d.aHolds = aHolds;
        d.valid = valid;
        d.aWins = FHE.and(valid, aWins);
        d.pick = FHE.select(valid, pick, zero);
        d.loserRoll = FHE.select(valid, loserRoll, zero);
        _publish(aHolds);
        _publish(valid);
        _publish(d.aWins);
        _publish(d.pick);
        _publish(d.loserRoll);
        d.tokenB = uint32(tokenIdB);
        d.accepter = msg.sender;
        d.status = DuelStatus.Pending;
        emit DuelAccepted(duelId, tokenIdB, msg.sender);
    }

    /// @notice Handles to pass, in this order, to the relayer's publicDecrypt before calling
    ///         `finalizeDuel`. After posting: "the challenger holds A". After acceptance: "A is
    ///         still held", "both boxes are held", then masked by the latter "A wins" (ties go to
    ///         B), the bit offset of the trait the loser shows, and the loser's roll for it.
    ///         Only meaningful while the duel is Posted or Pending.
    function duelHandles(uint256 duelId) public view returns (bytes32[] memory handles) {
        Duel storage d = _duels[duelId];
        if (d.status == DuelStatus.Posted) {
            handles = new bytes32[](1);
            handles[0] = FHE.toBytes32(d.posted);
        } else if (d.status == DuelStatus.Pending) {
            handles = new bytes32[](5);
            handles[0] = FHE.toBytes32(d.aHolds);
            handles[1] = FHE.toBytes32(d.valid);
            handles[2] = FHE.toBytes32(d.aWins);
            handles[3] = FHE.toBytes32(d.pick);
            handles[4] = FHE.toBytes32(d.loserRoll);
        }
    }

    /// @notice Steps 2 and 4 of 4. Anyone may submit the decrypted values with their KMS proof.
    ///         After posting: puts the box on the shelf, or voids the duel if the challenger did
    ///         not hold it. After acceptance: publishes the outcome; voids the duel if the
    ///         challenger no longer held A; puts it back on the shelf if the accepter did not
    ///         hold B, so nobody can clear the shelf with boxes they do not have.
    function finalizeDuel(uint256 duelId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof) external {
        Duel storage d = _duels[duelId];
        if (d.status == DuelStatus.Posted) {
            FHE.checkSignatures(duelHandles(duelId), abiEncodedCleartexts, decryptionProof);
            if (!abi.decode(abiEncodedCleartexts, (bool))) {
                d.status = DuelStatus.Void;
                emit DuelVoided(duelId);
                return;
            }
            uint256 previous = _listing[d.tokenA];
            if (previous != 0) {
                Duel storage p = _duels[previous - 1];
                // An accepted duel runs to its end: the new posting gives way to it, or its
                // challenger could read the outcome and escape a loss.
                if (p.status == DuelStatus.Pending) {
                    d.status = DuelStatus.Cancelled;
                    emit DuelCancelled(duelId);
                    return;
                }
                p.status = DuelStatus.Cancelled;
                emit DuelCancelled(previous - 1);
            }
            _listing[d.tokenA] = duelId + 1;
            d.status = DuelStatus.Open;
            d.openUntil = uint64(block.timestamp) + DUEL_LIFETIME;
            emit DuelOpened(duelId, d.openUntil);
            return;
        }
        if (d.status != DuelStatus.Pending) revert WrongDuelStatus();

        FHE.checkSignatures(duelHandles(duelId), abiEncodedCleartexts, decryptionProof);
        (bool aHolds, bool valid, bool aWins, uint8 pick, uint8 roll) = abi.decode(abiEncodedCleartexts, (bool, bool, bool, uint8, uint8));
        if (!aHolds) {
            _close(duelId, d, DuelStatus.Void);
            emit DuelVoided(duelId);
            return;
        }
        if (!valid) {
            d.status = DuelStatus.Open;
            d.accepter = address(0);
            if (!d.reserved) d.tokenB = 0;
            emit DuelReopened(duelId);
            return;
        }

        (uint256 winner, uint256 loser) = aWins ? (uint256(d.tokenA), uint256(d.tokenB)) : (uint256(d.tokenB), uint256(d.tokenA));
        uint8 traitIndex = _traitIndexAt(pick);

        _close(duelId, d, DuelStatus.Resolved);
        wins[winner] += 1;
        _publicTraitMask[loser] |= uint8(1 << traitIndex);
        _publicTraitRoll[loser][traitIndex] = roll;
        emit DuelResolved(duelId, winner, loser, traitIndex, roll);
    }

    /// @dev Ends a duel and takes it off its box's listing if it was the one there.
    function _close(uint256 duelId, Duel storage d, DuelStatus final_) internal {
        d.status = final_;
        if (_listing[d.tokenA] == duelId + 1) delete _listing[d.tokenA];
    }

    function duelInfo(
        uint256 duelId
    )
        external
        view
        returns (uint256 tokenIdA, uint256 tokenIdB, address challenger, DuelStatus duelStatus, address accepter, bool reserved, uint64 openUntil)
    {
        Duel storage d = _duels[duelId];
        return (d.tokenA, d.tokenB, d.challenger, d.status, d.accepter, d.reserved, d.openUntil);
    }

    /// @notice Traits of a still-sealed box made public by lost duels.
    /// @return mask bit i set means trait i is public
    /// @return rolls the public rolls; entries whose bit is not set are meaningless
    function publicTraitsOf(uint256 tokenId) external view returns (uint8 mask, uint8[5] memory rolls) {
        return (_publicTraitMask[tokenId], _publicTraitRoll[tokenId]);
    }

    function _traitIndexAt(uint8 offset) internal view returns (uint8) {
        if (offset == _offset0) return 0;
        if (offset == _offset1) return 1;
        if (offset == _offset2) return 2;
        if (offset == _offset3) return 3;
        return 4;
    }

    /// @dev Encrypted rarity score: state bonus plus the weighted sum of the five trait rolls.
    ///      Same formula as `DoNotOpenConfig.decode`, under encryption. Computed once per box.
    function _ensureScore(uint256 tokenId) internal returns (euint16 score) {
        score = _score[tokenId];
        if (FHE.isInitialized(score)) return score;

        euint64 seed = _seed[tokenId];
        uint16[3] memory below = config.stateRollBelow();
        uint16[4] memory bonus = config.stateScoreBonus();
        uint8[5] memory offsets = config.traitOffsets();
        uint8[5] memory weights = config.traitWeights();

        euint16 stateRoll = FHE.asEuint16(seed);
        score = FHE.asEuint16(bonus[0]);
        for (uint256 i = 0; i < 3; i++) {
            score = FHE.select(FHE.ge(stateRoll, below[i]), FHE.asEuint16(bonus[i + 1]), score);
        }
        for (uint256 i = 0; i < 5; i++) {
            euint16 roll = FHE.asEuint16(FHE.asEuint8(FHE.shr(seed, offsets[i])));
            if (weights[i] != 1) roll = FHE.mul(roll, uint16(weights[i]));
            score = FHE.add(score, roll);
        }
        FHE.allowThis(score);
        _score[tokenId] = score;
    }

    // ---------------------------------------------------------------- money

    /// @dev Pulls `amount` cUSDC from the caller: all of it, or 0 if they hold less. Returns
    ///      what arrived.
    function _pull(euint64 amount) internal returns (euint64) {
        FHE.allowTransient(amount, address(confidentialUsdc));
        return confidentialUsdc.confidentialTransferFrom(msg.sender, address(this), amount);
    }

    function _pay(address to, euint64 amount) internal {
        FHE.allowTransient(amount, address(confidentialUsdc));
        confidentialUsdc.confidentialTransfer(to, amount);
    }

    function _addRevenue(euint64 amount) internal {
        euint64 revenue = FHE.add(_revenue, amount);
        FHE.allowThis(revenue);
        _revenue = revenue;
    }

    // ----------------------------------------------------------------- admin

    /// @notice Lets `reader` ask `isOwner` about anyone: the collection's own game contracts.
    function setTrustedReader(address reader, bool trusted) external onlyOwner {
        trustedReader[reader] = trusted;
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
    }

    /// @notice Sends the cUSDC revenue to `to`, at most once per `WITHDRAW_INTERVAL`.
    function withdraw(address to) external onlyOwner {
        if (block.timestamp < _lastWithdrawal + WITHDRAW_INTERVAL) revert WithdrawTooSoon();
        _lastWithdrawal = uint64(block.timestamp);
        euint64 amount = _revenue;
        euint64 zero = FHE.asEuint64(0);
        FHE.allowThis(zero);
        _revenue = zero;
        _pay(to, amount);
    }

    function maxSupply() external view returns (uint256) {
        return _maxSupply;
    }

    function maxPerTx() external view returns (uint256) {
        return _maxPerTx;
    }

    function _isTrustedReader(address reader) internal view override returns (bool) {
        return trustedReader[reader];
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
