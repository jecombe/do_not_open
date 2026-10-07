// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint16, euint64, externalEuint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @dev The slice of DoNotOpen the gifts use: they buy a box like anyone, then hand it over.
interface IGiftBoxes {
    function mint(externalEuint8 encryptedQuantity, bytes calldata inputProof, uint8 ids) external returns (uint256 firstTokenId);
    function confidentialTransfer(address to, uint256 tokenId) external returns (ebool moved);
}

/// @dev The slice of Rats the gifts use: a free seed rat, for the gifts' contract only.
interface IGiftRats {
    function gift(address to, uint64 seed) external returns (uint256 tokenId);
}

/// @title The whitelist's gifts
/// @notice Every wallet seated on the mainnet whitelist collects one gift, once, set by its rank:
///         an encrypted number of croquettes drawn at random in its tier's range, which only the
///         wallet can read, plus a free box, a free rat, or both. The list is frozen into a
///         Merkle root of (wallet, tier) when it closes; the API serves each wallet its proof.
/// @dev Unrelated to the game's rules: DoNotOpen and Rats see an ordinary buyer and their giver.
///
///  1. Croquettes: one encrypted 16-bit draw, folded into [croqMin, croqMax]. The modulo bias is
///     below span / 65,536, a fraction of a percent for the spec's ranges. The amount moves from
///     this contract's cCROQ (funded from the treasury) and is readable by the wallet and by this
///     contract only. If the contract runs short, the wallet gets 0, silently, like any cCROQ
///     transfer.
///  2. Box: bought from DoNotOpen at its price with this contract's cUSDC (the money comes back
///     to the collection as revenue), one id, then sent on to the wallet. The wallet encrypts the
///     quantity (1) for DoNotOpen and this contract, as `mint` asks of any buyer. LEAK: the
///     tier is public, so whoever reads the claim knows that box went to that wallet.
///  3. Rat: the free rat of a seed the wallet picks in the studio, outside the paid rats' cap.
///     Rats are public anyway.
///
///  HCU per claim (protocol limit 20,000,000 per transaction), measured in tests:
///    first class   ~3,410,000   the draw, the fold, one cCROQ transfer, one box mint and transfer
///    economy       ~1,320,000   the draw, the fold, one cCROQ transfer
contract WhitelistGifts is ZamaEthereumConfig, Ownable {
    struct Tier {
        uint64 croqMin;
        uint64 croqMax;
        bool box;
        bool rat;
    }

    struct Gift {
        bool claimed;
        uint8 tier;
        bool hasBox;
        bool hasRat;
        uint256 box;
        uint256 rat;
        euint64 croq;
    }

    IGiftBoxes public immutable boxes;
    IGiftRats public immutable rats;
    IERC7984 public immutable cCroq;
    IERC7984 public immutable cUsdc;

    /// @notice (wallet, tier) leaves, OpenZeppelin's standard tree. Zero until the list closes.
    bytes32 public root;
    /// @notice After this, nothing more is claimed and the owner takes back what is left.
    uint64 public closesAt;
    Tier[] private _tiers;
    mapping(address account => Gift) private _gifts;
    uint256 public claimedCount;

    error RootAlreadySet();
    error NotOpen();
    error StillOpen();
    error AlreadyClaimed();
    error NotOnTheList();
    error BadTier();
    error ZeroAddress();

    event RootSet(bytes32 root, uint64 closesAt);
    event GiftClaimed(address indexed account, uint8 tier, bool hasBox, uint256 box, bool hasRat, uint256 rat);
    event Swept(address to);

    constructor(IGiftBoxes boxes_, IGiftRats rats_, IERC7984 cCroq_, IERC7984 cUsdc_, Tier[] memory tiers_, address owner_) Ownable(owner_) {
        if (address(boxes_) == address(0) || address(rats_) == address(0) || address(cCroq_) == address(0) || address(cUsdc_) == address(0)) revert ZeroAddress();
        if (tiers_.length == 0 || tiers_.length > type(uint8).max) revert BadTier();
        for (uint256 i = 0; i < tiers_.length; i++) {
            Tier memory t = tiers_[i];
            // The draw is 16 bits wide: the span must fit in it.
            if (t.croqMax < t.croqMin || t.croqMax - t.croqMin >= type(uint16).max) revert BadTier();
            _tiers.push(t);
        }
        boxes = boxes_;
        rats = rats_;
        cCroq = cCroq_;
        cUsdc = cUsdc_;
        // DoNotOpen pulls each box's price from here.
        cUsdc_.setOperator(address(boxes_), type(uint48).max);
    }

    /// @notice Freezes the list: the root of its (wallet, tier) tree and when claims end. It can be
    ///         corrected until the first claim, never after.
    function setRoot(bytes32 root_, uint64 closesAt_) external onlyOwner {
        if (claimedCount != 0) revert RootAlreadySet();
        if (root_ == bytes32(0) || closesAt_ <= block.timestamp) revert NotOpen();
        root = root_;
        closesAt = closesAt_;
        emit RootSet(root_, closesAt_);
    }

    /// @notice Collects the caller's gift. `quantity` (1) and `inputProof` are encrypted for
    ///         DoNotOpen and this contract, and ignored by tiers without a box; `ratSeed` is the
    ///         free rat to adopt, ignored by tiers without a rat.
    function claim(uint8 tier, bytes32[] calldata proof, externalEuint8 quantity, bytes calldata inputProof, uint64 ratSeed) external {
        if (root == bytes32(0) || block.timestamp >= closesAt) revert NotOpen();
        Gift storage g = _gifts[msg.sender];
        if (g.claimed) revert AlreadyClaimed();
        if (tier >= _tiers.length) revert BadTier();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, tier))));
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) revert NotOnTheList();
        Tier memory t = _tiers[tier];
        g.claimed = true;
        g.tier = tier;
        claimedCount++;

        euint64 amount = FHE.asEuint64(FHE.rem(FHE.randEuint16(), uint16(t.croqMax - t.croqMin + 1)));
        amount = FHE.add(amount, t.croqMin);
        FHE.allowTransient(amount, address(cCroq));
        // Allowed to this contract and the wallet by the token.
        g.croq = cCroq.confidentialTransfer(msg.sender, amount);

        if (t.box) {
            uint256 id = boxes.mint(quantity, inputProof, 1);
            boxes.confidentialTransfer(msg.sender, id);
            g.hasBox = true;
            g.box = id;
        }
        if (t.rat) {
            g.hasRat = true;
            g.rat = rats.gift(msg.sender, ratSeed);
        }
        emit GiftClaimed(msg.sender, tier, g.hasBox, g.box, g.hasRat, g.rat);
    }

    /// @notice What `account` collected. `croq` is a handle only the account (and this contract)
    ///         may decrypt; zero before the claim.
    function giftOf(address account) external view returns (bool claimed, uint8 tier, bool hasBox, uint256 box, bool hasRat, uint256 rat, bytes32 croq) {
        Gift storage g = _gifts[account];
        return (g.claimed, g.tier, g.hasBox, g.box, g.hasRat, g.rat, FHE.toBytes32(g.croq));
    }

    function tiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    /// @notice Once claims are over, sends the cCROQ and cUSDC left here to `to`.
    function sweep(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (root == bytes32(0) || block.timestamp < closesAt) revert StillOpen();
        _sendAll(cCroq, to);
        _sendAll(cUsdc, to);
        emit Swept(to);
    }

    function _sendAll(IERC7984 token, address to) private {
        euint64 left = token.confidentialBalanceOf(address(this));
        if (!FHE.isInitialized(left)) return;
        FHE.allowTransient(left, address(token));
        token.confidentialTransfer(to, left);
    }
}
