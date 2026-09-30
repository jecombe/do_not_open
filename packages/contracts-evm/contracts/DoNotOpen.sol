// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint16, euint32, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DoNotOpenConfig} from "./DoNotOpenConfig.sol";

/// @title DO NOT OPEN
/// @notice 5,000 sealed boxes. Each holds one encrypted 64-bit seed drawn at mint; the cat
///         inside (state, five traits, rarity) is a pure function of that seed.
///
/// @dev Design notes. Read these before changing anything.
///
///  1. ONE seed ciphertext per box. State and traits are not stored encrypted: they are
///     derived from the seed when a function needs them. Mint costs a single FHE operation.
///     The encrypted rarity score is computed on a box's first duel and cached.
///
///  2. NOBODY but this contract is ever allowed on the seed, the score or the affection.
///     A holder allowed on them could decrypt everything through the relayer and skip the
///     game. `shake` hands out fresh ciphertexts holding one trait; that is the only thing
///     anyone can privately decrypt.
///
///  3. Because of (2) a transfer has no ACL to move and nothing to revoke. FHE.allow grants
///     are permanent on this protocol, so a design that granted the holder anything durable
///     could not take it back.
///
///  4. Public decryption has no on-chain callback. A request marks ciphertexts publicly
///     decryptable; anyone then fetches the cleartexts and KMS proof off-chain and submits
///     them to the matching `finalize*` function, which verifies the proof against handles
///     it rebuilds from its own storage.
///
///  5. ETH never leaves in the middle of game logic. Holder earnings from paid shakes are
///     credited and pulled with `claim`.
///
///  HCU per function (FHE cost, protocol limit 20,000,000 per transaction), measured in tests:
///    mint            24,000 per box   one randEuint64
///    shake / paidShake  ~672,000      randEuint16, 4 scalar ge, 4 select, 1 encrypted shr
///    feed           ~148,000          randEuint8, one 32-bit add
///    proveAlive      ~58,000          one scalar lt on 16 bits
///    challengeDuel  ~1,351,000        first score of box A (0 if already cached)
///    acceptDuel     ~2,372,000        first score of box B, gt, pick, 2 encrypted shr, select
///    observe, entangle, finalize*, claim, transfer: 0
contract DoNotOpen is ERC721, Ownable, ZamaEthereumConfig {
    enum BoxStatus {
        Sealed,
        Observing,
        Revealed
    }

    enum AliveCheck {
        None,
        Pending,
        Alive,
        NotAlive
    }

    enum DuelStatus {
        None,
        Challenged,
        Pending,
        Resolved,
        Cancelled
    }

    struct Fees {
        uint256 mint;
        uint256 observe;
        uint256 feed;
        uint256 paidShake;
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
        /// Bit offset of the picked trait inside the seed (see the seed layout in game-spec).
        euint8 pick;
        /// The picked trait's roll.
        euint8 roll;
    }

    struct Duel {
        uint32 tokenA;
        uint32 tokenB;
        address challenger;
        DuelStatus status;
        /// scoreA > scoreB. Ties go to B.
        ebool aWins;
        /// Bit offset of the trait the loser must show.
        euint8 pick;
        /// The loser's roll for that trait.
        euint8 loserRoll;
    }

    error InvalidQuantity();
    error SoldOut();
    error WrongPayment(uint256 expected);
    error NotHolder();
    error NotSealed();
    error NotObserving();
    error AliveCheckAlreadyRequested();
    error AliveCheckNotPending();
    error HolderShakesForFree();
    error NothingToClaim();
    error TransferFailed();
    error SameBox();
    error AlreadyEntangled();
    error NoSuchProposal();
    error WrongDuelStatus();
    error ChallengerNoLongerHolds();

    event Minted(uint256 indexed tokenId, address indexed owner);
    /// @dev Which trait was picked is deliberately absent: only the viewer can decrypt it.
    event Shaken(uint256 indexed tokenId, address indexed viewer, bool paid);
    event Fed(uint256 indexed tokenId, address indexed feeder);
    event ObserveRequested(uint256 indexed tokenId);
    event Observed(uint256 indexed tokenId, uint64 seed, uint8 state, uint16 rarityScore, bool golden);
    event AliveCheckRequested(uint256 indexed tokenId, bytes32 aliveHandle);
    event AliveProven(uint256 indexed tokenId, bool alive);
    event EntangleProposed(uint256 indexed tokenIdA, uint256 indexed tokenIdB);
    event Entangled(uint256 indexed tokenIdA, uint256 indexed tokenIdB);
    event DuelChallenged(uint256 indexed duelId, uint256 indexed tokenIdA, uint256 indexed tokenIdB);
    event DuelCancelled(uint256 indexed duelId);
    event DuelAccepted(uint256 indexed duelId);
    event DuelResolved(
        uint256 indexed duelId,
        uint256 indexed winnerTokenId,
        uint256 indexed loserTokenId,
        uint8 revealedTraitIndex,
        uint8 revealedTraitRoll
    );

    DoNotOpenConfig public immutable config;
    uint256 public immutable mintPrice;
    uint256 public immutable observeFee;
    uint256 public immutable feedFee;
    uint256 public immutable paidShakeFee;

    uint16 private immutable _maxSupply;
    uint8 private immutable _maxPerTx;
    uint16 private immutable _aliveBelow;
    uint32 private immutable _goldenThreshold;
    uint16 private immutable _goldenScoreBonus;
    uint8 private immutable _feedBound;
    uint16 private immutable _holderBps;
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

    uint256 public totalMinted;
    uint256 public duelCount;
    /// @notice ETH owed to holders for paid shakes, not yet claimed.
    uint256 public totalCredits;
    string private _baseTokenURI;

    mapping(uint256 tokenId => euint64) private _seed;
    mapping(uint256 tokenId => euint32) private _affection;
    mapping(uint256 tokenId => euint16) private _score;
    mapping(uint256 tokenId => BoxStatus) public status;
    mapping(uint256 tokenId => Revealed) private _revealed;
    mapping(uint256 tokenId => AliveCheck) public aliveCheck;
    mapping(uint256 tokenId => ebool) private _aliveBit;
    mapping(uint256 tokenId => mapping(address viewer => Shake)) private _shakes;
    mapping(address holder => uint256) public credits;
    /// @dev Partner token id plus one; zero means not entangled.
    mapping(uint256 tokenId => uint256) private _partner;
    mapping(uint256 tokenIdA => mapping(uint256 tokenIdB => address proposer)) private _entangleProposal;
    mapping(uint256 duelId => Duel) private _duels;
    mapping(uint256 tokenId => uint32) public wins;
    /// @notice How many times each box was fed. Public; what the feeding earned is not.
    mapping(uint256 tokenId => uint32) public feedCount;
    /// @dev Traits made public by lost duels: bit i set means trait i is known.
    mapping(uint256 tokenId => uint8) private _publicTraitMask;
    mapping(uint256 tokenId => uint8[5]) private _publicTraitRoll;

    constructor(
        DoNotOpenConfig config_,
        Fees memory fees,
        address owner_
    ) ERC721("DO NOT OPEN", "DNO") Ownable(owner_) {
        config = config_;
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
        _holderBps = config_.paidShakeHolderBps();
        uint8[5] memory offsets = config_.traitOffsets();
        _offset0 = offsets[0];
        _offset1 = offsets[1];
        _offset2 = offsets[2];
        _offset3 = offsets[3];
        _offset4 = offsets[4];
    }

    modifier onlyHolder(uint256 tokenId) {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        _;
    }

    modifier onlySealed(uint256 tokenId) {
        if (status[tokenId] != BoxStatus.Sealed) revert NotSealed();
        _;
    }

    modifier costs(uint256 fee) {
        if (msg.value != fee) revert WrongPayment(fee);
        _;
    }

    // ------------------------------------------------------------------ mint

    /// @notice Mints `quantity` sealed boxes. Each gets its own encrypted random seed.
    /// @dev The seed comes from the protocol's encrypted PRNG. Its value is unknown to the
    ///      minter, the deployer and block producers, so there is nothing to front-run or grind.
    ///      `_mint` is used instead of `_safeMint`: no receiver callback, no re-entrancy surface.
    function mint(uint256 quantity) external payable {
        if (quantity == 0 || quantity > _maxPerTx) revert InvalidQuantity();
        uint256 first = totalMinted;
        if (first + quantity > _maxSupply) revert SoldOut();
        if (msg.value != mintPrice * quantity) revert WrongPayment(mintPrice * quantity);

        totalMinted = first + quantity;
        for (uint256 tokenId = first; tokenId < first + quantity; tokenId++) {
            euint64 seed = FHE.randEuint64();
            FHE.allowThis(seed);
            _seed[tokenId] = seed;
            _mint(msg.sender, tokenId);
            emit Minted(tokenId, msg.sender);
        }
    }

    // ----------------------------------------------------------------- shake

    /// @notice The holder learns ONE trait, picked at random by the contract. Unlimited.
    /// @dev Never touches the state roll: the five possible picks are the five trait bytes.
    /// @return pick encrypted bit offset of the picked trait inside the seed
    /// @return roll encrypted roll of that trait
    function shake(uint256 tokenId) external onlyHolder(tokenId) onlySealed(tokenId) returns (euint8 pick, euint8 roll) {
        (pick, roll) = _shakeFor(tokenId, msg.sender);
        emit Shaken(tokenId, msg.sender, false);
    }

    /// @notice Anyone but the holder pays to shake a box. Only the payer can read the result;
    ///         the holder is credited their share and learns nothing.
    function paidShake(
        uint256 tokenId
    ) external payable onlySealed(tokenId) costs(paidShakeFee) returns (euint8 pick, euint8 roll) {
        address holder = ownerOf(tokenId);
        if (holder == msg.sender) revert HolderShakesForFree();

        uint256 share = (msg.value * _holderBps) / 10_000;
        credits[holder] += share;
        totalCredits += share;

        (pick, roll) = _shakeFor(tokenId, msg.sender);
        emit Shaken(tokenId, msg.sender, true);
    }

    /// @notice Pays out what the caller earned from paid shakes of boxes they held.
    function claim() external {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToClaim();
        credits[msg.sender] = 0;
        totalCredits -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
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
    ///      nothing about the seed they were cut from.
    function _shakeFor(uint256 tokenId, address viewer) internal returns (euint8 pick, euint8 roll) {
        pick = _randomPick();
        roll = _rollAt(tokenId, pick);
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

    /// @notice Anyone can feed a sealed box. The cat gains a hidden amount of affection,
    ///         possibly none. Past the golden threshold, its accessory turns golden at reveal.
    /// @dev How many times a box was fed is public; how much that earned is not.
    function feed(uint256 tokenId) external payable onlySealed(tokenId) costs(feedFee) {
        _requireOwned(tokenId);
        euint32 affection = FHE.add(_affection[tokenId], FHE.asEuint32(FHE.randEuint8(_feedBound)));
        FHE.allowThis(affection);
        _affection[tokenId] = affection;
        feedCount[tokenId] += 1;
        emit Fed(tokenId, msg.sender);
    }

    // --------------------------------------------------------------- observe

    /// @notice Opens the box. Irreversible. Step 1 of 2: makes its seed and affection publicly
    ///         decryptable. An entangled partner is opened in the same transaction.
    function observe(uint256 tokenId) external payable onlyHolder(tokenId) onlySealed(tokenId) costs(observeFee) {
        _requestObserve(tokenId);
        uint256 partner = _partner[tokenId];
        if (partner != 0 && status[partner - 1] == BoxStatus.Sealed) _requestObserve(partner - 1);
    }

    function _requestObserve(uint256 tokenId) internal {
        status[tokenId] = BoxStatus.Observing;
        FHE.makePubliclyDecryptable(_seed[tokenId]);
        if (FHE.isInitialized(_affection[tokenId])) FHE.makePubliclyDecryptable(_affection[tokenId]);
        emit ObserveRequested(tokenId);
    }

    /// @notice Handles to pass, in this order, to the relayer's publicDecrypt before calling
    ///         `finalizeObserve`: the seed, then the affection if the box was ever fed.
    function observeHandles(uint256 tokenId) public view returns (bytes32[] memory handles) {
        bool fed = FHE.isInitialized(_affection[tokenId]);
        handles = new bytes32[](fed ? 2 : 1);
        handles[0] = FHE.toBytes32(_seed[tokenId]);
        if (fed) handles[1] = FHE.toBytes32(_affection[tokenId]);
    }

    /// @notice Step 2 of 2. Anyone may submit the decrypted values with their KMS proof.
    /// @param abiEncodedCleartexts `abiEncodedClearValues` returned by the relayer's publicDecrypt
    /// @param decryptionProof `decryptionProof` returned by the relayer's publicDecrypt
    /// @dev The handle list is rebuilt from storage, never taken from the caller, so a valid
    ///      proof for another box or another value cannot be replayed here.
    function finalizeObserve(
        uint256 tokenId,
        bytes calldata abiEncodedCleartexts,
        bytes calldata decryptionProof
    ) external {
        if (status[tokenId] != BoxStatus.Observing) revert NotObserving();

        bytes32[] memory handles = observeHandles(tokenId);
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);

        uint64 seed;
        uint32 affection;
        if (handles.length == 2) (seed, affection) = abi.decode(abiEncodedCleartexts, (uint64, uint32));
        else seed = abi.decode(abiEncodedCleartexts, (uint64));

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
        emit Observed(tokenId, seed, state, score, golden);
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

    /// @notice Step 1 of 2. Computes the single encrypted bit "is it alive" and makes that
    ///         bit, and nothing else, publicly decryptable. One request per box.
    /// @dev The answer becomes public whichever way it falls. A holder who suspects the
    ///      worst should not ask.
    function proveAlive(uint256 tokenId) external onlyHolder(tokenId) onlySealed(tokenId) {
        if (aliveCheck[tokenId] != AliveCheck.None) revert AliveCheckAlreadyRequested();

        aliveCheck[tokenId] = AliveCheck.Pending;
        // The state roll is the low 16 bits of the seed; "alive" is the lowest range.
        ebool alive = FHE.lt(FHE.asEuint16(_seed[tokenId]), _aliveBelow);
        FHE.allowThis(alive);
        FHE.makePubliclyDecryptable(alive);
        _aliveBit[tokenId] = alive;
        emit AliveCheckRequested(tokenId, FHE.toBytes32(alive));
    }

    /// @notice Step 2 of 2. Anyone may submit the decrypted bit with its KMS proof.
    function finalizeProveAlive(
        uint256 tokenId,
        bytes calldata abiEncodedAlive,
        bytes calldata decryptionProof
    ) external {
        if (aliveCheck[tokenId] != AliveCheck.Pending) revert AliveCheckNotPending();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(_aliveBit[tokenId]);
        FHE.checkSignatures(handles, abiEncodedAlive, decryptionProof);

        bool alive = abi.decode(abiEncodedAlive, (bool));
        aliveCheck[tokenId] = alive ? AliveCheck.Alive : AliveCheck.NotAlive;
        emit AliveProven(tokenId, alive);
    }

    /// @notice Handle of the "is alive" bit, once requested.
    function aliveHandle(uint256 tokenId) external view returns (bytes32) {
        return FHE.toBytes32(_aliveBit[tokenId]);
    }

    /// @notice The "Vet Certified" badge: the box was proven alive while still sealed.
    function vetCertified(uint256 tokenId) external view returns (bool) {
        return aliveCheck[tokenId] == AliveCheck.Alive;
    }

    // -------------------------------------------------------------- entangle

    /// @notice Step 1 of 2: the holder of A proposes to link A and B.
    function proposeEntangle(uint256 tokenIdA, uint256 tokenIdB) external onlyHolder(tokenIdA) {
        _checkEntangleable(tokenIdA, tokenIdB);
        _entangleProposal[tokenIdA][tokenIdB] = msg.sender;
        emit EntangleProposed(tokenIdA, tokenIdB);
    }

    /// @notice Step 2 of 2: the holder of B accepts. From then on, observing either box
    ///         observes both. Permanent, and it follows the boxes when they are transferred.
    function acceptEntangle(uint256 tokenIdA, uint256 tokenIdB) external onlyHolder(tokenIdB) {
        address proposer = _entangleProposal[tokenIdA][tokenIdB];
        // A proposal dies with the proposer's ownership of A.
        if (proposer == address(0) || proposer != ownerOf(tokenIdA)) revert NoSuchProposal();
        _checkEntangleable(tokenIdA, tokenIdB);

        delete _entangleProposal[tokenIdA][tokenIdB];
        _partner[tokenIdA] = tokenIdB + 1;
        _partner[tokenIdB] = tokenIdA + 1;
        emit Entangled(tokenIdA, tokenIdB);
    }

    function _checkEntangleable(uint256 tokenIdA, uint256 tokenIdB) internal view {
        if (tokenIdA == tokenIdB) revert SameBox();
        _requireOwned(tokenIdB);
        if (status[tokenIdA] != BoxStatus.Sealed || status[tokenIdB] != BoxStatus.Sealed) revert NotSealed();
        if (_partner[tokenIdA] != 0 || _partner[tokenIdB] != 0) revert AlreadyEntangled();
    }

    /// @notice Who proposed to entangle A with B, or zero. The proposal is only good while
    ///         that address still holds A.
    function entangleProposer(uint256 tokenIdA, uint256 tokenIdB) external view returns (address) {
        return _entangleProposal[tokenIdA][tokenIdB];
    }

    /// @notice The box `tokenId` is entangled with, if any.
    function partnerOf(uint256 tokenId) external view returns (bool entangled, uint256 partner) {
        uint256 p = _partner[tokenId];
        return p == 0 ? (false, 0) : (true, p - 1);
    }

    // ------------------------------------------------------------------ duel

    /// @notice Step 1 of 3: the holder of A challenges box B.
    function challengeDuel(uint256 tokenIdA, uint256 tokenIdB) external onlyHolder(tokenIdA) returns (uint256 duelId) {
        if (tokenIdA == tokenIdB) revert SameBox();
        _requireOwned(tokenIdB);
        if (status[tokenIdA] != BoxStatus.Sealed || status[tokenIdB] != BoxStatus.Sealed) revert NotSealed();

        // The challenger pays for their own box's score; the accepter pays for theirs.
        _ensureScore(tokenIdA);

        duelId = duelCount++;
        Duel storage d = _duels[duelId];
        d.tokenA = uint32(tokenIdA);
        d.tokenB = uint32(tokenIdB);
        d.challenger = msg.sender;
        d.status = DuelStatus.Challenged;
        emit DuelChallenged(duelId, tokenIdA, tokenIdB);
    }

    function cancelDuel(uint256 duelId) external {
        Duel storage d = _duels[duelId];
        if (d.status != DuelStatus.Challenged) revert WrongDuelStatus();
        if (d.challenger != msg.sender) revert NotHolder();
        d.status = DuelStatus.Cancelled;
        emit DuelCancelled(duelId);
    }

    /// @notice Step 2 of 3: the holder of B accepts. Computes, encrypted, who wins and which
    ///         trait the loser must show, then makes exactly those three values public.
    /// @dev The loser's roll is selected under encryption, so the winner's trait is never
    ///      decryptable by anyone.
    function acceptDuel(uint256 duelId) external {
        Duel storage d = _duels[duelId];
        if (d.status != DuelStatus.Challenged) revert WrongDuelStatus();
        uint256 a = d.tokenA;
        uint256 b = d.tokenB;
        if (ownerOf(b) != msg.sender) revert NotHolder();
        if (ownerOf(a) != d.challenger) revert ChallengerNoLongerHolds();
        if (status[a] != BoxStatus.Sealed || status[b] != BoxStatus.Sealed) revert NotSealed();

        ebool aWins = FHE.gt(_ensureScore(a), _ensureScore(b));
        euint8 pick = _randomPick();
        euint8 loserRoll = FHE.select(aWins, _rollAt(b, pick), _rollAt(a, pick));

        FHE.allowThis(aWins);
        FHE.allowThis(pick);
        FHE.allowThis(loserRoll);
        FHE.makePubliclyDecryptable(aWins);
        FHE.makePubliclyDecryptable(pick);
        FHE.makePubliclyDecryptable(loserRoll);

        d.aWins = aWins;
        d.pick = pick;
        d.loserRoll = loserRoll;
        d.status = DuelStatus.Pending;
        emit DuelAccepted(duelId);
    }

    /// @notice Handles to pass, in this order, to the relayer's publicDecrypt before calling
    ///         `finalizeDuel`.
    function duelHandles(uint256 duelId) public view returns (bytes32[] memory handles) {
        Duel storage d = _duels[duelId];
        handles = new bytes32[](3);
        handles[0] = FHE.toBytes32(d.aWins);
        handles[1] = FHE.toBytes32(d.pick);
        handles[2] = FHE.toBytes32(d.loserRoll);
    }

    /// @notice Step 3 of 3. Anyone may submit the decrypted outcome with its KMS proof.
    function finalizeDuel(uint256 duelId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof) external {
        Duel storage d = _duels[duelId];
        if (d.status != DuelStatus.Pending) revert WrongDuelStatus();

        FHE.checkSignatures(duelHandles(duelId), abiEncodedCleartexts, decryptionProof);
        (bool aWins, uint8 pick, uint8 roll) = abi.decode(abiEncodedCleartexts, (bool, uint8, uint8));

        (uint256 winner, uint256 loser) = aWins ? (uint256(d.tokenA), uint256(d.tokenB)) : (uint256(d.tokenB), uint256(d.tokenA));
        uint8 traitIndex = _traitIndexAt(pick);

        d.status = DuelStatus.Resolved;
        wins[winner] += 1;
        _publicTraitMask[loser] |= uint8(1 << traitIndex);
        _publicTraitRoll[loser][traitIndex] = roll;
        emit DuelResolved(duelId, winner, loser, traitIndex, roll);
    }

    function duelInfo(
        uint256 duelId
    ) external view returns (uint256 tokenIdA, uint256 tokenIdB, address challenger, DuelStatus duelStatus) {
        Duel storage d = _duels[duelId];
        return (d.tokenA, d.tokenB, d.challenger, d.status);
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

    // ----------------------------------------------------------------- admin

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
    }

    /// @notice Withdraws protocol revenue. Never touches what holders have yet to claim.
    function withdraw(address payable to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance - totalCredits}("");
        if (!ok) revert TransferFailed();
    }

    function maxSupply() external view returns (uint256) {
        return _maxSupply;
    }

    function maxPerTx() external view returns (uint256) {
        return _maxPerTx;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
