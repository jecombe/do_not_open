// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title The depot's rats
/// @notice Rats drawn in the studio, adopted as a plain ERC-721: nothing about a rat is secret,
///         unlike the boxes. A free rat is minted by its 64-bit seed, each seed once: its look is
///         recomputed from the seed by the game's generator. An AI rat is minted with its studio
///         job, each job once, on a signature of the app's backend (the attester), which has
///         stored its picture on Arweave and kept its 3D model first (`uri`). Paid in plain USDC, straight
///         to the treasury. Unrelated to the collection: it never reads or writes DoNotOpen.
contract Rats is ERC721, Ownable, EIP712 {
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

    event RatMinted(uint256 indexed tokenId, address indexed minter, Kind kind, bytes32 ref, string uri, uint256 paid);
    event PricesSet(uint256 seedPrice, uint256 modelPrice);
    event TreasurySet(address treasury);
    event AttesterSet(address attester);
    event BaseURISet(string baseURI);

    constructor(
        IERC20 usdc_,
        address treasury_,
        address owner_,
        address attester_,
        uint256 seedPrice_,
        uint256 modelPrice_,
        string memory baseURI_
    ) ERC721("DO NOT OPEN Rats", "DNORAT") Ownable(owner_) EIP712("DO NOT OPEN Rats", "1") {
        usdc = usdc_;
        _setTreasury(treasury_);
        _setAttester(attester_);
        _setPrices(seedPrice_, modelPrice_);
        _base = baseURI_;
    }

    /// @notice Adopts the free rat of `seed`, at most `maxPrice` USDC. The caller must have
    ///         approved this contract for the price.
    function mintSeed(uint64 seed, uint256 maxPrice) external returns (uint256 tokenId) {
        if (tokenOfSeed[seed] != 0) revert AlreadyAdopted();
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
        tokenId = ++totalSupply;
        tokenOfJob[job] = tokenId;
        _adopt(tokenId, Kind.Model, job, uri, modelPrice, maxPrice);
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

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _base = baseURI_;
        emit BaseURISet(baseURI_);
    }

    function _adopt(uint256 tokenId, Kind kind, bytes32 ref, string memory uri, uint256 price, uint256 maxPrice) private {
        if (price > maxPrice) revert PriceChanged();
        _rats[tokenId] = Rat(kind, uint64(block.timestamp), ref);
        usdc.safeTransferFrom(msg.sender, treasury, price);
        // _mint, not _safeMint: no call into the receiver, so nothing can re-enter.
        _mint(msg.sender, tokenId);
        emit RatMinted(tokenId, msg.sender, kind, ref, uri, price);
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
