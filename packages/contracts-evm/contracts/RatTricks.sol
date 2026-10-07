// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint64, externalEuint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IShakeGuard} from "./IShakeGuard.sol";

/// @dev The slice of DoNotOpen the tricks use.
interface ITrickBoxes {
    function isOwner(uint256 tokenId, address account) external returns (ebool);
    function paidShake(uint256 tokenId) external returns (euint8 pick, euint8 roll);
    function paidShakeFee() external view returns (uint64);
    function status(uint256 tokenId) external view returns (uint8);
}

/// @dev The slice of Rats the tricks use.
interface ITrickRats {
    function ownerOf(uint256 tokenId) external view returns (address);
    function powerFor(uint256 tokenId) external returns (euint8);
}

/// @dev The trait offsets inside a box's seed.
interface ITrickConfig {
    function traitOffsets() external view returns (uint8[5] memory);
}

/// @title The rats' tricks
/// @notice What a rat does with its encrypted power (1, 2 or 3), which nobody but its holder knows.
///
///         Sniff: the rat shakes a box for its holder, a paid shake. Every rat sniffs at the full
///         price; a power-1 rat gets `sniffRebate` back from the treasury, under encryption, so
///         nobody sees which rats sniff cheaper.
///
///         Trick: the rat is set on a box for `trickDuration`, then rests `recharge`. The contract
///         decides under encryption what it did. On a box its holder holds, it SHIELDS: strangers'
///         paid shakes (and rats' sniffs) of the blocked traits read a fake roll, the same one every
///         time. On someone else's box, it JAMS: the holder's own shakes of the blocked traits read
///         SCRAMBLED. Power 2 blocks the one trait its holder picked (encrypted), power 3 all five,
///         power 1 nothing: a bluff. A box fully shielded resists jams until its shield ends.
///
///         Every rat has the same button, the same duration and the same rest, so the chain only
///         shows "rat r was set on box b": not whether it shielded or jammed, nor its power, nor
///         the trait.
/// @dev DoNotOpen passes every shake through `filter` (it is DoNotOpen's guard), and lets this
///      contract ask `isOwner` (trusted reader). Rats lets it read powers (`setTricks`).
///
///  HCU, measured in tests (protocol limit 20,000,000 per transaction): see the README table.
contract RatTricks is IShakeGuard, ZamaEthereumConfig, Ownable {
    /// @notice A jammed shake's pick: no trait sits at this offset, so the app can tell.
    uint8 public constant SCRAMBLED = 254;

    struct Effect {
        /// 0xFF over each blocked trait's byte of the seed.
        euint64 mask;
        /// When it ends, encrypted: writing it in the clear would show which slot a trick filled.
        euint64 until;
        /// Shields only: the fake rolls, one byte per trait, drawn when the shield starts.
        euint64 noise;
    }

    struct Sniff {
        euint8 pick;
        euint8 roll;
    }

    ITrickBoxes public immutable boxes;
    ITrickRats public immutable rats;
    IERC7984 public immutable cUsdc;
    uint64 public immutable sniffFee;
    uint64 public immutable sniffRebate;
    uint64 public immutable trickDuration;
    uint64 public immutable recharge;
    /// @dev 0xFF over all five traits' bytes.
    uint64 private immutable _allTraits;
    uint8 private immutable _offset0;
    uint8 private immutable _offset1;
    uint8 private immutable _offset2;
    uint8 private immutable _offset3;
    uint8 private immutable _offset4;

    /// @notice Pays power-1 rebates from its cUSDC, once it made this contract its operator.
    address public rebater;

    /// @notice When the rat can play a trick again.
    mapping(uint256 ratId => uint64) public readyAt;
    mapping(uint256 tokenId => Effect) private _shield;
    mapping(uint256 tokenId => Effect) private _jam;
    mapping(uint256 tokenId => mapping(address sniffer => Sniff)) private _sniffs;

    error NotYourRat();
    error Recharging(uint64 readyAt);
    error NotSealed();
    error OnlyBoxes();
    error ZeroAddress();
    error BadParams();

    /// @notice The rat sniffed the box for its holder. What it read is theirs only.
    event Sniffed(uint256 indexed ratId, uint256 indexed tokenId, address indexed sniffer);
    /// @notice The rat was set on the box until `until`, and rests until `readyAt`. Shield, jam
    ///         or bluff: encrypted.
    event TrickPlayed(uint256 indexed ratId, uint256 indexed tokenId, address indexed player, uint64 until, uint64 readyAt);
    event RebaterSet(address rebater);

    constructor(
        ITrickBoxes boxes_,
        ITrickRats rats_,
        IERC7984 cUsdc_,
        ITrickConfig config_,
        uint64 sniffRebate_,
        uint64 trickDuration_,
        uint64 recharge_,
        address rebater_,
        address owner_
    ) Ownable(owner_) {
        if (address(boxes_) == address(0) || address(rats_) == address(0) || address(cUsdc_) == address(0)) revert ZeroAddress();
        boxes = boxes_;
        rats = rats_;
        cUsdc = cUsdc_;
        sniffFee = boxes_.paidShakeFee();
        if (sniffRebate_ > sniffFee || trickDuration_ == 0) revert BadParams();
        sniffRebate = sniffRebate_;
        trickDuration = trickDuration_;
        recharge = recharge_;
        uint8[5] memory offsets = config_.traitOffsets();
        _offset0 = offsets[0];
        _offset1 = offsets[1];
        _offset2 = offsets[2];
        _offset3 = offsets[3];
        _offset4 = offsets[4];
        uint64 all;
        for (uint256 i = 0; i < 5; i++) all |= uint64(0xFF) << offsets[i];
        _allTraits = all;
        rebater = rebater_;
        // DoNotOpen pulls each sniff's fee from here.
        cUsdc_.setOperator(address(boxes_), type(uint48).max);
    }

    // ----------------------------------------------------------------- sniff

    /// @notice The rat sniffs `tokenId` for its holder: a paid shake, at `sniffFee` cUSDC, whose
    ///         pick and roll only the caller can read (`lastSniff`). A power-1 rat gets
    ///         `sniffRebate` back. The caller must have made this contract an operator on cUSDC.
    function sniff(uint256 ratId, uint256 tokenId) external returns (euint8 pick, euint8 roll) {
        if (rats.ownerOf(ratId) != msg.sender) revert NotYourRat();
        euint64 fee = FHE.asEuint64(sniffFee);
        FHE.allowTransient(fee, address(cUsdc));
        euint64 paid = cUsdc.confidentialTransferFrom(msg.sender, address(this), fee);
        // Nothing else rests here, so DoNotOpen's pull only succeeds when the caller paid.
        (pick, roll) = boxes.paidShake(tokenId);
        FHE.allow(pick, msg.sender);
        FHE.allow(roll, msg.sender);
        _sniffs[tokenId][msg.sender] = Sniff(pick, roll);

        address from = rebater;
        if (sniffRebate != 0 && from != address(0) && cUsdc.isOperator(from, address(this))) {
            ebool cheap = FHE.and(FHE.eq(paid, fee), FHE.eq(rats.powerFor(ratId), 1));
            euint64 rebate = FHE.select(cheap, FHE.asEuint64(sniffRebate), FHE.asEuint64(0));
            FHE.allowTransient(rebate, address(cUsdc));
            cUsdc.confidentialTransferFrom(from, msg.sender, rebate);
        }
        emit Sniffed(ratId, tokenId, msg.sender);
    }

    /// @notice Handles of `sniffer`'s latest sniff of `tokenId`. Zero if none.
    function lastSniff(uint256 tokenId, address sniffer) external view returns (bytes32 pick, bytes32 roll) {
        Sniff storage s = _sniffs[tokenId][sniffer];
        return (FHE.toBytes32(s.pick), FHE.toBytes32(s.roll));
    }

    // ----------------------------------------------------------------- trick

    /// @notice Sets the rat on a sealed box for `trickDuration`. `trait` (0 to 4, encrypted for
    ///         this contract and the caller) is the one a power-2 rat blocks; ignored otherwise.
    function trick(uint256 ratId, uint256 tokenId, externalEuint8 trait, bytes calldata inputProof) external {
        if (rats.ownerOf(ratId) != msg.sender) revert NotYourRat();
        uint64 ready = readyAt[ratId];
        if (block.timestamp < ready) revert Recharging(ready);
        if (boxes.status(tokenId) != 0) revert NotSealed();
        uint64 until = uint64(block.timestamp) + trickDuration;
        ready = until + recharge;
        readyAt[ratId] = ready;

        euint8 power = rats.powerFor(ratId);
        euint64 effect = FHE.select(
            FHE.eq(power, 3),
            FHE.asEuint64(_allTraits),
            FHE.select(FHE.eq(power, 2), _traitMask(FHE.fromExternal(trait, inputProof)), FHE.asEuint64(0))
        );
        ebool holds = boxes.isOwner(tokenId, msg.sender);
        euint64 none = FHE.asEuint64(0);

        Effect storage shield = _shield[tokenId];
        // A box fully shielded resists jams.
        ebool fortified = FHE.and(_active(shield), FHE.eq(_orZero(shield.mask), _allTraits));
        _apply(shield, FHE.select(holds, effect, none), until, true);
        _apply(_jam[tokenId], FHE.select(FHE.or(holds, fortified), none, effect), until, false);
        emit TrickPlayed(ratId, tokenId, msg.sender, until, ready);
    }

    /// @dev 0xFF over trait `index`'s byte; above 4 counts as 4.
    function _traitMask(euint8 index) private returns (euint64) {
        euint8 offset = FHE.asEuint8(_offset4);
        offset = FHE.select(FHE.eq(index, 3), FHE.asEuint8(_offset3), offset);
        offset = FHE.select(FHE.eq(index, 2), FHE.asEuint8(_offset2), offset);
        offset = FHE.select(FHE.eq(index, 1), FHE.asEuint8(_offset1), offset);
        offset = FHE.select(FHE.eq(index, 0), FHE.asEuint8(_offset0), offset);
        return FHE.shl(FHE.asEuint64(0xFF), offset);
    }

    /// @dev Adds `effect` to the slot: an empty effect leaves it as it was; otherwise the blocked
    ///      traits join those still active and the end moves to `until`. A shield that starts
    ///      afresh draws new fake rolls.
    function _apply(Effect storage e, euint64 effect, uint64 until, bool shield) private {
        ebool empty = FHE.eq(effect, 0);
        ebool active = _active(e);
        euint64 mask = _orZero(e.mask);
        euint64 merged = FHE.or(FHE.select(active, mask, FHE.asEuint64(0)), effect);
        e.mask = FHE.select(empty, mask, merged);
        e.until = FHE.select(empty, _orZero(e.until), FHE.asEuint64(until));
        FHE.allowThis(e.mask);
        FHE.allowThis(e.until);
        if (shield) {
            euint64 noise = FHE.isInitialized(e.noise) ? e.noise : FHE.randEuint64();
            e.noise = FHE.select(FHE.or(empty, active), noise, FHE.randEuint64());
            FHE.allowThis(e.noise);
        }
    }

    function _active(Effect storage e) private returns (ebool) {
        return FHE.gt(_orZero(e.until), uint64(block.timestamp));
    }

    function _orZero(euint64 v) private returns (euint64) {
        return FHE.isInitialized(v) ? v : FHE.asEuint64(0);
    }

    // ---------------------------------------------------------------- filter

    /// @inheritdoc IShakeGuard
    /// @dev DoNotOpen only: anyone else could pass handles of their own and learn a box's mask.
    function filter(uint256 tokenId, bool paid, euint8 pick, euint8 roll) external returns (euint8, euint8) {
        if (msg.sender != address(boxes)) revert OnlyBoxes();
        Effect storage e = paid ? _shield[tokenId] : _jam[tokenId];
        if (FHE.isInitialized(e.mask)) {
            ebool hit = FHE.and(_active(e), FHE.ne(FHE.asEuint8(FHE.shr(e.mask, pick)), 0));
            if (paid) {
                roll = FHE.select(hit, FHE.asEuint8(FHE.shr(e.noise, pick)), roll);
            } else {
                pick = FHE.select(hit, FHE.asEuint8(SCRAMBLED), pick);
                roll = FHE.select(hit, FHE.asEuint8(0), roll);
            }
        }
        FHE.allowTransient(pick, msg.sender);
        FHE.allowTransient(roll, msg.sender);
        return (pick, roll);
    }

    // ----------------------------------------------------------------- admin

    function setRebater(address rebater_) external onlyOwner {
        rebater = rebater_;
        emit RebaterSet(rebater_);
    }
}
