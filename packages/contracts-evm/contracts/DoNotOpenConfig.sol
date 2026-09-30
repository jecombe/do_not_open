// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DoNotOpenConfig
/// @notice The numbers of the game, loaded once at deploy from `packages/game-spec/spec.json`,
///         and the plaintext rules that turn a revealed seed into a cat.
/// @dev Holds no FHE logic. Everything here is public by design: the secret is the seed,
///      never the rules. Immutable after construction.
contract DoNotOpenConfig {
    uint8 public constant TRAIT_COUNT = 5;
    uint8 public constant STATE_COUNT = 4;

    struct Params {
        /// keccak256 of the spec.json these values were read from.
        bytes32 specHash;
        uint16 maxSupply;
        uint8 maxPerTx;
        /// Exclusive upper bound of the 16-bit state roll for states 0, 1 and 2.
        /// State 3 owns everything above the last bound.
        uint16[3] stateRollBelow;
        uint16[4] stateScoreBonus;
        /// Bit offset of each trait byte inside the 64-bit seed.
        uint8[5] traitOffset;
        uint8[5] traitWeight;
        /// Per trait, one byte per variant: how many of the 256 rolls map to it.
        bytes[5] variantWidths;
        uint32 goldenThreshold;
        uint16 goldenScoreBonus;
        /// A feed adds a uniform encrypted amount in [0, feedBound). Must be a power of two.
        uint8 feedBound;
        /// Share of a paid shake that goes to the holder, in basis points.
        uint16 paidShakeHolderBps;
    }

    error InvalidStateThresholds();
    error InvalidTraitOffset(uint8 trait);
    error InvalidVariantWidths(uint8 trait);
    error UnknownTrait(uint8 trait);
    error InvalidFeedBound();
    error InvalidShare();

    bytes32 public immutable specHash;
    uint16 public immutable maxSupply;
    uint8 public immutable maxPerTx;
    uint32 public immutable goldenThreshold;
    uint16 public immutable goldenScoreBonus;
    uint8 public immutable feedBound;
    uint16 public immutable paidShakeHolderBps;

    uint16[3] private _stateRollBelow;
    uint16[4] private _stateScoreBonus;
    uint8[5] private _traitOffset;
    uint8[5] private _traitWeight;
    bytes[5] private _variantWidths;

    constructor(Params memory p) {
        if (p.stateRollBelow[0] == 0 || p.stateRollBelow[0] >= p.stateRollBelow[1] || p.stateRollBelow[1] >= p.stateRollBelow[2]) {
            revert InvalidStateThresholds();
        }
        for (uint8 i = 0; i < TRAIT_COUNT; i++) {
            // A trait byte must sit above the 16-bit state roll and inside the 64-bit seed.
            if (p.traitOffset[i] < 16 || p.traitOffset[i] > 56) revert InvalidTraitOffset(i);
            uint256 total;
            bytes memory widths = p.variantWidths[i];
            for (uint256 v = 0; v < widths.length; v++) total += uint8(widths[v]);
            if (total != 256) revert InvalidVariantWidths(i);
        }

        if (p.feedBound < 2 || (p.feedBound & (p.feedBound - 1)) != 0) revert InvalidFeedBound();
        if (p.paidShakeHolderBps > 10_000) revert InvalidShare();

        specHash = p.specHash;
        maxSupply = p.maxSupply;
        maxPerTx = p.maxPerTx;
        goldenThreshold = p.goldenThreshold;
        goldenScoreBonus = p.goldenScoreBonus;
        feedBound = p.feedBound;
        paidShakeHolderBps = p.paidShakeHolderBps;
        _stateRollBelow = p.stateRollBelow;
        _stateScoreBonus = p.stateScoreBonus;
        _traitOffset = p.traitOffset;
        _traitWeight = p.traitWeight;
        _variantWidths = p.variantWidths;
    }

    /// @notice State rolls below this value mean "alive".
    function aliveBelow() external view returns (uint16) {
        return _stateRollBelow[0];
    }

    function stateRollBelow() external view returns (uint16[3] memory) {
        return _stateRollBelow;
    }

    function stateScoreBonus() external view returns (uint16[4] memory) {
        return _stateScoreBonus;
    }

    function traitOffsets() external view returns (uint8[5] memory) {
        return _traitOffset;
    }

    function traitWeights() external view returns (uint8[5] memory) {
        return _traitWeight;
    }

    function variantWidths(uint8 trait) external view returns (bytes memory) {
        if (trait >= TRAIT_COUNT) revert UnknownTrait(trait);
        return _variantWidths[trait];
    }

    /// @notice Index of the variant a trait roll maps to.
    function variantOf(uint8 trait, uint8 roll) external view returns (uint8) {
        if (trait >= TRAIT_COUNT) revert UnknownTrait(trait);
        bytes storage widths = _variantWidths[trait];
        uint256 upper;
        for (uint256 v = 0; v < widths.length; v++) {
            upper += uint8(widths[v]);
            if (roll < upper) return uint8(v);
        }
        // Unreachable: widths are validated to sum to 256.
        revert InvalidVariantWidths(trait);
    }

    /// @notice Everything a revealed seed determines. Mirrors `decodeSeed`, `stateFromRoll`
    ///         and `rarityScore` in the TypeScript generator; a test keeps the two in step.
    /// @return state 0 alive, 1 asleep, 2 ghost, 3 quantum
    /// @return rolls the five trait bytes
    /// @return score weighted sum of the rolls plus the state bonus (no golden bonus)
    function decode(uint64 seed) public view returns (uint8 state, uint8[5] memory rolls, uint16 score) {
        uint16 stateRoll = uint16(seed);
        if (stateRoll >= _stateRollBelow[2]) state = 3;
        else if (stateRoll >= _stateRollBelow[1]) state = 2;
        else if (stateRoll >= _stateRollBelow[0]) state = 1;

        score = _stateScoreBonus[state];
        for (uint8 i = 0; i < TRAIT_COUNT; i++) {
            rolls[i] = uint8(seed >> _traitOffset[i]);
            score += uint16(_traitWeight[i]) * rolls[i];
        }
    }
}
