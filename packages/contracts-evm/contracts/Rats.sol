// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {FHE, euint8, euint16} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title The depot's rats
/// @notice Rats drawn in the studio, adopted as a plain ERC-721: nothing about a rat is secret,
///         unlike the boxes. A free rat is minted by its 64-bit seed, each seed once: its look is
///         recomputed from the seed by the game's generator. An AI rat is minted with its studio
///         job, each job once, on a signature of the app's backend (the attester), which has
///         stored its picture on Arweave and kept its 3D model first (`uri`). Paid in plain USDC, straight
///         to the treasury. Unrelated to the collection: it never reads or writes DoNotOpen.
///         The supply is capped for good, per kind, and each address mints at most `maxPerWallet`
///         rats: every rat earns croquettes from the RatPantry, which holds a fixed fund. The
///         whitelist's gifts (`giver`) adopt free seed rats for their wallets, outside the paid
///         rats' cap and the wallet limit, at most `maxGiftRats` of them.
///
///         The one secret: each rat's power, 1, 2 or 3, drawn encrypted at its mint with the
///         spec's odds. Its holder reads it (`allowPower` after a sale; the seller keeps reading
///         it, an access is never taken back). The rats' tricks (`RatTricks`) use it, encrypted:
///         1 sniffs boxes cheaper, 2 shields or jams one trait of a box, 3 all of them.
contract Rats is ERC721, Ownable, EIP712, ZamaEthereumConfig {
    using SafeERC20 for IERC20;

    enum Kind {
        Seed,
        Model
    }

    struct Rat {
        Kind kind;
        uint64 mintedAt;
        /// @dev The seed for a seed rat, the job id for an AI rat.
        bytes32 ref;
    }

    /// @notice A price above 100 USDC is refused, whatever the owner asks.
    uint256 public constant MAX_PRICE = 100_000_000;

    bytes32 private constant ADOPT_TYPEHASH = keccak256("Adopt(address minter,bytes32 job,string uri,uint256 deadline)");

    IERC20 public immutable usdc;
    address public treasury;
    /// @notice Signs AI rat adoptions once their files are on Arweave.
    address public attester;
    uint256 public seedPrice;
    uint256 public modelPrice;
    uint256 public totalSupply;
    /// @notice The most seed rats and AI rats there will ever be, set at deployment.
    uint256 public immutable maxSeedRats;
    uint256 public immutable maxModelRats;
    /// @notice The most rats one address may mint, both kinds together. Buying one is not limited.
    uint256 public immutable maxPerWallet;
    /// @notice The most free rats the giver may ever hand out.
    uint256 public immutable maxGiftRats;
    uint256 public seedMinted;
    uint256 public modelMinted;
    uint256 public giftMinted;
    /// @notice The whitelist's gifts contract, the only one that adopts rats for free. Zero: none.
    address public giver;
    mapping(address account => uint256) public mintedBy;
    /// @notice The rats' tricks, the only contract that computes with the powers. Zero: none.
    address public tricks;
    /// @dev A 16-bit draw below the first bound is power 1, below the second power 2, else 3.
    uint16 private immutable _power1Below;
    uint16 private immutable _power2Below;
    mapping(uint256 tokenId => euint8) private _power;

    mapping(uint256 tokenId => Rat) private _rats;
    /// @notice The rat minted from a seed or a job, or 0. Token ids start at 1.
    mapping(uint64 seed => uint256) public tokenOfSeed;
    mapping(bytes32 job => uint256) public tokenOfJob;

    string private _base;

    error AlreadyAdopted();
    error PriceChanged();
    error PriceTooHigh();
    error ZeroPrice();
    error ZeroAddress();
    error Expired();
    error BadSignature();
    error SoldOut();
    error WalletLimit();
    error ZeroCap();
    error NotGiver();
    error NotTricks();
    error NotYourRat();
    error BadOdds();

    event RatMinted(uint256 indexed tokenId, address indexed minter, Kind kind, bytes32 ref, string uri, uint256 paid);
    event PricesSet(uint256 seedPrice, uint256 modelPrice);
    event TreasurySet(address treasury);
    event AttesterSet(address attester);
    event BaseURISet(string baseURI);
    event GiverSet(address giver);
    event TricksSet(address tricks);

    constructor(
        IERC20 usdc_,
        address treasury_,
        address owner_,
        address attester_,
        uint256 seedPrice_,
        uint256 modelPrice_,
        string memory baseURI_,
        uint256[4] memory caps_,
        uint16[2] memory powerBelow_
    ) ERC721("DO NOT OPEN Rats", "DNORAT") Ownable(owner_) EIP712("DO NOT OPEN Rats", "1") {
        usdc = usdc_;
        _setTreasury(treasury_);
        _setAttester(attester_);
        _setPrices(seedPrice_, modelPrice_);
        _base = baseURI_;
        // maxSeedRats, maxModelRats, maxPerWallet, maxGiftRats.
        if (caps_[0] == 0 || caps_[1] == 0 || caps_[2] == 0) revert ZeroCap();
        maxSeedRats = caps_[0];
        maxModelRats = caps_[1];
        maxPerWallet = caps_[2];
        maxGiftRats = caps_[3];
        if (powerBelow_[0] == 0 || powerBelow_[1] < powerBelow_[0]) revert BadOdds();
        _power1Below = powerBelow_[0];
        _power2Below = powerBelow_[1];
    }

    /// @notice Adopts the free rat of `seed`, at most `maxPrice` USDC. The caller must have
    ///         approved this contract for the price.
    function mintSeed(uint64 seed, uint256 maxPrice) external returns (uint256 tokenId) {
        if (tokenOfSeed[seed] != 0) revert AlreadyAdopted();
        if (++seedMinted > maxSeedRats) revert SoldOut();
        tokenId = ++totalSupply;
        tokenOfSeed[seed] = tokenId;
        _adopt(tokenId, Kind.Seed, bytes32(uint256(seed)), "", seedPrice, maxPrice);
    }

    /// @notice Adopts the AI rat of studio job `job`, whose files the attester put at `uri`.
    ///         The attester's signature names the caller, so nobody else can mint it.
    function mintModel(bytes32 job, string calldata uri, uint256 deadline, bytes calldata signature, uint256 maxPrice) external returns (uint256 tokenId) {
        if (block.timestamp > deadline) revert Expired();
        if (tokenOfJob[job] != 0) revert AlreadyAdopted();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ADOPT_TYPEHASH, msg.sender, job, keccak256(bytes(uri)), deadline)));
        if (ECDSA.recover(digest, signature) != attester) revert BadSignature();
        if (++modelMinted > maxModelRats) revert SoldOut();
        tokenId = ++totalSupply;
        tokenOfJob[job] = tokenId;
        _adopt(tokenId, Kind.Model, job, uri, modelPrice, maxPrice);
    }

    /// @notice The giver adopts the free rat of `seed` for `to`, without payment, once per seed.
    function gift(address to, uint64 seed) external returns (uint256 tokenId) {
        if (msg.sender != giver || giver == address(0)) revert NotGiver();
        if (to == address(0)) revert ZeroAddress();
        if (tokenOfSeed[seed] != 0) revert AlreadyAdopted();
        if (++giftMinted > maxGiftRats) revert SoldOut();
        tokenId = ++totalSupply;
        tokenOfSeed[seed] = tokenId;
        _rats[tokenId] = Rat(Kind.Seed, uint64(block.timestamp), bytes32(uint256(seed)));
        _drawPower(tokenId, to);
        _mint(to, tokenId);
        emit RatMinted(tokenId, to, Kind.Seed, bytes32(uint256(seed)), "", 0);
    }

    /// @notice Handle of the rat's encrypted power. Its holder decrypts it once allowed.
    function powerOf(uint256 tokenId) external view returns (bytes32) {
        _requireOwned(tokenId);
        return FHE.toBytes32(_power[tokenId]);
    }

    /// @notice Lets the rat's holder read its power, after buying it.
    function allowPower(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotYourRat();
        FHE.allow(_power[tokenId], msg.sender);
    }

    /// @notice Whether `account` may decrypt the rat's power: its minter, and whoever called
    ///         `allowPower` while holding it.
    function powerReadableBy(uint256 tokenId, address account) external view returns (bool) {
        return FHE.isAllowed(_power[tokenId], account);
    }

    /// @notice The power, for the tricks' computation in this transaction only.
    function powerFor(uint256 tokenId) external returns (euint8 power) {
        if (msg.sender != tricks || tricks == address(0)) revert NotTricks();
        _requireOwned(tokenId);
        power = _power[tokenId];
        FHE.allowTransient(power, msg.sender);
    }

    function ratOf(uint256 tokenId) external view returns (Rat memory) {
        _requireOwned(tokenId);
        return _rats[tokenId];
    }

    /// @notice When the rat was minted: its croquettes count from there.
    function mintedAt(uint256 tokenId) external view returns (uint64) {
        _requireOwned(tokenId);
        return _rats[tokenId].mintedAt;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_base, Strings.toString(tokenId));
    }

    function setPrices(uint256 seedPrice_, uint256 modelPrice_) external onlyOwner {
        _setPrices(seedPrice_, modelPrice_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function setAttester(address attester_) external onlyOwner {
        _setAttester(attester_);
    }

    function setGiver(address giver_) external onlyOwner {
        giver = giver_;
        emit GiverSet(giver_);
    }

    function setTricks(address tricks_) external onlyOwner {
        tricks = tricks_;
        emit TricksSet(tricks_);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _base = baseURI_;
        emit BaseURISet(baseURI_);
    }

    function _adopt(uint256 tokenId, Kind kind, bytes32 ref, string memory uri, uint256 price, uint256 maxPrice) private {
        if (price > maxPrice) revert PriceChanged();
        if (++mintedBy[msg.sender] > maxPerWallet) revert WalletLimit();
        _rats[tokenId] = Rat(kind, uint64(block.timestamp), ref);
        _drawPower(tokenId, msg.sender);
        usdc.safeTransferFrom(msg.sender, treasury, price);
        // _mint, not _safeMint: no call into the receiver, so nothing can re-enter.
        _mint(msg.sender, tokenId);
        emit RatMinted(tokenId, msg.sender, kind, ref, uri, price);
    }

    /// @dev One encrypted 16-bit draw folded into 1, 2 or 3 with the spec's odds. Nobody can
    ///      predict or grind it: it is drawn under encryption, after the payment is decided.
    function _drawPower(uint256 tokenId, address holder) private {
        euint16 draw = FHE.randEuint16();
        euint8 power = FHE.select(FHE.lt(draw, _power1Below), FHE.asEuint8(1), FHE.select(FHE.lt(draw, _power2Below), FHE.asEuint8(2), FHE.asEuint8(3)));
        FHE.allowThis(power);
        FHE.allow(power, holder);
        _power[tokenId] = power;
    }

    function _setPrices(uint256 seedPrice_, uint256 modelPrice_) private {
        if (seedPrice_ > MAX_PRICE || modelPrice_ > MAX_PRICE) revert PriceTooHigh();
        // A free rat could be minted by the thousand to farm the croquettes.
        if (seedPrice_ == 0 || modelPrice_ == 0) revert ZeroPrice();
        seedPrice = seedPrice_;
        modelPrice = modelPrice_;
        emit PricesSet(seedPrice_, modelPrice_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _setAttester(address attester_) private {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        emit AttesterSet(attester_);
    }
}
