// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint16, euint64} from "@fhevm/solidity/lib/FHE.sol";
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
///  1. ONE ciphertext per box. State, traits and score are not stored encrypted: they are
///     derived from the seed when a function needs them. Mint costs a single FHE operation.
///
///  2. NOBODY but this contract is ever allowed on the seed. A holder allowed on it could
///     decrypt everything through the relayer and skip the game. `shake` hands out a fresh
///     ciphertext holding one trait; that is the only thing a holder can decrypt.
///
///  3. Because of (2) a transfer has no ACL to move and nothing to revoke. FHE.allow grants
///     are permanent on this protocol, so a design that granted the holder anything durable
///     could not take it back.
///
///  4. Public decryption has no on-chain callback. A request marks a ciphertext publicly
///     decryptable; anyone then fetches the cleartext and KMS proof off-chain and submits
///     them to the matching `finalize*` function, which verifies the proof.
///
///  HCU per function (FHE cost, protocol limit 20,000,000 per transaction), measured in tests:
///    mint           24,000 per box   one randEuint64
///    shake         ~672,000          randEuint16, 4 scalar ge, 4 select, 1 encrypted shr
///    proveAlive     ~58,000          one scalar lt on 16 bits
///    observe             0           ACL change only
///    finalize*           0           signature check only
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

    struct Revealed {
        uint64 seed;
        uint8 state;
        uint8[5] traits;
        uint16 score;
        bool golden;
    }

    /// @dev What one viewer got from their latest shake of one box.
    struct Shake {
        /// Bit offset of the picked trait inside the seed (see the seed layout in game-spec).
        euint8 pick;
        /// The picked trait's roll.
        euint8 roll;
    }

    error InvalidQuantity();
    error SoldOut();
    error WrongPayment(uint256 expected);
    error NotHolder();
    error NotSealed();
    error NotObserving();
    error AliveCheckAlreadyRequested();
    error AliveCheckNotPending();
    error WithdrawFailed();

    event Minted(uint256 indexed tokenId, address indexed owner);
    /// @dev Which trait was picked is deliberately absent: only the viewer can decrypt it.
    event Shaken(uint256 indexed tokenId, address indexed viewer, bool paid);
    event ObserveRequested(uint256 indexed tokenId, bytes32 seedHandle);
    event Observed(uint256 indexed tokenId, uint64 seed, uint8 state, uint16 rarityScore, bool golden);
    event AliveCheckRequested(uint256 indexed tokenId, bytes32 aliveHandle);
    event AliveProven(uint256 indexed tokenId, bool alive);

    DoNotOpenConfig public immutable config;
    uint256 public immutable mintPrice;
    uint256 public immutable observeFee;

    uint16 private immutable _maxSupply;
    uint8 private immutable _maxPerTx;
    uint16 private immutable _aliveBelow;
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
    string private _baseTokenURI;

    mapping(uint256 tokenId => euint64) private _seed;
    mapping(uint256 tokenId => BoxStatus) public status;
    mapping(uint256 tokenId => Revealed) private _revealed;
    mapping(uint256 tokenId => AliveCheck) public aliveCheck;
    mapping(uint256 tokenId => ebool) private _aliveBit;
    mapping(uint256 tokenId => mapping(address viewer => Shake)) private _shakes;

    constructor(
        DoNotOpenConfig config_,
        uint256 mintPrice_,
        uint256 observeFee_,
        address owner_
    ) ERC721("DO NOT OPEN", "DNO") Ownable(owner_) {
        config = config_;
        mintPrice = mintPrice_;
        observeFee = observeFee_;
        _maxSupply = config_.maxSupply();
        _maxPerTx = config_.maxPerTx();
        _aliveBelow = config_.aliveBelow();
        uint8[5] memory offsets = config_.traitOffsets();
        _offset0 = offsets[0];
        _offset1 = offsets[1];
        _offset2 = offsets[2];
        _offset3 = offsets[3];
        _offset4 = offsets[4];
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
    function shake(uint256 tokenId) external returns (euint8 pick, euint8 roll) {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (status[tokenId] != BoxStatus.Sealed) revert NotSealed();
        (pick, roll) = _shakeFor(tokenId, msg.sender);
        emit Shaken(tokenId, msg.sender, false);
    }

    /// @dev The pick is itself encrypted, so it cannot be predicted or ground by resubmitting.
    ///      Both results are fresh ciphertexts; granting the viewer access to them says
    ///      nothing about the seed they were cut from.
    function _shakeFor(uint256 tokenId, address viewer) internal returns (euint8 pick, euint8 roll) {
        euint16 draw = FHE.randEuint16();
        pick = FHE.asEuint8(_offset0);
        pick = FHE.select(FHE.ge(draw, PICK_1), FHE.asEuint8(_offset1), pick);
        pick = FHE.select(FHE.ge(draw, PICK_2), FHE.asEuint8(_offset2), pick);
        pick = FHE.select(FHE.ge(draw, PICK_3), FHE.asEuint8(_offset3), pick);
        pick = FHE.select(FHE.ge(draw, PICK_4), FHE.asEuint8(_offset4), pick);
        // Shift the picked byte down to bits 0..7; the downcast keeps only those.
        roll = FHE.asEuint8(FHE.shr(_seed[tokenId], pick));

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

    // --------------------------------------------------------------- observe

    /// @notice Opens the box. Irreversible. Step 1 of 2: makes the seed publicly decryptable.
    function observe(uint256 tokenId) external payable {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (status[tokenId] != BoxStatus.Sealed) revert NotSealed();
        if (msg.value != observeFee) revert WrongPayment(observeFee);

        status[tokenId] = BoxStatus.Observing;
        FHE.makePubliclyDecryptable(_seed[tokenId]);
        emit ObserveRequested(tokenId, FHE.toBytes32(_seed[tokenId]));
    }

    /// @notice Step 2 of 2. Anyone may submit the decrypted seed with its KMS proof.
    /// @param abiEncodedSeed `abiEncodedClearValues` returned by the relayer's publicDecrypt
    /// @param decryptionProof `decryptionProof` returned by the relayer's publicDecrypt
    /// @dev The handle list is rebuilt from storage, never taken from the caller, so a valid
    ///      proof for another box or another value cannot be replayed here.
    function finalizeObserve(uint256 tokenId, bytes calldata abiEncodedSeed, bytes calldata decryptionProof) external {
        if (status[tokenId] != BoxStatus.Observing) revert NotObserving();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(_seed[tokenId]);
        FHE.checkSignatures(handles, abiEncodedSeed, decryptionProof);

        uint64 seed = abi.decode(abiEncodedSeed, (uint64));
        (uint8 state, uint8[5] memory traits, uint16 score) = config.decode(seed);

        status[tokenId] = BoxStatus.Revealed;
        _revealed[tokenId] = Revealed({seed: seed, state: state, traits: traits, score: score, golden: false});
        emit Observed(tokenId, seed, state, score, false);
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
    function proveAlive(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (status[tokenId] != BoxStatus.Sealed) revert NotSealed();
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
    function finalizeProveAlive(uint256 tokenId, bytes calldata abiEncodedAlive, bytes calldata decryptionProof) external {
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

    // ----------------------------------------------------------------- admin

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
    }

    function withdraw(address payable to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
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
