// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @dev The slice of DoNotOpen the gifts use: a free box out of the ones the sale leaves, for
///      the gifts' contract only.
interface IGiftBoxes {
    function gift(address to) external returns (uint256 tokenId);
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
/// @dev Unrelated to the game's rules: DoNotOpen and Rats only see their giver.
///
///  1. Croquettes: one encrypted 16-bit draw, folded into [croqMin, croqMax]. The modulo bias is
///     below span / 65,536, a fraction of a percent for the spec's ranges. The amount moves from
///     this contract's cCROQ (funded from the treasury) and is readable by the wallet and by this
///     contract only. If the contract runs short, the wallet gets 0, silently, like any cCROQ
///     transfer.
///  2. Box: minted free for the wallet by `DoNotOpen.gift`, out of the boxes the sale leaves
///     (maxSupply minus the last milestone), so a sold-out sale never empties a gift and nobody
///     advances its price. Not a sale: it counts in no milestone. LEAK: the tier is public, so
///     whoever reads the claim knows that box went to that wallet.
///  3. Rat: a free seed rat, outside the paid rats' cap; the app draws an unadopted seed at
///     random. Rats are public anyway.
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

    constructor(IGiftBoxes boxes_, IGiftRats rats_, IERC7984 cCroq_, Tier[] memory tiers_, address owner_) Ownable(owner_) {
        if (address(boxes_) == address(0) || address(rats_) == address(0) || address(cCroq_) == address(0)) revert ZeroAddress();
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

    /// @notice Collects the caller's gift. `ratSeed` is the free rat to adopt, ignored by tiers
    ///         without a rat.
    function claim(uint8 tier, bytes32[] calldata proof, uint64 ratSeed) external {
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
            g.hasBox = true;
            g.box = boxes.gift(msg.sender);
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

    /// @notice Once claims are over, sends the cCROQ left here to `to`. The boxes and rats nobody
    ///         collected were never minted.
    function sweep(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (root == bytes32(0) || block.timestamp < closesAt) revert StillOpen();
        euint64 left = cCroq.confidentialBalanceOf(address(this));
        if (FHE.isInitialized(left)) {
            FHE.allowTransient(left, address(cCroq));
            cCroq.confidentialTransfer(to, left);
        }
        emit Swept(to);
    }
}
